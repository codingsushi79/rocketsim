// Crew-module interior for the cockpit camera, built from the vehicle's `cabin` data
// (data/vehicles/*.json): pressure vessel with real window openings, couches, a main
// console with three live displays, lockers, handrails and cabin lights.
//
// Photometry in the renderer's unit U (units.ts): 1 U is the luminance of a white
// Lambertian surface in full sunlight at 1 au, E☉/π ≈ 128,000 lx / π ≈ 40,700 cd/m².
// Cabin lighting of ~300 lx (typical crewed-spacecraft general lighting; NASA-STD-3001
// Vol. 2, §8.7, gives 108–500 lx by task) is 300/128,000 ≈ 0.0023 of E☉; display
// luminance ~200 cd/m² ≈ 0.005 U. The auto-exposure adapts to the dim cabin like an eye,
// so sunlit views through the windows saturate, as in photographs taken inside.

import * as THREE from "three";
import { PRE_EXPOSURE } from "./units";

export interface CabinDef {
  eye: [number, number, number];
  forward: [number, number, number];
  up: [number, number, number];
  /** Inner pressure-vessel frustum along +X. */
  vessel: { x0: number; x1: number; r0: number; r1: number };
  tunnel: { radius: number; length: number };
  /** Window centres: x (m) and azimuth (deg) about +X, measured from `up` toward +Y. */
  windows: { name: string; x: number; azimuth: number; width: number; height: number }[];
  seats: [number, number, number][];
  console: { x: number; z: number; width: number; height: number; tilt_deg: number };
}

const LUX_SUN_1AU = 128_000; // lx, illuminance of sunlight above the atmosphere (≈ E☉·93 lm/W)
const CABIN_LUX = 300;
const DISPLAY_NITS = 200;
const NITS_PER_U = LUX_SUN_1AU / Math.PI;

/** Body-frame direction for azimuth `az` (deg) about +X, measured from `up` toward +Y. */
function radial(def: CabinDef, az: number): THREE.Vector3 {
  const up = new THREE.Vector3(...def.up).normalize();
  const side = new THREE.Vector3(...def.forward).cross(up).normalize().negate(); // +Y for up = −Z
  const a = (az * Math.PI) / 180;
  return up.multiplyScalar(Math.cos(a)).addScaledVector(side, Math.sin(a));
}

/** Panel texture: light grey wall panels with seams, fasteners and labels. */
function wallTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = c.height = 512;
  const g = c.getContext("2d")!;
  g.fillStyle = "#c9ccd0";
  g.fillRect(0, 0, 512, 512);
  const panels = [
    [0, 0, 256, 256], [256, 0, 256, 170], [256, 170, 256, 86], [0, 256, 170, 256], [170, 256, 342, 256],
  ];
  for (const [x, y, w, h] of panels) {
    g.fillStyle = `rgb(${196 + Math.round(Math.random() * 10)},${199 + Math.round(Math.random() * 10)},${203 + Math.round(Math.random() * 10)})`;
    g.fillRect(x! + 3, y! + 3, w! - 6, h! - 6);
    g.strokeStyle = "#8d9196";
    g.lineWidth = 2;
    g.strokeRect(x! + 3, y! + 3, w! - 6, h! - 6);
    g.fillStyle = "#7c8086";
    for (const [fx, fy] of [[x! + 12, y! + 12], [x! + w! - 12, y! + 12], [x! + 12, y! + h! - 12], [x! + w! - 12, y! + h! - 12]]) {
      g.beginPath();
      g.arc(fx!, fy!, 3, 0, Math.PI * 2);
      g.fill();
    }
  }
  g.fillStyle = "#5a5f66";
  g.font = "bold 13px monospace";
  g.fillText("STOWAGE  A2", 24, 230);
  g.fillText("O2 / N2  ISOL", 280, 150);
  g.fillText("LCKR 4", 200, 490);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 4;
  return t;
}

type WindowDef = CabinDef["windows"][number];

/** Vessel inner radius at x. */
function vesselR(def: CabinDef, x: number): number {
  const { x0, x1, r0, r1 } = def.vessel;
  return r0 + ((r1 - r0) * (x - x0)) / (x1 - x0);
}

/** Signed distance (m, negative inside) from (x, azimuth) to a window's rounded-rectangle
 *  outline, measured in the wall's (x, arc length) coordinates. */
function windowLocal(def: CabinDef, w: WindowDef, x: number, az: number): number {
  const rc = Math.min(w.width, w.height) * 0.28; // corner radius
  const dAz = ((az - w.azimuth + 540) % 360) - 180;
  const ds = ((dAz * Math.PI) / 180) * vesselR(def, w.x);
  const qx = Math.abs(x - w.x) - (w.height / 2 - rc);
  const qs = Math.abs(ds) - (w.width / 2 - rc);
  return Math.hypot(Math.max(qx, 0), Math.max(qs, 0)) + Math.min(Math.max(qx, qs), 0) - rc;
}

/** A window's outline: n points (x, azimuth) on its rounded rectangle, grown by `grow` m. */
function windowOutline(def: CabinDef, w: WindowDef, grow: number, n = 64): [number, number][] {
  const rc = Math.min(w.width, w.height) * 0.28 + grow;
  const hx = w.height / 2 - Math.min(w.width, w.height) * 0.28, hs = w.width / 2 - Math.min(w.width, w.height) * 0.28;
  const rw = vesselR(def, w.x);
  const out: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const cx = Math.cos(a) >= 0 ? hx : -hx, cs = Math.sin(a) >= 0 ? hs : -hs;
    const dx = cx + rc * Math.cos(a), ds = cs + rc * Math.sin(a);
    out.push([w.x + dx, w.azimuth + ((ds / rw) * 180) / Math.PI]);
  }
  return out;
}

/** The vessel wall as a (x, azimuth) grid with the window cells left open. */
function vesselGeometry(def: CabinDef, grow = 0): THREE.BufferGeometry {
  const { x0, x1 } = def.vessel;
  const r0 = def.vessel.r0 + grow, r1 = def.vessel.r1 + grow;
  const NX = 160, NA = 360;
  const pos: number[] = [], uv: number[] = [], idx: number[] = [];
  const at = (i: number, j: number) => i * (NA + 1) + j;
  for (let i = 0; i <= NX; i++) {
    const x = x0 + ((x1 - x0) * i) / NX;
    const r = r0 + ((r1 - r0) * i) / NX;
    for (let j = 0; j <= NA; j++) {
      const az = -180 + (360 * j) / NA;
      const d = radial(def, az).multiplyScalar(r);
      pos.push(x, d.y, d.z);
      uv.push((az + 180) / 60, x / 1.2);
    }
  }
  // Cut every cell within ¾ of a cell of an opening: a cell kept just outside the outline
  // otherwise pokes its corners into the opening (teeth seen through the window tunnel).
  // The hole is then up to ~1.5 cells larger than the outline, hidden by the 5 cm bezel.
  const cell = Math.max((x1 - x0) / NX, ((2 * Math.PI) / NA) * Math.max(r0, r1));
  const inWindow = (x: number, az: number) => def.windows.some((w) => windowLocal(def, w, x, az) < 0.75 * cell);
  for (let i = 0; i < NX; i++) {
    for (let j = 0; j < NA; j++) {
      const xc = x0 + ((x1 - x0) * (i + 0.5)) / NX;
      const azc = -180 + (360 * (j + 0.5)) / NA;
      if (inWindow(xc, azc)) continue;
      // Wound so the inside faces the cabin.
      idx.push(at(i, j), at(i, j + 1), at(i + 1, j), at(i + 1, j), at(i, j + 1), at(i + 1, j + 1));
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** A canvas texture shown at a fixed luminance (displays, backlit legends). */
function emissive(tex: THREE.Texture, nits: number, transparent = false): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { map: { value: tex }, L: { value: nits / NITS_PER_U }, gain: { value: 1 }, preExposure: PRE_EXPOSURE },
    vertexShader: /* glsl */ `
      #include <common>
      #include <logdepthbuf_pars_vertex>
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        #include <logdepthbuf_vertex>
      }`,
    fragmentShader: /* glsl */ `
      #include <common>
      #include <logdepthbuf_pars_fragment>
      uniform sampler2D map;
      uniform float L, gain, preExposure;
      varying vec2 vUv;
      void main() {
        #include <logdepthbuf_fragment>
        vec4 t = texture2D(map, vUv);
        gl_FragColor = vec4(t.rgb * L * gain * preExposure, 1.0);
      }`,
    transparent,
  });
}

/** Telemetry the displays show (filled by the HUD each frame). */
export interface CabinData {
  pitch: number;
  roll: number;
  heading: number;
  altitude: number;
  speed: number;
  apoapsis: number;
  periapsis: number;
  inclination: number;
  eccentricity: number;
  bodyRadius: number;
  bodyName: string;
  dv: number;
  mass: number;
  heat: number;
  q: number;
  throttle: number;
  prop: { label: string; frac: number }[];
  met: string;
  sas: number;
  rcs: boolean;
  node: { dt: number; dv: number } | null;
  target: { name: string; dist: number } | null;
}

/** Control actions a cockpit button can trigger (performed by the game). */
export type CabinAction = { kind: "sas"; mode: number } | { kind: "rcs" } | { kind: "stage" } | { kind: "page"; display: number } | { kind: "map" };

const FONT = "Plex Mono, IBM Plex Mono, ui-monospace, monospace";
const GREEN = "#7dffa0", CYAN = "#7fd8ff", AMBER = "#ffb547", WHITE = "#e6eef4", DIM = "#5d7482";
const PAGES = ["ATT", "ORB", "SYS", "NAV"] as const;
type Page = (typeof PAGES)[number];

function bezel(g: CanvasRenderingContext2D, W: number, H: number, title: string, page: string): void {
  g.fillStyle = "#010304";
  g.fillRect(0, 0, W, H);
  g.strokeStyle = "#1f2c35";
  g.lineWidth = 2;
  g.strokeRect(4, 4, W - 8, H - 8);
  g.fillStyle = DIM;
  g.font = `500 17px ${FONT}`;
  g.fillText(title, 16, 28);
  g.textAlign = "right";
  g.fillText(page, W - 16, 28);
  g.textAlign = "left";
  g.strokeStyle = "#1f2c35";
  g.beginPath();
  g.moveTo(12, 38);
  g.lineTo(W - 12, 38);
  g.stroke();
}

const fmtLen = (m: number) => (Math.abs(m) >= 1e7 ? `${(m / 1e6).toFixed(1)} Mm` : `${(m / 1000).toFixed(1)} km`);
const fmtT = (s: number) => {
  const a = Math.abs(s), h = Math.floor(a / 3600), mi = Math.floor((a % 3600) / 60), se = Math.floor(a % 60);
  return `${s < 0 ? "-" : ""}${String(h).padStart(2, "0")}:${String(mi).padStart(2, "0")}:${String(se).padStart(2, "0")}`;
};

/** Draw one display page. */
function drawPage(page: Page, g: CanvasRenderingContext2D, W: number, H: number, d: CabinData): void {
  bezel(g, W, H, ["ATT", "ORB", "SYS", "NAV"].includes(page) ? { ATT: "ATTITUDE", ORB: "ORBIT", SYS: "SYSTEMS", NAV: "NAVIGATION" }[page] : page, page);
  g.font = `500 18px ${FONT}`;
  if (page === "ATT") {
    // ADI with pitch ladder, roll pointer and a heading tape.
    const cx = W / 2, cy = H / 2 + 6, R = Math.min(W, H) * 0.33;
    g.save();
    g.beginPath();
    g.arc(cx, cy, R, 0, Math.PI * 2);
    g.clip();
    g.translate(cx, cy);
    g.rotate((-d.roll * Math.PI) / 180);
    const off = (d.pitch / 60) * R;
    g.fillStyle = "#14476d";
    g.fillRect(-2 * R, -3 * R + off, 4 * R, 3 * R);
    g.fillStyle = "#4b2e15";
    g.fillRect(-2 * R, off, 4 * R, 3 * R);
    g.strokeStyle = WHITE;
    g.fillStyle = WHITE;
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(-2 * R, off);
    g.lineTo(2 * R, off);
    g.stroke();
    g.font = `14px ${FONT}`;
    for (let p = -50; p <= 50; p += 10) {
      if (p === 0) continue;
      const y = off - (p / 60) * R, w = p % 20 === 0 ? 0.32 : 0.18;
      g.beginPath();
      g.moveTo(-R * w, y);
      g.lineTo(R * w, y);
      g.stroke();
      if (p % 20 === 0) g.fillText(String(Math.abs(p)), R * w + 4, y + 5);
    }
    g.restore();
    g.strokeStyle = "#2c3a44";
    g.lineWidth = 2;
    g.beginPath();
    g.arc(cx, cy, R, 0, Math.PI * 2);
    g.stroke();
    // Aircraft symbol.
    g.strokeStyle = AMBER;
    g.lineWidth = 4;
    g.beginPath();
    g.moveTo(cx - R * 0.55, cy);
    g.lineTo(cx - R * 0.18, cy);
    g.lineTo(cx, cy + 12);
    g.lineTo(cx + R * 0.18, cy);
    g.lineTo(cx + R * 0.55, cy);
    g.stroke();
    // Heading tape.
    const ty = H - 34;
    g.fillStyle = "#06090b";
    g.fillRect(40, ty - 18, W - 80, 32);
    g.strokeStyle = DIM;
    g.lineWidth = 1;
    g.font = `13px ${FONT}`;
    g.fillStyle = WHITE;
    for (let k = -30; k <= 30; k += 5) {
      const hd = Math.round(d.heading / 5) * 5 + k;
      const x = W / 2 + (hd - d.heading) * ((W - 80) / 70);
      if (x < 44 || x > W - 44) continue;
      g.beginPath();
      g.moveTo(x, ty - 18);
      g.lineTo(x, ty - (hd % 10 === 0 ? 8 : 12));
      g.stroke();
      if (hd % 10 === 0) {
        g.textAlign = "center";
        g.fillText(String(((hd % 360) + 360) % 360).padStart(3, "0"), x, ty + 9);
        g.textAlign = "left";
      }
    }
    g.fillStyle = AMBER;
    g.beginPath();
    g.moveTo(W / 2, ty - 18);
    g.lineTo(W / 2 - 7, ty - 27);
    g.lineTo(W / 2 + 7, ty - 27);
    g.fill();
    g.fillStyle = CYAN;
    g.font = `500 16px ${FONT}`;
    g.fillText(`PIT ${d.pitch.toFixed(1)}`, 16, 62);
    g.textAlign = "right";
    g.fillText(`ROL ${d.roll.toFixed(1)}`, W - 16, 62);
    g.textAlign = "left";
  } else if (page === "ORB") {
    // Orbit diagram (to scale): the central body and the conic, with Ap/Pe.
    const cx = W * 0.36, cy = H * 0.56;
    const rp = d.bodyRadius + d.periapsis, ra = d.bodyRadius + d.apoapsis;
    const bound = Number.isFinite(ra) && ra > 0 && d.eccentricity < 1;
    const a = bound ? (rp + ra) / 2 : rp * 3;
    const e = Math.min(d.eccentricity, 0.98);
    const s = (Math.min(W * 0.33, H * 0.36)) / (bound ? a * (1 + e) : rp * 4);
    g.fillStyle = "#1a3b57";
    g.beginPath();
    g.arc(cx, cy, Math.max(3, d.bodyRadius * s), 0, Math.PI * 2);
    g.fill();
    g.strokeStyle = GREEN;
    g.lineWidth = 2;
    g.beginPath();
    for (let k = 0; k <= 180; k++) {
      const nu = -Math.PI + (k / 180) * 2 * Math.PI;
      const p = a * (1 - e * e);
      const r = p / (1 + e * Math.cos(nu));
      if (r <= 0 || r > a * 6) continue;
      const x = cx - r * Math.cos(nu) * s, y = cy + r * Math.sin(nu) * s;
      if (k === 0) g.moveTo(x, y);
      else g.lineTo(x, y);
    }
    g.stroke();
    g.fillStyle = CYAN;
    g.fillRect(cx - rp * s - 3, cy - 3, 6, 6);
    if (bound) g.fillRect(cx + ra * s - 3, cy - 3, 6, 6);
    const rows: [string, string][] = [
      ["BODY", d.bodyName.toUpperCase()],
      ["ALT", fmtLen(d.altitude)],
      ["VEL", `${(d.speed / 1000).toFixed(3)} km/s`],
      ["AP", bound ? fmtLen(d.apoapsis) : "ESC"],
      ["PE", fmtLen(d.periapsis)],
      ["INC", `${d.inclination.toFixed(2)}°`],
      ["ECC", d.eccentricity.toFixed(4)],
    ];
    g.font = `500 16px ${FONT}`;
    rows.forEach(([k, v], i) => {
      g.fillStyle = DIM;
      g.fillText(k, W * 0.66, 66 + i * 26);
      g.fillStyle = WHITE;
      g.textAlign = "right";
      g.fillText(v, W - 16, 66 + i * 26);
      g.textAlign = "left";
    });
  } else if (page === "SYS") {
    g.font = `500 15px ${FONT}`;
    d.prop.slice(0, 8).forEach((p, i) => {
      const y = 54 + i * 26;
      g.fillStyle = DIM;
      g.fillText(p.label, 16, y + 12);
      g.strokeStyle = "#24343f";
      g.strokeRect(150, y, W - 250, 14);
      g.fillStyle = p.frac > 0.2 ? GREEN : AMBER;
      g.fillRect(151, y + 1, Math.max(0, (W - 252) * p.frac), 12);
      g.fillStyle = WHITE;
      g.textAlign = "right";
      g.fillText(`${Math.round(p.frac * 100)}%`, W - 16, y + 12);
      g.textAlign = "left";
    });
    g.font = `500 17px ${FONT}`;
    g.fillStyle = WHITE;
    g.fillText(`ΔV ${d.dv.toFixed(0)} m/s`, 16, H - 46);
    g.fillText(`MASS ${(d.mass / 1000).toFixed(2)} t`, W / 2, H - 46);
    g.fillStyle = d.heat > 1e5 || d.q > 2e4 ? AMBER : WHITE;
    g.fillText(`Q ${(d.q / 1000).toFixed(1)} kPa`, 16, H - 20);
    g.fillText(`HEAT ${(d.heat / 1000).toFixed(0)} kW/m²`, W / 2, H - 20);
  } else {
    g.font = `500 18px ${FONT}`;
    const row = (y: number, k: string, v: string, c = WHITE) => {
      g.fillStyle = DIM;
      g.fillText(k, 16, y);
      g.fillStyle = c;
      g.textAlign = "right";
      g.fillText(v, W - 16, y);
      g.textAlign = "left";
    };
    row(70, "MET", d.met);
    row(100, "SAS", ["OFF", "HOLD", "PRO", "RETRO", "NML", "ANML", "RAD+", "RAD-", "TGT", "ATGT", "MNVR"][d.sas] ?? "-", GREEN);
    row(130, "RCS", d.rcs ? "ON" : "OFF", d.rcs ? GREEN : DIM);
    row(160, "THR", `${Math.round(d.throttle * 100)}%`);
    if (d.node) {
      row(196, "NODE", `T-${fmtT(d.node.dt)}`, CYAN);
      row(222, "BURN", `${d.node.dv.toFixed(1)} m/s`, CYAN);
    } else row(196, "NODE", "NONE", DIM);
    if (d.target) row(H - 22, `TGT ${d.target.name.toUpperCase()}`, fmtLen(d.target.dist), AMBER);
  }
}

/** A display: a canvas page drawn from the cabin data, emitting DISPLAY_NITS. */
class Display {
  readonly mesh: THREE.Mesh;
  private canvas = document.createElement("canvas");
  private tex: THREE.CanvasTexture;
  page: Page;
  constructor(w: number, h: number, page: Page) {
    this.page = page;
    this.canvas.width = 640;
    this.canvas.height = Math.round((640 * h) / w);
    this.tex = new THREE.CanvasTexture(this.canvas);
    this.tex.colorSpace = THREE.SRGBColorSpace;
    this.tex.anisotropy = 4;
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), emissive(this.tex, DISPLAY_NITS));
  }
  refresh(d: CabinData): void {
    drawPage(this.page, this.canvas.getContext("2d")!, this.canvas.width, this.canvas.height, d);
    this.tex.needsUpdate = true;
  }
}

/** A backlit push-button legend (lit when its state is on). */
class Button {
  readonly mesh: THREE.Mesh;
  private mat: THREE.ShaderMaterial;
  constructor(readonly action: CabinAction, label: string, w: number, h: number, color: string) {
    const c = document.createElement("canvas");
    c.width = 160;
    c.height = Math.round((160 * h) / w);
    const g = c.getContext("2d")!;
    g.fillStyle = "#0a0d10";
    g.fillRect(0, 0, c.width, c.height);
    g.strokeStyle = "#2a333b";
    g.lineWidth = 6;
    g.strokeRect(3, 3, c.width - 6, c.height - 6);
    g.fillStyle = color;
    g.font = `600 ${Math.round(c.height * 0.36)}px ${FONT}`;
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillText(label, c.width / 2, c.height / 2 + 2);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    this.mat = emissive(t, 25);
    // A dark key cap with the legend on its crew-facing side (oriented like the displays).
    this.mesh = new THREE.Mesh(new THREE.BoxGeometry(0.012, w, h), new THREE.MeshStandardMaterial({ color: 0x1a1d21, roughness: 0.6 }));
    const legend = new THREE.Mesh(new THREE.PlaneGeometry(w * 0.92, h * 0.86), this.mat);
    legend.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, -1), new THREE.Vector3(-1, 0, 0)));
    legend.position.x = -0.0065;
    legend.userData.button = this;
    this.mesh.add(legend);
    this.mesh.userData.button = this;
  }
  set lit(on: boolean) {
    this.mat.uniforms.gain!.value = on ? 8 : 1;
  }
}

/** Panel silkscreen: group outlines and captions on the console face. */
function silkscreen(w: number, h: number, groups: { x: number; y: number; w: number; h: number; label: string }[]): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  const S = 900;
  c.width = S;
  c.height = Math.round((S * h) / w);
  const g = c.getContext("2d")!;
  g.fillStyle = "#24282d";
  g.fillRect(0, 0, c.width, c.height);
  // Fine grain.
  for (let i = 0; i < 4000; i++) {
    g.fillStyle = `rgba(255,255,255,${Math.random() * 0.025})`;
    g.fillRect(Math.random() * c.width, Math.random() * c.height, 1, 1);
  }
  g.strokeStyle = "#b8c0c8";
  g.fillStyle = "#c8d0d8";
  g.lineWidth = 2;
  g.font = `600 15px ${FONT}`;
  for (const b of groups) {
    const X = ((b.x + w / 2) / w) * c.width, Y = ((b.y + h / 2) / h) * c.height;
    const BW = (b.w / w) * c.width, BH = (b.h / h) * c.height;
    g.strokeRect(X - BW / 2, Y - BH / 2, BW, BH);
    const tw = g.measureText(b.label).width + 12;
    g.fillStyle = "#24282d";
    g.fillRect(X - tw / 2, Y - BH / 2 - 9, tw, 18);
    g.fillStyle = "#c8d0d8";
    g.textAlign = "center";
    g.fillText(b.label, X, Y - BH / 2 + 5);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

/** Typical cabin surface luminance (U): cabin illuminance × a mid albedo. */
export const CABIN_LUMINANCE_U = (CABIN_LUX / LUX_SUN_1AU) * 0.5;

export class Interior {
  /** At the vehicle's CoM with its attitude (set by the world). */
  readonly root = new THREE.Group();
  /** Structure frame: offset by −CoM inside `root`. */
  private body = new THREE.Group();
  readonly eye: THREE.Vector3;
  readonly forward: THREE.Vector3;
  readonly up: THREE.Vector3;
  private lights: THREE.PointLight[] = [];
  private displays: Display[] = [];
  private buttons: Button[] = [];
  private lastRefresh = 0;
  data: CabinData | null = null;

  constructor(def: CabinDef) {
    this.eye = new THREE.Vector3(...def.eye);
    this.forward = new THREE.Vector3(...def.forward).normalize();
    this.up = new THREE.Vector3(...def.up).normalize();
    const wallTex = wallTexture();
    const wall = new THREE.MeshStandardMaterial({ map: wallTex, roughness: 0.85, metalness: 0, side: THREE.DoubleSide });
    wall.shadowSide = THREE.DoubleSide; // the vessel must block the Sun from either side
    const trim = new THREE.MeshStandardMaterial({ color: 0x3a3f46, roughness: 0.6, metalness: 0.2 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x1b1e22, roughness: 0.7, metalness: 0.1 });
    const fabric = new THREE.MeshStandardMaterial({ color: 0x2b3440, roughness: 0.95, metalness: 0 });
    const frameMat = new THREE.MeshStandardMaterial({ color: 0x2b2f35, roughness: 0.45, metalness: 0.5, side: THREE.DoubleSide });
    const shadow = <T extends THREE.Mesh>(m: T) => ((m.castShadow = true), (m.receiveShadow = true), m);

    // Pressure vessel with window openings, aft bulkhead and the hatch tunnel.
    const { x0, x1, r0 } = def.vessel;
    this.body.add(shadow(new THREE.Mesh(vesselGeometry(def), wall)));
    // Shadow-only outer skin 4 cm outside the wall (same openings): a single sheet leaks
    // light at grazing incidence through the shadow map; two make a thick occluder.
    const skin = new THREE.Mesh(vesselGeometry(def, 0.04), new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false, side: THREE.DoubleSide }));
    skin.castShadow = true;
    this.body.add(skin);
    const aft = shadow(new THREE.Mesh(new THREE.CircleGeometry(r0, 64), new THREE.MeshStandardMaterial({ map: wallTex, roughness: 0.85 })));
    aft.rotation.y = Math.PI / 2;
    aft.position.x = x0;
    this.body.add(aft);
    const tun = shadow(new THREE.Mesh(new THREE.CylinderGeometry(def.tunnel.radius, def.tunnel.radius, def.tunnel.length, 32, 1, true), new THREE.MeshStandardMaterial({ color: 0xb8bcc1, roughness: 0.8, side: THREE.BackSide })));
    tun.rotation.z = -Math.PI / 2;
    tun.position.x = x1 + def.tunnel.length / 2;
    this.body.add(tun);
    const hatch = shadow(new THREE.Mesh(new THREE.CircleGeometry(def.tunnel.radius, 32), dark));
    hatch.rotation.y = -Math.PI / 2;
    hatch.position.x = x1 + def.tunnel.length;
    this.body.add(hatch);

    // Ring frames (structure): arcs that stop at the window openings.
    for (let k = 1; k < 5; k++) {
      const x = x0 + ((x1 - x0) * k) / 5;
      const r = vesselR(def, x) - 0.015;
      const N = 240;
      let start = -1;
      for (let j = 0; j <= N; j++) {
        const az = -180 + (360 * j) / N;
        const free = j < N && !def.windows.some((w) => windowLocal(def, w, x, az) < 0.06);
        if (free && start < 0) start = j;
        if ((!free || j === N) && start >= 0) {
          const a0 = start, a1 = j;
          if (a1 - a0 >= 2) {
            const pts: THREE.Vector3[] = [];
            for (let q = a0; q <= a1 - 1; q++) {
              const d = radial(def, -180 + (360 * q) / N).multiplyScalar(r);
              pts.push(new THREE.Vector3(x, d.y, d.z));
            }
            const tube = shadow(new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), pts.length * 2, 0.018, 6, false), trim));
            this.body.add(tube);
          }
          start = -1;
        }
      }
    }

    // Windows: a frame following each opening (a tunnel through the 9 cm wall and a flat
    // inner bezel) and a glass pane with a faint cabin reflection.
    for (const w of def.windows) {
      const at = (x: number, az: number, dr: number) => {
        const d = radial(def, az).multiplyScalar(vesselR(def, x) + dr);
        return new THREE.Vector3(x, d.y, d.z);
      };
      const inner = windowOutline(def, w, 0.004);
      const outer = windowOutline(def, w, 0.05);
      const pos: number[] = [];
      const quad = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, d: THREE.Vector3) => pos.push(...a.toArray(), ...b.toArray(), ...c.toArray(), ...c.toArray(), ...b.toArray(), ...d.toArray());
      for (let i = 0; i < inner.length; i++) {
        const j = (i + 1) % inner.length;
        const [xi, ai] = inner[i]!, [xj, aj] = inner[j]!;
        const [xo, ao] = outer[i]!, [xp, ap] = outer[j]!;
        // Tunnel through the wall thickness.
        quad(at(xi, ai, -0.004), at(xj, aj, -0.004), at(xi, ai, 0.09), at(xj, aj, 0.09));
        // Bezel on the inner face.
        quad(at(xi, ai, -0.006), at(xj, aj, -0.006), at(xo, ao, -0.006), at(xp, ap, -0.006));
      }
      const fg = new THREE.BufferGeometry();
      fg.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
      fg.computeVertexNormals();
      this.body.add(shadow(new THREE.Mesh(fg, frameMat)));
      // Glass: a fan at the outer face; mostly clear, slight reflection at grazing angles.
      const gp: number[] = [];
      const c0 = at(w.x, w.azimuth, 0.085);
      for (let i = 0; i < inner.length; i++) {
        const j = (i + 1) % inner.length;
        gp.push(...c0.toArray(), ...at(inner[i]![0], inner[i]![1], 0.085).toArray(), ...at(inner[j]![0], inner[j]![1], 0.085).toArray());
      }
      const gg = new THREE.BufferGeometry();
      gg.setAttribute("position", new THREE.Float32BufferAttribute(gp, 3));
      gg.computeVertexNormals();
      const glass = new THREE.Mesh(
        gg,
        new THREE.ShaderMaterial({
          uniforms: { L: { value: CABIN_LUX / LUX_SUN_1AU }, preExposure: PRE_EXPOSURE },
          vertexShader: /* glsl */ `
            #include <common>
            #include <logdepthbuf_pars_vertex>
            varying float vF;
            void main() {
              vec4 mv = modelViewMatrix * vec4(position, 1.0);
              vec3 n = normalize(normalMatrix * normal);
              float c = abs(dot(n, normalize(-mv.xyz)));
              vF = 0.04 + 0.96 * pow(1.0 - c, 5.0); // Schlick, n = 1.5
              gl_Position = projectionMatrix * mv;
              #include <logdepthbuf_vertex>
            }`,
          fragmentShader: /* glsl */ `
            #include <common>
            #include <logdepthbuf_pars_fragment>
            uniform float L, preExposure;
            varying float vF;
            void main() {
              #include <logdepthbuf_fragment>
              // Reflected cabin (roughly uniform luminance) added to the view outside.
              gl_FragColor = vec4(vec3(0.85, 0.9, 1.0) * vF * L * 0.5 * preExposure, 1.0);
            }`,
          transparent: true,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          side: THREE.DoubleSide,
        }),
      );
      this.body.add(glass);
    }

    // Couches: seat pan, back and headrest, reclined against the aft bulkhead.
    for (const [x, y, z] of def.seats) {
      const seat = new THREE.Group();
      const back = shadow(new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.5, 1.1), fabric));
      back.position.set(-0.25, 0, -0.1);
      const pan = shadow(new THREE.Mesh(new THREE.BoxGeometry(0.45, 0.5, 0.08), fabric));
      pan.position.set(0.0, 0, 0.45);
      const head = shadow(new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.3, 0.25), fabric));
      head.position.set(-0.18, 0, -0.62);
      const bar = shadow(new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.06, 1.2), trim));
      bar.position.set(-0.32, 0.22, 0);
      const bar2 = bar.clone();
      bar2.position.y = -0.22;
      seat.add(back, pan, head, bar, bar2);
      seat.position.set(x, y, z);
      this.body.add(seat);
    }

    // Main console (local: x toward the crew is −, y crew right, z crew down).
    const cdef = def.console;
    const W = cdef.width, H = cdef.height;
    const consoleG = new THREE.Group();
    consoleG.add(shadow(new THREE.Mesh(new THREE.BoxGeometry(0.06, W, H), dark)));
    const dw = 0.34, dh = 0.25, dz = -H / 2 + 0.04 + dh / 2;
    const pages: Page[] = ["ATT", "ORB", "SYS"];
    const faceQ = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, -1), new THREE.Vector3(-1, 0, 0)));
    // Silkscreen groups (panel coordinates: y right, z down → texture x right, y down).
    const groups = [
      { x: 0, y: dz, w: W - 0.04, h: dh + 0.06, label: "DISPLAYS" },
      { x: -0.12, y: H / 2 - 0.085, w: W - 0.32, h: 0.11, label: "ATTITUDE CONTROL" },
      { x: W / 2 - 0.14, y: H / 2 - 0.085, w: 0.24, h: 0.11, label: "PROP / SEQ" },
    ];
    const face = new THREE.Mesh(new THREE.PlaneGeometry(W, H), new THREE.MeshStandardMaterial({ map: silkscreen(W, H, groups), roughness: 0.7, metalness: 0.15 }));
    face.quaternion.copy(faceQ);
    face.position.x = -0.031;
    face.receiveShadow = true;
    consoleG.add(face);
    pages.forEach((page, i) => {
      const d = new Display(dw, dh, page);
      d.mesh.quaternion.copy(faceQ);
      d.mesh.position.set(-0.036, (i - 1) * (dw + 0.06), dz);
      consoleG.add(d.mesh);
      // Bezel behind the screen (the screen sits 2 mm proud of it).
      const bz = new THREE.Mesh(new THREE.BoxGeometry(0.006, dw + 0.03, dh + 0.03), dark);
      bz.position.set(-0.031, d.mesh.position.y, dz);
      consoleG.add(bz);
      this.displays.push(d);
      // Page key under each display.
      const pk = new Button({ kind: "page", display: i }, "PAGE", 0.07, 0.03, WHITE);
      pk.mesh.position.set(-0.04, d.mesh.position.y + dw / 2 - 0.035, dz + dh / 2 + 0.035);
      consoleG.add(pk.mesh);
      this.buttons.push(pk);
    });
    // SAS mode keys (backlit legends) and propulsion / sequencing keys.
    const sasLabels = ["OFF", "HOLD", "PRO", "RETRO", "NML", "ANML", "RAD+", "RAD-", "TGT", "ATGT", "MNVR"];
    const kw = 0.064, kh = 0.04;
    const rowZ = H / 2 - 0.075;
    sasLabels.forEach((lab, i) => {
      const b = new Button({ kind: "sas", mode: i }, lab, kw, kh, GREEN);
      const col = i % 6, row = Math.floor(i / 6);
      b.mesh.position.set(-0.04, -W / 2 + 0.07 + col * (kw + 0.012), rowZ - 0.025 + row * (kh + 0.01));
      consoleG.add(b.mesh);
      this.buttons.push(b);
    });
    const misc: [CabinAction, string, string][] = [
      [{ kind: "rcs" }, "RCS", CYAN],
      [{ kind: "map" }, "MAP", CYAN],
      [{ kind: "stage" }, "STAGE", AMBER],
    ];
    misc.forEach(([a, lab, col], i) => {
      const b = new Button(a, lab, 0.07, kh, col);
      b.mesh.position.set(-0.04, W / 2 - 0.22 + (i % 2) * 0.085, rowZ - 0.025 + Math.floor(i / 2) * (kh + 0.01));
      consoleG.add(b.mesh);
      this.buttons.push(b);
    });
    // A hinged red guard over STAGE.
    const guard = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.08, 0.05), new THREE.MeshStandardMaterial({ color: 0x8a1c14, roughness: 0.4, transparent: true, opacity: 0.55 }));
    const stageBtn = this.buttons[this.buttons.length - 1]!.mesh;
    guard.position.copy(stageBtn.position).add(new THREE.Vector3(-0.012, 0, 0));
    consoleG.add(guard);
    consoleG.rotation.y = (-cdef.tilt_deg * Math.PI) / 180;
    consoleG.position.set(cdef.x, 0, cdef.z);
    this.body.add(consoleG);

    // Lockers along the side walls and handrails.
    for (const side of [-1, 1]) {
      // Aft of the side windows (x 1.08–1.42 m).
      const locker = shadow(new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.05, 0.5), new THREE.MeshStandardMaterial({ map: wallTex, roughness: 0.8 })));
      locker.position.set(0.72, side * 1.12, 0.5);
      locker.rotation.x = side * 0.35;
      this.body.add(locker);
      const rail = shadow(new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.014, 0.9, 8), new THREE.MeshStandardMaterial({ color: 0xd8a33a, roughness: 0.5, metalness: 0.3 })));
      rail.rotation.z = Math.PI / 2;
      rail.position.set(1.55, side * 0.62, -0.5);
      this.body.add(rail);
    }

    // Cabin lights: two LED panels near the apex, neutral white (≈ 4000 K).
    for (const y of [-0.3, 0.3]) {
      const l = new THREE.PointLight(new THREE.Color(1.0, 0.93, 0.84), 0, 0, 2);
      l.position.set(2.15, y, -0.2);
      this.lights.push(l);
      this.body.add(l);
      const lampTex = new THREE.DataTexture(new Uint8Array([255, 240, 220, 255]), 1, 1);
      lampTex.needsUpdate = true;
      const lamp = new THREE.Mesh(new THREE.PlaneGeometry(0.22, 0.08), emissive(lampTex, 600));
      (lamp.material as THREE.ShaderMaterial).side = THREE.DoubleSide;
      lamp.position.copy(l.position).add(new THREE.Vector3(0.02, 0, -0.02));
      lamp.rotation.y = Math.PI / 2;
      this.body.add(lamp);
    }
    // Every lit surface in the cabin takes the shadow map: one that doesn't receives the
    // full direct sunlight through the hull (≈ 400× the cabin lighting) and burns white.
    this.body.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh && !(m.material instanceof THREE.ShaderMaterial)) {
        m.receiveShadow = true;
        m.castShadow = true;
      }
    });
    this.root.add(this.body);
    this.root.visible = false;
  }

  /** Per frame while visible: lights follow the pre-exposure; displays refresh at 10 Hz. */
  update(now: number, com: ArrayLike<number>): void {
    this.body.position.set(-com[0]!, -com[1]!, -com[2]!);
    // three.js point light: irradiance = intensity / d² (decay 2); our lights carry π·E·pre.
    for (const l of this.lights) l.intensity = Math.PI * (CABIN_LUX / LUX_SUN_1AU) * PRE_EXPOSURE.value * 0.8;
    const d = this.data;
    if (!d) return;
    for (const b of this.buttons) {
      const a = b.action;
      b.lit = (a.kind === "sas" && a.mode === d.sas) || (a.kind === "rcs" && d.rcs);
    }
    if (now - this.lastRefresh > 100) {
      this.lastRefresh = now;
      for (const disp of this.displays) disp.refresh(d);
    }
  }

  /** The button under a ray (cockpit clicks), if any. Cycles a display page itself. */
  pick(ray: THREE.Raycaster): CabinAction | null {
    const hits = ray.intersectObjects(this.buttons.map((b) => b.mesh), true);
    const o = hits[0]?.object;
    const b = (o?.userData.button ?? o?.parent?.userData.button) as Button | undefined;
    if (!b) return null;
    if (b.action.kind === "page") {
      const disp = this.displays[b.action.display]!;
      disp.page = PAGES[(PAGES.indexOf(disp.page) + 1) % PAGES.length]!;
      if (this.data) disp.refresh(this.data);
    }
    return b.action;
  }
}
