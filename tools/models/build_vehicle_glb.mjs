#!/usr/bin/env node
// Builds a vehicle's glTF 2.0 binary (.glb) procedurally from its JSON definition, so
// the model's engine pivot, thrusters, panels and docking port sit exactly where the
// physics puts them.
//
//   node tools/models/build_vehicle_glb.mjs data/vehicles/rs1_corvid.json web/public/models/rs1_corvid.glb
//
// Coordinates are the vehicle body frame in metres (+X forward along the stack, see
// crates/sim-core/src/vehicle.rs), not glTF's +Y-up convention: the game applies the
// body → ICRF attitude directly. Node naming contract with web/src/render/spacecraft.ts:
//   stage_<id>            one node per stage (hidden on separation)
//   engine_<id>           origin at the gimbal pivot, +X = nominal thrust direction
//   part_<id>             every other part
// (Underscores: three's GLTFLoader strips ":" and "." from node names.)
// Materials are metallic-roughness PBR. No external textures.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const [, , inPath, outPath] = process.argv;
if (!inPath || !outPath) {
  console.error("usage: build_vehicle_glb.mjs <vehicle.json> <out.glb>");
  process.exit(2);
}
const cfg = JSON.parse(readFileSync(inPath, "utf8"));

// ---------------------------------------------------------------- vector helpers
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => Math.hypot(a[0], a[1], a[2]);
const unit = (a) => scale(a, 1 / norm(a));

/** Quaternion [x, y, z, w] rotating +X onto unit vector d. */
function quatFromX(d) {
  const x = [1, 0, 0];
  const c = dot(x, d);
  if (c < -0.999999) return [0, 0, 1, 0]; // 180° about Z
  const ax = cross(x, d);
  const w = 1 + c;
  const n = Math.hypot(ax[0], ax[1], ax[2], w);
  return [ax[0] / n, ax[1] / n, ax[2] / n, w / n];
}

// ---------------------------------------------------------------- geometry
class Geo {
  constructor() {
    this.pos = [];
    this.nrm = [];
    this.idx = [];
  }
  vert(p, n) {
    this.pos.push(...p);
    this.nrm.push(...n);
    return this.pos.length / 3 - 1;
  }
  quad(a, b, c, d) {
    this.idx.push(a, b, c, a, c, d);
  }
}

/** Surface of revolution about +X. `profile` is [[x, r], …]; normals from the
 *  profile's local slope (smooth). Angles a0..a1 (rad) allow partial sectors.
 *  `flip` turns normals inward (inside of a nozzle). */
function lathe(g, profile, seg, a0 = 0, a1 = 2 * Math.PI, flip = false) {
  // A profile running toward −X winds the other way round: flip it so the surface
  // still faces outward (`flip` alone means "the inside of the surface").
  if (profile[profile.length - 1][0] < profile[0][0]) flip = !flip;
  const rings = [];
  for (let i = 0; i < profile.length; i++) {
    const [x, r] = profile[i];
    const p0 = profile[Math.max(0, i - 1)];
    const p1 = profile[Math.min(profile.length - 1, i + 1)];
    // Tangent (dx, dr) → outward normal (−dr, dx) in the (x, r) plane.
    let tx = p1[0] - p0[0], tr = p1[1] - p0[1];
    const tl = Math.hypot(tx, tr) || 1;
    tx /= tl;
    tr /= tl;
    let nx = -tr, nr = tx;
    if (flip) (nx = -nx), (nr = -nr);
    const ring = [];
    for (let k = 0; k <= seg; k++) {
      const a = a0 + ((a1 - a0) * k) / seg;
      const c = Math.cos(a), s = Math.sin(a);
      ring.push(g.vert([x, r * c, r * s], [nx, nr * c, nr * s]));
    }
    rings.push(ring);
  }
  for (let i = 0; i + 1 < rings.length; i++) {
    for (let k = 0; k < seg; k++) {
      const [a, b, c, d] = [rings[i][k], rings[i][k + 1], rings[i + 1][k + 1], rings[i + 1][k]];
      if (flip) g.quad(a, d, c, b);
      else g.quad(a, b, c, d);
    }
  }
}

/** Flat disk at x facing ±X. */
function disk(g, x, r, facing, seg, rInner = 0) {
  const n = [facing, 0, 0];
  const outer = [], inner = [];
  for (let k = 0; k <= seg; k++) {
    const a = (2 * Math.PI * k) / seg;
    outer.push(g.vert([x, r * Math.cos(a), r * Math.sin(a)], n));
    inner.push(g.vert([x, rInner * Math.cos(a), rInner * Math.sin(a)], n));
  }
  // (b − a) × (c − a) must point along `facing` (counter-clockwise from outside).
  for (let k = 0; k < seg; k++) {
    if (facing > 0) g.quad(inner[k], outer[k], outer[k + 1], inner[k + 1]);
    else g.quad(inner[k], inner[k + 1], outer[k + 1], outer[k]);
  }
}

/** Axis-aligned box. */
function box(g, c, s) {
  const h = scale(s, 0.5);
  const faces = [
    [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
    [[-1, 0, 0], [0, 0, 1], [0, 1, 0]],
    [[0, 1, 0], [0, 0, 1], [1, 0, 0]],
    [[0, -1, 0], [1, 0, 0], [0, 0, 1]],
    [[0, 0, 1], [1, 0, 0], [0, 1, 0]],
    [[0, 0, -1], [0, 1, 0], [1, 0, 0]],
  ];
  for (const [n, u, v] of faces) {
    const center = add(c, [n[0] * h[0], n[1] * h[1], n[2] * h[2]]);
    const du = [u[0] * h[0], u[1] * h[1], u[2] * h[2]];
    const dv = [v[0] * h[0], v[1] * h[1], v[2] * h[2]];
    const a = g.vert(sub(sub(center, du), dv), n);
    const b = g.vert(sub(add(center, du), dv), n);
    const cc = g.vert(add(add(center, du), dv), n);
    const d = g.vert(add(sub(center, du), dv), n);
    g.quad(a, b, cc, d);
  }
}

// ---------------------------------------------------------------- materials
const MATERIALS = {
  hull: { c: [0.78, 0.79, 0.8], m: 0.05, r: 0.55 },
  radiator: { c: [0.82, 0.83, 0.84], m: 0.0, r: 0.35 },
  mli: { c: [0.78, 0.76, 0.71], m: 0.9, r: 0.38 },
  ablator: { c: [0.26, 0.19, 0.13], m: 0.0, r: 0.92 },
  dark: { c: [0.11, 0.11, 0.12], m: 0.75, r: 0.42 },
  nozzle: { c: [0.42, 0.40, 0.39], m: 1.0, r: 0.5 },
  gold: { c: [0.86, 0.64, 0.27], m: 1.0, r: 0.32 },
  cells: { c: [0.035, 0.06, 0.16], m: 0.35, r: 0.22 },
  frame: { c: [0.55, 0.56, 0.58], m: 0.9, r: 0.35 },
  window: { c: [0.015, 0.018, 0.025], m: 0.3, r: 0.06 },
};
const materialNames = Object.keys(MATERIALS);

// ---------------------------------------------------------------- scene build
const meshes = []; // {name, primitives: [{geo, material}]}
const nodes = []; // glTF nodes
const SEG = 64;

function addMesh(name, prims) {
  meshes.push({ name, primitives: prims });
  return meshes.length - 1;
}
function addNode(n) {
  nodes.push(n);
  return nodes.length - 1;
}
const prim = (material, build) => {
  const g = new Geo();
  build(g);
  return { geo: g, material };
};

const stageNodes = new Map();
for (const s of cfg.stages) stageNodes.set(s.id, addNode({ name: `stage_${s.id}`, children: [] }));
const child = (stage, nodeIdx) => nodes[stageNodes.get(stage)].children.push(nodeIdx);

for (const p of cfg.parts) {
  const sh = p.shape;
  const pos = p.position;
  const name = `part_${p.id}`;
  switch (p.kind) {
    case "heat_shield": {
      const r = sh.cylinder.radius, l = sh.cylinder.length, x0 = pos[0] - l / 2;
      // Shallow spherical aft dome (Apollo-like), then the shoulder.
      const prof = [];
      for (let i = 0; i <= 12; i++) {
        const rr = (r * i) / 12;
        prof.push([x0 - 0.12 * (1 - (rr / r) ** 2), rr]);
      }
      prof.push([x0 + l, r]);
      child(p.stage, addNode({ name, mesh: addMesh(name, [prim("ablator", (g) => lathe(g, prof, SEG))]) }));
      break;
    }
    case "capsule": {
      const r = sh.cone.base_radius, hgt = sh.cone.height, x0 = pos[0];
      const xTop = x0 + hgt * 0.85; // truncated for the tunnel
      const rTop = r * (1 - 0.85);
      const g1 = prim("hull", (g) => {
        lathe(g, [[x0, r], [x0 + 0.06, r - 0.015], [xTop, rTop]], SEG);
        disk(g, xTop, rTop, 1, SEG);
      });
      // Windows: four dark panes on the cone around x = 40% height.
      const winX = x0 + hgt * 0.42;
      const winR = r * (1 - 0.42) + 0.012;
      const gw = prim("window", (g) => {
        for (const a of [0.55, 2.59, 3.69, 5.73]) {
          const half = 0.13;
          const pts = [];
          for (const [dx, da] of [[-half, -0.07], [-half, 0.07], [half, 0.07], [half, -0.07]]) {
            const rr = winR - (dx * r) / hgt;
            pts.push([winX + dx, rr * Math.cos(a + da), rr * Math.sin(a + da)]);
          }
          const n = unit(cross(sub(pts[1], pts[0]), sub(pts[3], pts[0])));
          const outward = [0, Math.cos(a), Math.sin(a)];
          const nn = dot(n, outward) < 0 ? scale(n, -1) : n;
          const ids = pts.map((q) => g.vert(q, nn));
          if (dot(n, outward) < 0) g.quad(ids[0], ids[1], ids[2], ids[3]);
          else g.quad(ids[0], ids[3], ids[2], ids[1]);
        }
      });
      child(p.stage, addNode({ name, mesh: addMesh(name, [g1, gw]) }));
      break;
    }
    case "docking_port": {
      const r = sh.cylinder.radius, l = sh.cylinder.length, x0 = pos[0] - l / 2;
      const g1 = prim("dark", (g) => {
        lathe(g, [[x0 - 0.3, r], [x0 + l, r]], SEG);
        disk(g, x0 + l, r + 0.1, 1, SEG, r - 0.12);
      });
      const g2 = prim("frame", (g) => lathe(g, [[x0 + l - 0.06, r + 0.1], [x0 + l, r + 0.1]], SEG));
      child(p.stage, addNode({ name, mesh: addMesh(name, [g1, g2]) }));
      break;
    }
    case "service_module": {
      const r = sh.cylinder_shell.radius, l = sh.cylinder_shell.length;
      const x0 = pos[0] - l / 2, x1 = pos[0] + l / 2;
      // Eight 45° sectors: radiator panels alternate with MLI-covered bays.
      const sectors = [];
      for (let k = 0; k < 8; k++) {
        const a0 = (k * Math.PI) / 4, a1 = ((k + 1) * Math.PI) / 4;
        sectors.push(prim(k % 2 === 0 ? "radiator" : "mli", (g) => lathe(g, [[x0, r], [x1 - 0.25, r]], 12, a0, a1)));
      }
      sectors.push(prim("hull", (g) => lathe(g, [[x1 - 0.25, r], [x1, r]], SEG)));
      sectors.push(prim("gold", (g) => disk(g, x0, r, -1, SEG, 0.45)));
      sectors.push(prim("hull", (g) => disk(g, x1, r, 1, SEG, 0)));
      child(p.stage, addNode({ name, mesh: addMesh(name, sectors) }));
      break;
    }
    case "solar_array": {
      const s = sh.box.size;
      const side = Math.sign(pos[1]) || 1;
      const inner = Math.abs(pos[1]) - s[1] / 2;
      const prims = [
        // Boom from the SM skin to the panel.
        prim("frame", (g) => box(g, [pos[0], side * (1.95 + inner) / 2, pos[2]], [0.08, inner - 1.95 + 0.1, 0.08])),
        // Four sub-panels with frame gaps.
        prim("cells", (g) => {
          for (let i = 0; i < 4; i++) {
            const w = s[1] / 4;
            const yc = side * (inner + w * (i + 0.5));
            box(g, [pos[0], yc, pos[2]], [s[0] - 0.08, w - 0.06, s[2]]);
          }
        }),
        prim("frame", (g) => box(g, [pos[0], side * (inner + s[1] / 2), pos[2] - s[2]], [0.05, s[1], 0.02])),
      ];
      child(p.stage, addNode({ name, mesh: addMesh(name, prims) }));
      break;
    }
    case "engine":
      break; // built from the engine definition below
    default: {
      // Unknown kinds: a neutral primitive of the right size.
      const prims = [];
      if (sh.cylinder) prims.push(prim("hull", (g) => lathe(g, [[pos[0] - sh.cylinder.length / 2, sh.cylinder.radius], [pos[0] + sh.cylinder.length / 2, sh.cylinder.radius]], 32)));
      else if (sh.box) prims.push(prim("hull", (g) => box(g, pos, sh.box.size)));
      if (prims.length) child(p.stage, addNode({ name, mesh: addMesh(name, prims) }));
    }
  }
}

// Engines: chamber + bell, modelled in engine coordinates (+X thrust), node at the pivot.
for (const e of cfg.engines) {
  const part = cfg.parts.find((p) => p.kind === "engine" && p.stage === e.stage);
  const exitR = part ? part.shape.cone_shell.base_radius : Math.sqrt(e.exit_area / Math.PI);
  const len = part ? Math.abs(part.position[0] - e.position[0]) : 2;
  const throatX = -0.5, throatR = 0.2 * exitR / 0.7;
  const bell = [];
  for (let i = 0; i <= 24; i++) {
    const t = i / 24;
    // Parabolic (Rao-style) contour from the throat to the exit.
    bell.push([throatX - (len + throatX) * t, throatR + (exitR - throatR) * Math.sqrt(t)]);
  }
  const outer = prim("nozzle", (g) => {
    lathe(g, [[0.05, 0.42], [-0.35, 0.36], [throatX, throatR + 0.05]], SEG);
    lathe(g, bell, SEG);
  });
  const innerSurf = prim("dark", (g) => lathe(g, bell, SEG, 0, 2 * Math.PI, true));
  const n = addNode({
    name: `engine_${e.id}`,
    translation: e.position,
    rotation: quatFromX(unit(e.direction)),
    mesh: addMesh(`engine_${e.id}`, [outer, innerSurf]),
  });
  child(e.stage, n);
}

// RCS: a housing per distinct thruster position (service module quads), and a small
// nozzle per thruster pointing along its exhaust (−direction).
for (const grp of cfg.rcs) {
  const byPos = new Map();
  grp.thrusters.forEach((t) => {
    const k = t.position.map((v) => v.toFixed(3)).join(",");
    if (!byPos.has(k)) byPos.set(k, []);
    byPos.get(k).push(t);
  });
  const prims = [];
  const nozzles = new Geo();
  const housings = new Geo();
  for (const [, ts] of byPos) {
    const p = ts[0].position;
    if (ts.length >= 3) {
      // Quad housing, pushed slightly inward so it sits on the skin.
      const radial = unit([0, p[1], p[2]]);
      box(housings, sub(p, scale(radial, 0.08)), [0.42, 0.3 + 0.1 * Math.abs(radial[2]), 0.3 + 0.1 * Math.abs(radial[1])]);
    }
    for (const t of ts) {
      const ex = scale(unit(t.direction), -1); // exhaust direction
      const base = add(p, scale(ex, ts.length >= 3 ? 0.18 : 0.0));
      const q = new Geo();
      lathe(q, [[0, 0.025], [0.09, 0.05]], 12);
      // Rotate the little nozzle (+X along the exhaust) into place.
      const m = rotationMatrixFromX(ex);
      for (let i = 0; i < q.pos.length / 3; i++) {
        const v = [q.pos[3 * i], q.pos[3 * i + 1], q.pos[3 * i + 2]];
        const nv = [q.nrm[3 * i], q.nrm[3 * i + 1], q.nrm[3 * i + 2]];
        nozzles.vert(add(base, mulM(m, v)), mulM(m, nv));
      }
      const off = nozzles.pos.length / 3 - q.pos.length / 3;
      for (const i of q.idx) nozzles.idx.push(i + off);
    }
  }
  if (housings.idx.length) prims.push({ geo: housings, material: "hull" });
  prims.push({ geo: nozzles, material: "dark" });
  child(grp.stage, addNode({ name: `part_rcs_${grp.id}`, mesh: addMesh(`rcs_${grp.id}`, prims) }));
}

function rotationMatrixFromX(d) {
  const x = unit(d);
  const ref = Math.abs(x[2]) < 0.9 ? [0, 0, 1] : [0, 1, 0];
  const y = unit(cross(ref, x));
  const z = cross(x, y);
  return [x, y, z]; // columns
}
function mulM(cols, v) {
  return add(add(scale(cols[0], v[0]), scale(cols[1], v[1])), scale(cols[2], v[2]));
}

const rootNode = addNode({ name: cfg.name, children: [...stageNodes.values()] });

// ---------------------------------------------------------------- GLB writer
const chunks = [];
let byteLength = 0;
const bufferViews = [];
const accessors = [];
function pushData(typed, target) {
  const pad = (4 - (byteLength % 4)) % 4;
  if (pad) chunks.push(new Uint8Array(pad)), (byteLength += pad);
  const bytes = new Uint8Array(typed.buffer, typed.byteOffset, typed.byteLength);
  chunks.push(bytes);
  bufferViews.push({ buffer: 0, byteOffset: byteLength, byteLength: bytes.byteLength, target });
  byteLength += bytes.byteLength;
  return bufferViews.length - 1;
}
function accessor(arr, type, comp, target, minmax) {
  const typed = comp === 5126 ? new Float32Array(arr) : new Uint32Array(arr);
  const bv = pushData(typed, target);
  const n = type === "VEC3" ? arr.length / 3 : arr.length;
  const a = { bufferView: bv, componentType: comp, count: n, type };
  if (minmax) {
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < arr.length; i += 3) for (let k = 0; k < 3; k++) (min[k] = Math.min(min[k], arr[i + k])), (max[k] = Math.max(max[k], arr[i + k]));
    a.min = min;
    a.max = max;
  }
  accessors.push(a);
  return accessors.length - 1;
}

const gltfMeshes = meshes.map((m) => ({
  name: m.name,
  primitives: m.primitives
    .filter((p) => p.geo.idx.length > 0)
    .map((p) => ({
      attributes: {
        POSITION: accessor(p.geo.pos, "VEC3", 5126, 34962, true),
        NORMAL: accessor(p.geo.nrm, "VEC3", 5126, 34962, false),
      },
      indices: accessor(p.geo.idx, "SCALAR", 5125, 34963, false),
      material: materialNames.indexOf(p.material),
    })),
}));

const gltf = {
  asset: { version: "2.0", generator: "rocketsim tools/models/build_vehicle_glb.mjs" },
  extras: { source: inPath, frame: "vehicle body frame, metres, +X forward" },
  scene: 0,
  scenes: [{ nodes: [rootNode] }],
  nodes,
  meshes: gltfMeshes,
  materials: materialNames.map((n) => {
    const m = MATERIALS[n];
    return {
      name: n,
      pbrMetallicRoughness: { baseColorFactor: [...m.c, 1], metallicFactor: m.m, roughnessFactor: m.r },
      doubleSided: n === "dark" || n === "cells" || n === "nozzle",
    };
  }),
  accessors,
  bufferViews,
  buffers: [{ byteLength }],
};

const json = new TextEncoder().encode(JSON.stringify(gltf));
const jsonPad = (4 - (json.length % 4)) % 4;
const binPad = (4 - (byteLength % 4)) % 4;
const total = 12 + 8 + json.length + jsonPad + 8 + byteLength + binPad;
const out = new Uint8Array(total);
const dv = new DataView(out.buffer);
dv.setUint32(0, 0x46546c67, true); // "glTF"
dv.setUint32(4, 2, true);
dv.setUint32(8, total, true);
dv.setUint32(12, json.length + jsonPad, true);
dv.setUint32(16, 0x4e4f534a, true); // JSON
out.set(json, 20);
out.fill(0x20, 20 + json.length, 20 + json.length + jsonPad);
let o = 20 + json.length + jsonPad;
dv.setUint32(o, byteLength + binPad, true);
dv.setUint32(o + 4, 0x004e4942, true); // BIN
o += 8;
for (const c of chunks) out.set(c, o), (o += c.byteLength);
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, out);
console.log(`wrote ${outPath}: ${(total / 1024).toFixed(0)} KiB, ${gltfMeshes.length} meshes, ${nodes.length} nodes`);
