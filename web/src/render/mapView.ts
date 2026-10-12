// Map view (brief §4): the same floating-origin scene seen from far away, with
// - body orbits (osculating conics), SOI spheres (camera-facing rings);
// - the spacecraft's coast prediction and the planned trajectory with maneuver nodes,
//   both from the real n-body propagator, coloured per SOI patch;
// - markers: apoapsis/periapsis with altitude and time-to, SOI changes, impact,
//   closest approach and ascending/descending nodes relative to the target;
// - maneuver-node editing: click the trajectory to add a node, drag the
//   prograde/normal/radial handles, or edit numbers in the node panel; execute with
//   the burn autopilot and read the planned-vs-actual report.
//
// All positions are f64 relative to the spacecraft's centre body, converted to f32
// only after subtracting the camera position (as everywhere else).

import * as THREE from "three";
import { Line2 } from "three/examples/jsm/lines/Line2.js";
import { LineGeometry } from "three/examples/jsm/lines/LineGeometry.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import type { BodyRow } from "../core";
import type { Simulation } from "../sim/simulation";
import { clear, fmtDuration, fmtLength, h } from "../ui/dom";
import type { Engine } from "./engine";
import { FOCUS_SPACECRAFT, type World } from "./world";

type V = [number, number, number];

export interface PlanNode {
  t: number;
  dt: number;
  prograde: number;
  normal: number;
  radial: number;
  dv: number;
  start: number | null;
  duration: number | null;
  massAfter: number | null;
  center: number | null;
  direction: V | null;
  pos: V | null;
  vel: V | null;
}

export interface PlanJson {
  nodes: PlanNode[];
  totalDv: number;
  dvAfter: number;
  propellantAfter: number;
  insufficient: boolean;
}

interface MarkerJson {
  kind: "pe" | "ap" | "soi" | "impact" | "ca" | "an" | "dn";
  t: number;
  dt: number;
  center: number;
  pos: V;
  value: number;
  extra: { from: number; to: number } | null;
}

export interface AutopilotJson {
  phase: "aligning" | "burning" | "done";
  toStart: number;
  dv: number;
  delivered: number;
  duration: number;
  report?: {
    dvPlanned: number;
    dvDelivered: number;
    pointingDeg: number;
    posErr: number;
    velErr: number;
    compare: { label: string; planned: number; actual: number; dtPlanned: number; dtActual: number }[];
  };
}

// Values stay well below 1: the scene is tone-mapped (AgX), which desaturates bright colours.
const COAST_COLOR = new THREE.Color(0.04, 0.22, 0.6);
const COAST_OTHER = new THREE.Color(0.32, 0.12, 0.6);
const PLAN_COLOR = new THREE.Color(0.7, 0.22, 0.02);
const PLAN_OTHER = new THREE.Color(0.6, 0.5, 0.04);
const ORBIT_COLOR = new THREE.Color(0.12, 0.14, 0.2);
const SOI_COLOR = new THREE.Color(0.08, 0.22, 0.1);
/** Markers and the plan are re-read at this period (s); paths every frame. */
const SLOW_REFRESH = 0.25;
/** Handle drag: Δv rate (m/s per s) at 20 px of drag, growing with the square. */
const HANDLE_RATE = 2;
/** Moons whose orbits are drawn only when their planet is the focus or centre. */
const PLANET_OF: Record<number, number> = { 401: 499, 402: 499, 501: 599, 502: 599, 503: 599, 504: 599, 601: 699, 602: 699, 603: 699, 604: 699, 605: 699, 606: 699, 608: 699, 801: 899 };

const AXES = [
  { key: "prograde", sign: 1, label: "Prograde", cls: "h-pro" },
  { key: "prograde", sign: -1, label: "Retrograde", cls: "h-retro" },
  { key: "normal", sign: 1, label: "Normal", cls: "h-nrm" },
  { key: "normal", sign: -1, label: "Anti-normal", cls: "h-anrm" },
  { key: "radial", sign: 1, label: "Radial out", cls: "h-rad" },
  { key: "radial", sign: -1, label: "Radial in", cls: "h-arad" },
] as const;

function makeLine(engine: Engine, width: number, dashed = false): Line2 {
  const m = new LineMaterial({ color: 0xffffff, linewidth: width, vertexColors: true, dashed, transparent: true, depthWrite: false });
  m.resolution.set(engine.pixelSize.x, engine.pixelSize.y);
  const l = new Line2(new LineGeometry(), m);
  l.frustumCulled = false;
  l.renderOrder = 5;
  l.visible = false;
  return l;
}

function setLine(line: Line2, pts: Float32Array, colors: Float32Array): void {
  if (pts.length < 6) {
    line.visible = false;
    return;
  }
  const g = new LineGeometry();
  g.setPositions(pts);
  g.setColors(colors);
  line.geometry.dispose();
  line.geometry = g;
  line.computeLineDistances();
  line.visible = true;
}

export class MapView {
  active = false;
  readonly overlay = h("div", { class: "map-overlay hidden" });
  readonly panel = h("div", { class: "map-panel hidden" });
  readonly track = h("div", { class: "ground-track hidden" });
  private trackCanvas = h("canvas", { width: 512, height: 256 });
  private trackImage = new Image();
  private coast: Line2;
  private plan: Line2;
  private bodyLines = new Map<number, Line2>();
  private soiLines: Line2[] = [];
  private labels = new Map<number, HTMLElement>();
  private scIcon = h("div", { class: "map-sc", title: "Spacecraft" }, h("span", {}));
  private markerLayer = h("div", { class: "map-markers" });
  private nodeLayer = h("div", { class: "map-nodes" });
  /** Screen samples of the drawn paths for click-to-add: [x, y, tFromNow]. */
  private pick: [number, number, number][] = [];
  private slowT = 1e9;
  private planJson: PlanJson | null = null;
  private markers: { coast: MarkerJson[]; plan: MarkerJson[] } = { coast: [], plan: [] };
  private orbitCache = new Map<number, { t: number; pts: number[] }>();
  selected = -1;
  /** Handle being dragged: axis, sign, start and current pointer, screen direction. */
  private drag: { key: "prograde" | "normal" | "radial"; sign: number; x0: number; y0: number; x: number; y: number; dir: [number, number] } | null = null;
  private dragPending = { prograde: 0, normal: 0, radial: 0, since: 0 };
  private down: { x: number; y: number; t: number } | null = null;
  showTrack = false;

  constructor(
    private engine: Engine,
    private world: World,
    private sim: Simulation,
    private bodies: BodyRow[],
  ) {
    this.coast = makeLine(engine, 2);
    this.plan = makeLine(engine, 2.5);
    engine.scene.add(this.coast, this.plan);
    for (const b of bodies) {
      if (b.parent === null || b.parent === undefined) continue;
      const l = makeLine(engine, 1.2);
      this.bodyLines.set(b.id, l);
      engine.scene.add(l);
      const lab = h("div", { class: "map-label", onclick: () => this.focusBody(b.id) }, h("span", { class: "dot" }), b.name);
      this.labels.set(b.id, lab);
      this.overlay.append(lab);
    }
    for (let i = 0; i < 2; i++) {
      const l = makeLine(engine, 1);
      this.soiLines.push(l);
      engine.scene.add(l);
    }
    this.overlay.append(this.markerLayer, this.nodeLayer, this.scIcon);
    this.track.append(h("div", { class: "panel-title" }, "GROUND TRACK"), this.trackCanvas);
    this.trackImage.src = "assets/earth_day_2048.jpg";

    const canvas = engine.renderer.domElement;
    canvas.addEventListener("pointerdown", (e) => {
      if (this.active) this.down = { x: e.clientX, y: e.clientY, t: performance.now() };
    });
    canvas.addEventListener("pointerup", (e) => {
      const d = this.down;
      this.down = null;
      if (!this.active || !d || e.button !== 0) return;
      if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > 4 || performance.now() - d.t > 500) return;
      this.clickPath(e.clientX, e.clientY);
    });
    window.addEventListener("pointermove", (e) => {
      if (this.drag) (this.drag.x = e.clientX), (this.drag.y = e.clientY);
    });
    window.addEventListener("pointerup", () => this.endDrag());
  }

  setActive(on: boolean): void {
    this.active = on;
    this.world.mapMode = on;
    this.overlay.classList.toggle("hidden", !on);
    this.panel.classList.toggle("hidden", !on);
    this.track.classList.toggle("hidden", !(on && this.showTrack));
    if (!on) {
      for (const l of [this.coast, this.plan, ...this.bodyLines.values(), ...this.soiLines]) l.visible = false;
      this.world.focus = FOCUS_SPACECRAFT;
      this.world.camera.minDistance = 1.5;
      this.world.camera.setDistance(35, true);
      return;
    }
    // Frame the current orbit around its centre body.
    const c = this.world.centerId;
    const row = this.bodies.find((b) => b.id === c);
    const info = this.sim.sim.orbitInfo();
    const apo = info.length >= 11 && Number.isFinite(info[7]) ? info[7]! + (row?.radii[0] ?? 0) : 4 * (row?.radii[0] ?? 7e6);
    this.world.focus = c;
    this.world.camera.minDistance = (row?.radii[0] ?? 1e6) + 3000; // down to ~3 km above the surface
    this.world.camera.setDistance(Math.max(apo * 5, (row?.radii[0] ?? 1e6) * 6), true);
    // Look down the orbit normal (tilted 25° for depth), in the map's ecliptic frame.
    const sc = this.sim.sim.spacecraft();
    if (sc.length >= 8) {
      const hn = new THREE.Vector3(sc[1]!, sc[2]!, sc[3]!).cross(new THREE.Vector3(sc[4]!, sc[5]!, sc[6]!)).normalize();
      const eps = (84381.406 / 3600) * (Math.PI / 180);
      const up = new THREE.Vector3(0, -Math.sin(eps), Math.cos(eps));
      const fwd = new THREE.Vector3(1, 0, 0);
      const right = new THREE.Vector3().crossVectors(fwd, up).normalize();
      const f2 = new THREE.Vector3().crossVectors(up, right).normalize();
      const pitch = Math.asin(Math.max(-1, Math.min(1, hn.dot(up))));
      const yaw = Math.atan2(hn.dot(right), hn.dot(f2));
      this.world.camera.setAngles(yaw, Math.sign(pitch || 1) * Math.min(Math.abs(pitch), 1.15) - 0.0, true);
    } else {
      this.world.camera.setAngles(0.4, 0.9, true);
    }
    this.slowT = 1e9;
  }

  toggleTrack(): void {
    this.showTrack = !this.showTrack;
    this.track.classList.toggle("hidden", !(this.active && this.showTrack));
  }

  private focusBody(id: number): void {
    const row = this.bodies.find((b) => b.id === id);
    if (!row) return;
    this.world.focus = id;
    this.world.camera.minDistance = row.radii[0] + 3000;
    const soi = this.sim.sim.soiRadius(id);
    this.world.camera.setDistance(Number.isFinite(soi) ? Math.min(soi * 1.5, row.radii[0] * 60) : row.radii[0] * 8, false);
  }

  /** Render-space position of `p` given relative to body `center`. */
  private toRender(p: V, center: number): THREE.Vector3 | null {
    const f = this.world.frame;
    const off = center === this.world.centerId ? [0, 0, 0] : f.rel.get(center);
    if (!off) return null;
    return new THREE.Vector3(p[0] + off[0]! - f.cam[0], p[1] + off[1]! - f.cam[1], p[2] + off[2]! - f.cam[2]);
  }

  /** Screen position (CSS px) or null when behind the camera. */
  private screen(v: THREE.Vector3): [number, number] | null {
    const cam = this.engine.camera;
    const viewZ = v.clone().applyMatrix4(cam.matrixWorldInverse).z;
    if (viewZ >= 0) return null;
    const ndc = v.clone().project(cam);
    const el = this.engine.renderer.domElement;
    return [((ndc.x + 1) / 2) * el.clientWidth, ((1 - ndc.y) / 2) * el.clientHeight];
  }

  update(dt: number): void {
    if (!this.active) return;
    const s = this.sim.sim;
    const f = this.world.frame;
    const center = this.world.centerId;
    const res = this.engine.pixelSize;
    for (const l of [this.coast, this.plan, ...this.bodyLines.values(), ...this.soiLines]) (l.material as LineMaterial).resolution.set(res.x, res.y);

    this.slowT += dt;
    if (this.slowT >= SLOW_REFRESH) {
      this.slowT = 0;
      this.planJson = JSON.parse(s.planJson()) as PlanJson;
      this.markers = { coast: JSON.parse(s.markersJson(false)) as MarkerJson[], plan: JSON.parse(s.markersJson(true)) as MarkerJson[] };
      this.updatePanel();
      if (this.showTrack) this.drawTrack();
    }
    this.applyDrag(dt);

    // Paths.
    this.pick = [];
    const centers = (planned: boolean) => s.pathCenters(planned);
    for (const [line, planned, base, other] of [
      [this.coast, false, COAST_COLOR, COAST_OTHER],
      [this.plan, true, PLAN_COLOR, PLAN_OTHER],
    ] as const) {
      const p = s.path(planned, center, 1500);
      const arcCenters = centers(planned);
      const n = p.length / 5;
      const pts = new Float32Array(n * 3);
      const cols = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) {
        const o = i * 5;
        const rx = p[o]! - f.cam[0], ry = p[o + 1]! - f.cam[1], rz = p[o + 2]! - f.cam[2];
        pts[i * 3] = rx;
        pts[i * 3 + 1] = ry;
        pts[i * 3 + 2] = rz;
        const c = arcCenters[p[o + 3]!] === center ? base : other;
        cols[i * 3] = c.r;
        cols[i * 3 + 1] = c.g;
        cols[i * 3 + 2] = c.b;
        if (i % 2 === 0) {
          const sc = this.screen(new THREE.Vector3(rx, ry, rz));
          if (sc) this.pick.push([sc[0], sc[1], p[o + 4]!]);
        }
      }
      setLine(line, pts, cols);
    }

    // Body orbits (osculating conics about each parent; refreshed every 2 s of sim time).
    const now = s.epochTdb();
    for (const b of this.bodies) {
      const line = this.bodyLines.get(b.id);
      if (!line) continue;
      const planet = PLANET_OF[b.id];
      const parentOff = b.parent === center ? [0, 0, 0] : f.rel.get(b.parent!);
      const self = b.id === center ? [0, 0, 0] : f.rel.get(b.id);
      // Only orbits that fit the zoom: far larger ones would cross the view as straight lines.
      const size = parentOff && self ? Math.hypot(self[0]! - parentOff[0]!, self[1]! - parentOff[1]!, self[2]! - parentOff[2]!) : Infinity;
      const zoom = this.world.camera.distance;
      const show = (planet === undefined || planet === this.world.focus || planet === center) && size < 40 * zoom && size > 0.005 * zoom;
      if (!show || !parentOff) {
        line.visible = false;
        continue;
      }
      let c = this.orbitCache.get(b.id);
      if (!c || Math.abs(now - c.t) > 2) {
        c = { t: now, pts: Array.from(s.bodyOrbit(b.id, 256)) };
        this.orbitCache.set(b.id, c);
      }
      const n = c.pts.length / 3;
      const pts = new Float32Array(n * 3);
      const cols = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) {
        for (let k = 0; k < 3; k++) {
          pts[i * 3 + k] = c.pts[i * 3 + k]! + parentOff[k]! - f.cam[k]!;
          cols[i * 3 + k] = [ORBIT_COLOR.r, ORBIT_COLOR.g, ORBIT_COLOR.b][k]!;
        }
      }
      setLine(line, pts, cols);
    }

    // SOI rings (centre body and target), facing the camera.
    const cam = this.engine.camera;
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(cam.quaternion);
    const upv = new THREE.Vector3(0, 1, 0).applyQuaternion(cam.quaternion);
    const targetId = this.sim.targetId;
    [center, targetId].forEach((id, k) => {
      const line = this.soiLines[k]!;
      const r = id >= 0 && id !== 10 ? s.soiRadius(id) : NaN;
      const p = id >= 0 ? (id === center ? [0, 0, 0] : f.rel.get(id)) : undefined;
      if (!Number.isFinite(r) || !p || (k === 1 && id === center)) {
        line.visible = false;
        return;
      }
      const n = 129;
      const pts = new Float32Array(n * 3);
      const cols = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) {
        const a = (i / (n - 1)) * Math.PI * 2;
        for (let j = 0; j < 3; j++) {
          const e = j === 0 ? "x" : j === 1 ? "y" : "z";
          pts[i * 3 + j] = p[j]! - f.cam[j]! + r * (Math.cos(a) * right[e] + Math.sin(a) * upv[e]);
          cols[i * 3 + j] = [SOI_COLOR.r, SOI_COLOR.g, SOI_COLOR.b][j]!;
        }
      }
      setLine(line, pts, cols);
    });

    // Body labels and the spacecraft icon.
    const rpp = this.engine.radiansPerPixel;
    for (const b of this.bodies) {
      const lab = this.labels.get(b.id);
      if (!lab) continue;
      const p = b.id === center ? [0, 0, 0] : f.rel.get(b.id);
      const planet = PLANET_OF[b.id];
      const hideMoon = planet !== undefined && planet !== this.world.focus && planet !== center;
      if (!p || hideMoon) {
        lab.style.display = "none";
        continue;
      }
      const v = new THREE.Vector3(p[0]! - f.cam[0], p[1]! - f.cam[1], p[2]! - f.cam[2]);
      const sc = this.screen(v);
      const big = b.radii[0] / v.length() > 6 * rpp;
      if (!sc) {
        lab.style.display = "none";
        continue;
      }
      lab.style.display = "";
      lab.classList.toggle("resolved", big);
      lab.style.transform = `translate(${sc[0]}px, ${sc[1]}px)`;
    }
    const scp = this.screen(new THREE.Vector3(f.rsc[0] - f.cam[0], f.rsc[1] - f.cam[1], f.rsc[2] - f.cam[2]));
    this.scIcon.style.display = scp ? "" : "none";
    if (scp) this.scIcon.style.transform = `translate(${scp[0]}px, ${scp[1]}px)`;

    this.drawMarkers();
    this.drawNodes();
  }

  private bodyName(id: number): string {
    return this.bodies.find((b) => b.id === id)?.name ?? String(id);
  }

  private drawMarkers(): void {
    clear(this.markerLayer);
    // With a plan: the current orbit's markers up to the first burn, the plan's after
    // it. One of each kind of target-plane node is enough.
    const first = this.planJson?.nodes[0];
    const split = first ? (first.start ?? first.dt) : Infinity;
    const sets: [MarkerJson[], boolean][] = [
      [this.markers.coast.filter((m) => m.dt < split), false],
      [first ? this.markers.plan.filter((m) => m.dt >= split) : [], true],
    ];
    for (const [list, planned] of sets) {
      const seen = new Set<string>();
      for (const m of list) {
        if (m.dt < 0) continue;
        if (m.kind === "an" || m.kind === "dn") {
          if (seen.has(m.kind)) continue;
          seen.add(m.kind);
        }
        const v = this.toRender(m.pos, m.center);
        const sc = v && this.screen(v);
        if (!sc) continue;
        const t = `T−${fmtDuration(m.dt)}`;
        let text: string;
        switch (m.kind) {
          case "ap": text = `Ap ${fmtLength(m.value)} · ${t}`; break;
          case "pe": text = `Pe ${fmtLength(m.value)} · ${t}`; break;
          case "an": text = `AN ${((m.value * 180) / Math.PI).toFixed(2)}° · ${t}`; break;
          case "dn": text = `DN ${((m.value * 180) / Math.PI).toFixed(2)}° · ${t}`; break;
          case "ca": text = `Closest ${this.bodyName(this.sim.targetId)} ${fmtLength(m.value)} · ${t}`; break;
          case "soi": text = `${m.extra ? `→ ${this.bodyName(m.extra.to)}` : "SOI"} · ${t}`; break;
          case "impact": text = `Impact · ${t}`; break;
        }
        this.markerLayer.append(
          h("div", { class: `map-marker m-${m.kind}${planned ? " planned" : ""}`, style: `transform: translate(${sc[0]}px, ${sc[1]}px)` }, h("span", { class: "pin" }), h("span", { class: "txt" }, text)),
        );
      }
    }
  }

  private nodeFrame(n: PlanNode): { pro: V; nrm: V; rad: V } | null {
    if (!n.pos || !n.vel) return null;
    const v = new THREE.Vector3(...n.vel);
    const r = new THREE.Vector3(...n.pos);
    const pro = v.clone().normalize();
    const nrm = r.clone().cross(v).normalize();
    const rad = pro.clone().cross(nrm).normalize();
    return { pro: pro.toArray() as V, nrm: nrm.toArray() as V, rad: rad.toArray() as V };
  }

  private drawNodes(): void {
    clear(this.nodeLayer);
    const plan = this.planJson;
    if (!plan) return;
    plan.nodes.forEach((n, i) => {
      if (!n.pos || n.center === null) return;
      const v = this.toRender(n.pos, n.center);
      const sc = v && this.screen(v);
      if (!v || !sc) return;
      const sel = i === this.selected;
      const node = h("div", {
        class: `map-node${sel ? " selected" : ""}`,
        style: `transform: translate(${sc[0]}px, ${sc[1]}px)`,
        title: `Node ${i + 1}: ${n.dv.toFixed(1)} m/s`,
        onpointerdown: (e: Event) => {
          e.stopPropagation();
          this.selected = i;
          this.updatePanel();
        },
      });
      this.nodeLayer.append(node);
      if (!sel) return;
      const fr = this.nodeFrame(n);
      if (!fr) return;
      const dist = v.length();
      const L = dist * 40 * this.engine.radiansPerPixel;
      for (const ax of AXES) {
        const dir = ax.key === "prograde" ? fr.pro : ax.key === "normal" ? fr.nrm : fr.rad;
        const tip = v.clone().add(new THREE.Vector3(...dir).multiplyScalar(L * ax.sign));
        const st = this.screen(tip);
        let dx = st ? st[0] - sc[0] : 0, dy = st ? st[1] - sc[1] : 0;
        const len = Math.hypot(dx, dy);
        // Axes pointing at the viewer project short: keep handles at a fixed radius.
        if (len < 1e-3) (dx = 0), (dy = -1);
        else (dx /= len), (dy /= len);
        const hx = sc[0] + dx * 46, hy = sc[1] + dy * 46;
        const handle = h("div", {
          class: `node-handle ${ax.cls}`,
          title: `${ax.label} (drag)`,
          style: `transform: translate(${hx}px, ${hy}px)`,
          onpointerdown: (e: Event) => {
            const pe = e as PointerEvent;
            pe.stopPropagation();
            pe.preventDefault();
            this.drag = { key: ax.key, sign: ax.sign, x0: pe.clientX, y0: pe.clientY, x: pe.clientX, y: pe.clientY, dir: [dx, dy] };
          },
        });
        this.nodeLayer.append(handle);
      }
    });
  }

  /** While a handle is held, change Δv at a rate growing with the drag distance. */
  private applyDrag(dt: number): void {
    const d = this.drag;
    const plan = this.planJson;
    if (!d || !plan) return;
    const n = plan.nodes[this.selected];
    if (!n) return;
    const along = (d.x - d.x0) * d.dir[0] + (d.y - d.y0) * d.dir[1];
    const fine = this.keysFine ? 0.1 : 1;
    const rate = Math.sign(along) * HANDLE_RATE * (along / 20) ** 2 * fine;
    this.dragPending[d.key] += d.sign * rate * dt;
    this.dragPending.since += dt;
    // Re-predict at most 10× per second.
    if (this.dragPending.since >= 0.1) this.flushDrag();
  }

  keysFine = false;

  private flushDrag(): void {
    const plan = this.planJson;
    const n = plan?.nodes[this.selected];
    const p = this.dragPending;
    if (n && (p.prograde || p.normal || p.radial)) {
      n.prograde += p.prograde;
      n.normal += p.normal;
      n.radial += p.radial;
      this.selected = this.sim.sim.setNode(this.selected, n.t, n.prograde, n.normal, n.radial);
      this.slowT = 1e9;
    }
    this.dragPending = { prograde: 0, normal: 0, radial: 0, since: 0 };
  }

  private endDrag(): void {
    if (!this.drag) return;
    this.flushDrag();
    this.drag = null;
  }

  private clickPath(x: number, y: number): void {
    let best: [number, number] | null = null;
    for (const [px, py, t] of this.pick) {
      const d = Math.hypot(px - x, py - y);
      if (d < 14 && (!best || d < best[0])) best = [d, t];
    }
    if (!best) return;
    this.selected = this.sim.sim.addNode(this.sim.sim.epochTdb() + best[1], 0, 0, 0);
    this.slowT = 1e9;
  }

  /** Shift the selected node in time by `ds` seconds. */
  shiftNode(ds: number): void {
    const n = this.planJson?.nodes[this.selected];
    if (!n) return;
    const t = Math.max(this.sim.sim.epochTdb() + 1, n.t + ds);
    this.selected = this.sim.sim.setNode(this.selected, t, n.prograde, n.normal, n.radial);
    this.slowT = 1e9;
  }

  deleteSelected(): void {
    if (this.selected < 0) return;
    this.sim.sim.removeNode(this.selected);
    this.selected = -1;
    this.slowT = 1e9;
  }

  // ---------------------------------------------------------------- node panel
  private updatePanel(): void {
    const plan = this.planJson;
    const ap = JSON.parse(this.sim.sim.autopilotJson()) as AutopilotJson | null;
    clear(this.panel);
    this.panel.append(h("div", { class: "panel-title" }, "MANEUVER PLAN"));
    if (!plan || plan.nodes.length === 0) {
      this.panel.append(h("p", { class: "note" }, "Click the trajectory to add a maneuver node."));
    }
    if (plan && this.selected >= plan.nodes.length) this.selected = plan.nodes.length - 1;
    const n = plan?.nodes[this.selected];
    if (plan && plan.nodes.length > 0 && !n) {
      this.panel.append(h("p", { class: "note" }, `${plan.nodes.length} node(s). Click one to edit it.`));
    }
    if (plan && n) {
      const num = (key: "prograde" | "normal" | "radial", label: string) => {
        const inp = h("input", { type: "number", step: "0.1", value: n[key].toFixed(2) }) as HTMLInputElement;
        inp.addEventListener("change", () => {
          const v = Number(inp.value);
          if (!Number.isFinite(v)) return;
          n[key] = v;
          this.selected = this.sim.sim.setNode(this.selected, n.t, n.prograde, n.normal, n.radial);
          this.slowT = 1e9;
        });
        return h("label", { class: "dv-row" }, h("span", { class: `lbl ${key}` }, label), inp, h("span", { class: "lbl" }, "m/s"));
      };
      const orbit = this.sim.sim.orbitInfo();
      const period = orbit.length >= 9 && Number.isFinite(orbit[8]) ? orbit[8]! : 5400;
      this.panel.append(
        h("div", { class: "row" }, h("span", { class: "lbl" }, `Node ${this.selected + 1} of ${plan.nodes.length}`), h("span", { class: "mono" }, `T−${fmtDuration(n.dt)}`)),
        h(
          "div",
          { class: "time-shift" },
          ...(
            [
              ["−orbit", -period],
              ["−10m", -600],
              ["−1m", -60],
              ["+1m", 60],
              ["+10m", 600],
              ["+orbit", period],
            ] as const
          ).map(([l, ds]) => h("button", { onclick: () => this.shiftNode(ds) }, l)),
        ),
        num("prograde", "Prograde"),
        num("normal", "Normal"),
        num("radial", "Radial"),
        h("div", { class: "row" }, h("span", { class: "lbl" }, "Δv"), h("span", { class: "mono" }, `${n.dv.toFixed(2)} m/s`)),
        h("div", { class: "row" }, h("span", { class: "lbl" }, "Burn time"), h("span", { class: "mono" }, n.duration === null ? "—" : Number.isFinite(n.duration) ? `${n.duration.toFixed(1)} s` : "no engine")),
        h("div", { class: "row" }, h("span", { class: "lbl" }, "Burn start"), h("span", { class: "mono" }, n.start === null ? "—" : `T−${fmtDuration(n.start)}`)),
        h("div", { class: "row" }, h("span", { class: "lbl" }, "Plan total Δv"), h("span", { class: "mono" }, `${plan.totalDv.toFixed(1)} m/s`)),
        h("div", { class: `row${plan.insufficient ? " warn" : ""}` }, h("span", { class: "lbl" }, "Δv left after plan"), h("span", { class: "mono" }, plan.insufficient ? "insufficient propellant" : `${plan.dvAfter.toFixed(0)} m/s`)),
        h(
          "div",
          { class: "menu-footer" },
          h("button", { onclick: () => this.deleteSelected() }, "Delete"),
          ap && ap.phase !== "done"
            ? h("button", { onclick: () => (this.sim.sim.cancelAutopilot(), (this.slowT = 1e9)) }, "Abort autopilot")
            : h(
                "button",
                {
                  class: "primary",
                  onclick: () => {
                    try {
                      this.sim.sim.executeNode(this.selected);
                    } catch (e) {
                      console.warn(String(e));
                    }
                    this.slowT = 1e9;
                  },
                },
                "Execute (autopilot)",
              ),
        ),
      );
    }
    if (ap) this.panel.append(autopilotView(ap));
    // Position relative to nearby bodies.
    const f = this.world.frame;
    const ids = [...new Set([this.world.centerId, 399, 301, 10, this.sim.targetId].filter((i) => i >= 0))];
    this.panel.append(h("div", { class: "panel-title sub" }, "DISTANCES"));
    for (const id of ids) {
      const p = id === this.world.centerId ? [0, 0, 0] : f.rel.get(id);
      if (!p) continue;
      const d = Math.hypot(f.rsc[0] - p[0]!, f.rsc[1] - p[1]!, f.rsc[2] - p[2]!);
      const r = this.bodies.find((b) => b.id === id)?.radii[0] ?? 0;
      this.panel.append(h("div", { class: "row" }, h("span", { class: "lbl" }, this.bodyName(id)), h("span", { class: "mono" }, `${fmtLength(d)} (alt ${fmtLength(d - r)})`)));
    }
  }

  private drawTrack(): void {
    const ctx = this.trackCanvas.getContext("2d")!;
    const W = this.trackCanvas.width, H = this.trackCanvas.height;
    const c = this.world.centerId;
    if (c === 399 && this.trackImage.complete && this.trackImage.naturalWidth > 0) ctx.drawImage(this.trackImage, 0, 0, W, H);
    else {
      ctx.fillStyle = "#1a1f2a";
      ctx.fillRect(0, 0, W, H);
    }
    ctx.strokeStyle = "rgb(255 255 255 / 0.15)";
    ctx.lineWidth = 1;
    for (let lon = -180; lon <= 180; lon += 30) {
      const x = ((lon + 180) / 360) * W;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, H);
      ctx.stroke();
    }
    for (let lat = -60; lat <= 60; lat += 30) {
      const y = ((90 - lat) / 180) * H;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(W, y);
      ctx.stroke();
    }
    const info = this.sim.sim.orbitInfo();
    const period = info.length >= 9 && Number.isFinite(info[8]) ? info[8]! : 6000;
    const g = this.sim.sim.groundTrack(c, 400, Math.min(2 * period, 86400 * 2));
    const xy = (i: number): [number, number] => [((g[i + 1]! * 180) / Math.PI + 180) / 360 * W, (90 - (g[i]! * 180) / Math.PI) / 180 * H];
    ctx.strokeStyle = "#ffcf4a";
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let i = 0; i < g.length; i += 2) {
      const [x, y] = xy(i);
      const prev = i >= 2 ? xy(i - 2) : null;
      if (!prev || Math.abs(prev[0] - x) > W / 2) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
    if (g.length >= 2) {
      const [x, y] = xy(0);
      ctx.fillStyle = "#ffffff";
      ctx.beginPath();
      ctx.arc(x, y, 5, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

export function autopilotView(ap: AutopilotJson): HTMLElement {
  const rows: HTMLElement[] = [h("div", { class: "panel-title sub" }, "AUTOPILOT")];
  const row = (l: string, v: string) => h("div", { class: "row" }, h("span", { class: "lbl" }, l), h("span", { class: "mono" }, v));
  if (ap.phase === "aligning") rows.push(row("Status", `aligning · ignition T−${fmtDuration(Math.max(0, ap.toStart))}`));
  if (ap.phase === "burning") rows.push(row("Status", `burning ${ap.delivered.toFixed(1)} / ${ap.dv.toFixed(1)} m/s`));
  if (ap.phase === "done") rows.push(row("Status", "burn complete"));
  const r = ap.report;
  if (r) {
    rows.push(
      row("Δv planned / delivered", `${r.dvPlanned.toFixed(2)} / ${r.dvDelivered.toFixed(2)} m/s`),
      row("Pointing error", `${r.pointingDeg.toFixed(3)}°`),
      row("State vs plan at cutoff", `${fmtLength(r.posErr)} · ${r.velErr.toFixed(3)} m/s`),
      ...r.compare.map((c) => row(c.label, `${fmtLength(c.actual)} (plan ${fmtLength(c.planned)}, Δ ${fmtLength(c.actual - c.planned)})`)),
    );
  }
  return h("div", {}, ...rows);
}
