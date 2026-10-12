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
  const inWindow = (x: number, az: number) =>
    def.windows.some((w) => {
      const r = r0 + ((r1 - r0) * (w.x - x0)) / (x1 - x0);
      const dAz = ((az - w.azimuth + 540) % 360) - 180;
      return Math.abs(x - w.x) < w.height / 2 && Math.abs((dAz * Math.PI) / 180) * r < w.width / 2;
    });
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

/** A live display: canvas drawn by `draw`, emitting DISPLAY_NITS. */
class Display {
  readonly mesh: THREE.Mesh;
  private canvas = document.createElement("canvas");
  private tex: THREE.CanvasTexture;
  constructor(w: number, h: number, private draw: (g: CanvasRenderingContext2D, W: number, H: number) => void) {
    this.canvas.width = 512;
    this.canvas.height = Math.round((512 * h) / w);
    this.tex = new THREE.CanvasTexture(this.canvas);
    this.tex.colorSpace = THREE.SRGBColorSpace;
    const mat = new THREE.ShaderMaterial({
      uniforms: { map: { value: this.tex }, L: { value: DISPLAY_NITS / NITS_PER_U }, preExposure: PRE_EXPOSURE },
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
        uniform float L, preExposure;
        varying vec2 vUv;
        void main() {
          #include <logdepthbuf_fragment>
          gl_FragColor = vec4(texture2D(map, vUv).rgb * L * preExposure, 1.0);
        }`,
    });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
  }
  refresh(): void {
    const g = this.canvas.getContext("2d")!;
    this.draw(g, this.canvas.width, this.canvas.height);
    this.tex.needsUpdate = true;
  }
}

/** Telemetry the displays show (filled by the world). */
export interface CabinData {
  pitch: number;
  roll: number;
  heading: number;
  altitude: number;
  speed: number;
  apoapsis: number;
  periapsis: number;
  inclination: number;
  dv: number;
  mass: number;
  heat: number;
  q: number;
  prop: { label: string; frac: number }[];
  met: string;
}

const FONT = "IBM Plex Mono, ui-monospace, monospace";

function frame(g: CanvasRenderingContext2D, W: number, H: number, title: string): void {
  g.fillStyle = "#020406";
  g.fillRect(0, 0, W, H);
  g.strokeStyle = "#2c3a44";
  g.lineWidth = 2;
  g.strokeRect(6, 6, W - 12, H - 12);
  g.fillStyle = "#6f8796";
  g.font = `500 18px ${FONT}`;
  g.fillText(title, 18, 32);
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
    const glassRim = new THREE.MeshStandardMaterial({ color: 0x15171a, roughness: 0.4, metalness: 0.6 });

    const shadow = (m: THREE.Mesh) => ((m.castShadow = true), (m.receiveShadow = true), m);

    // Pressure vessel with window openings, aft bulkhead and the hatch tunnel.
    const { x0, x1, r0, r1 } = def.vessel;
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
    // Ring frames (structure) along the vessel.
    for (let k = 1; k < 5; k++) {
      const x = x0 + ((x1 - x0) * k) / 5;
      const r = r0 + ((r1 - r0) * k) / 5;
      const ring = shadow(new THREE.Mesh(new THREE.TorusGeometry(r - 0.015, 0.018, 6, 96), trim));
      ring.rotation.y = Math.PI / 2;
      ring.position.x = x;
      this.body.add(ring);
    }

    // Window frames: a rim around each opening.
    for (const w of def.windows) {
      const r = r0 + ((r1 - r0) * (w.x - x0)) / (x1 - x0);
      const n = radial(def, w.azimuth);
      const rim = shadow(new THREE.Mesh(new THREE.TorusGeometry(Math.min(w.width, w.height) * 0.55, 0.025, 8, 4), glassRim));
      rim.position.set(w.x, n.y * (r - 0.01), n.z * (r - 0.01));
      rim.lookAt(rim.position.clone().add(n));
      rim.rotateZ(Math.PI / 4);
      rim.scale.set(w.width / Math.min(w.width, w.height), w.height / Math.min(w.width, w.height), 1);
      this.body.add(rim);
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
      const frameBar = shadow(new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.06, 1.2), trim));
      frameBar.position.set(-0.32, 0.22, 0);
      const frameBar2 = frameBar.clone();
      frameBar2.position.y = -0.22;
      seat.add(back, pan, head, frameBar, frameBar2);
      seat.position.set(x, y, z);
      this.body.add(seat);
    }

    // Main console: a tilted panel in front of the crew, three displays and switch rows.
    const cdef = def.console;
    const consoleG = new THREE.Group();
    const panel = shadow(new THREE.Mesh(new THREE.BoxGeometry(0.06, cdef.width, cdef.height), dark));
    consoleG.add(panel);
    const dw = 0.36, dh = 0.27;
    const drawers = [
      (g: CanvasRenderingContext2D, W: number, H: number) => this.drawAttitude(g, W, H),
      (g: CanvasRenderingContext2D, W: number, H: number) => this.drawOrbit(g, W, H),
      (g: CanvasRenderingContext2D, W: number, H: number) => this.drawSystems(g, W, H),
    ];
    drawers.forEach((draw, i) => {
      const d = new Display(dw, dh, draw);
      // Panel faces −X (toward the crew); the plane faces +Z by default.
      // Screen right → +Y (crew right), screen up → −Z (crew up), normal → −X (crew).
      d.mesh.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, -1), new THREE.Vector3(-1, 0, 0)));
      d.mesh.position.set(-0.035, (i - 1) * (dw + 0.08), -0.06);
      consoleG.add(d.mesh);
      const bezel = new THREE.Mesh(new THREE.BoxGeometry(0.02, dw + 0.04, dh + 0.04), trim);
      bezel.position.set(-0.025, d.mesh.position.y, d.mesh.position.z);
      consoleG.add(bezel);
      this.displays.push(d);
    });
    // Switch rows below the displays.
    const sw = new THREE.BoxGeometry(0.02, 0.018, 0.035);
    const guard = new THREE.BoxGeometry(0.03, 0.05, 0.006);
    for (let row = 0; row < 2; row++) {
      for (let k = 0; k < 18; k++) {
        const y = -cdef.width / 2 + 0.12 + k * ((cdef.width - 0.24) / 17);
        const s = new THREE.Mesh(sw, trim);
        s.position.set(-0.045, y, cdef.height / 2 - 0.09 - row * 0.07);
        s.rotation.y = row === 0 ? 0.35 : -0.35;
        consoleG.add(s);
        if (k % 6 === 0) {
          const gd = new THREE.Mesh(guard, glassRim);
          gd.position.set(-0.04, y, s.position.z + 0.025);
          consoleG.add(gd);
        }
      }
    }
    consoleG.rotation.y = (-cdef.tilt_deg * Math.PI) / 180;
    consoleG.position.set(cdef.x, 0, cdef.z);
    this.body.add(consoleG);

    // Lockers along the side walls and handrails.
    for (const side of [-1, 1]) {
      const locker = shadow(new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.05, 0.5), new THREE.MeshStandardMaterial({ map: wallTex, roughness: 0.8 })));
      locker.position.set(0.85, side * 1.12, 0.5);
      locker.rotation.x = side * 0.35;
      this.body.add(locker);
      const rail = shadow(new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.014, 0.9, 8), new THREE.MeshStandardMaterial({ color: 0xd8a33a, roughness: 0.5, metalness: 0.3 })));
      rail.rotation.z = Math.PI / 2;
      rail.position.set(1.7, side * 0.55, -0.45);
      this.body.add(rail);
    }

    // Cabin lights: two LED panels near the apex, neutral white (≈ 4000 K).
    for (const y of [-0.35, 0.35]) {
      const l = new THREE.PointLight(new THREE.Color(1.0, 0.93, 0.84), 0, 0, 2);
      l.position.set(2.2, y, -0.25);
      this.lights.push(l);
      this.body.add(l);
      const lamp = new THREE.Mesh(
        new THREE.PlaneGeometry(0.22, 0.08),
        new THREE.ShaderMaterial({
          uniforms: { L: { value: 600 / NITS_PER_U }, preExposure: PRE_EXPOSURE },
          vertexShader: `#include <common>\n#include <logdepthbuf_pars_vertex>\nvoid main(){\n  gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0);\n  #include <logdepthbuf_vertex>\n}`,
          fragmentShader: `#include <common>\n#include <logdepthbuf_pars_fragment>\nuniform float L, preExposure;\nvoid main(){\n  #include <logdepthbuf_fragment>\n  gl_FragColor = vec4(vec3(1.0,0.93,0.84) * L * preExposure, 1.0);\n}`,
          side: THREE.DoubleSide,
        }),
      );
      lamp.position.copy(l.position).add(new THREE.Vector3(0.02, 0, -0.02));
      lamp.rotation.y = Math.PI / 2;
      this.body.add(lamp);
    }
    this.root.add(this.body);
    this.root.visible = false;
  }

  /** Per frame while visible: lights follow the pre-exposure; displays refresh at 10 Hz. */
  update(now: number, com: ArrayLike<number>): void {
    this.body.position.set(-com[0]!, -com[1]!, -com[2]!);
    // three.js point light: irradiance = intensity / d² (decay 2); our lights carry π·E·pre.
    for (const l of this.lights) l.intensity = Math.PI * (CABIN_LUX / LUX_SUN_1AU) * PRE_EXPOSURE.value * 0.8;
    if (now - this.lastRefresh > 100 && this.data) {
      this.lastRefresh = now;
      for (const d of this.displays) d.refresh();
    }
  }

  private drawAttitude(g: CanvasRenderingContext2D, W: number, H: number): void {
    frame(g, W, H, "ATT");
    const d = this.data!;
    const cx = W / 2, cy = H / 2 + 10, R = Math.min(W, H) * 0.36;
    g.save();
    g.beginPath();
    g.arc(cx, cy, R, 0, Math.PI * 2);
    g.clip();
    g.translate(cx, cy);
    g.rotate((-d.roll * Math.PI) / 180);
    const off = (d.pitch / 90) * R;
    g.fillStyle = "#1d4f7a";
    g.fillRect(-2 * R, -2 * R + off, 4 * R, 2 * R);
    g.fillStyle = "#5a3a1c";
    g.fillRect(-2 * R, off, 4 * R, 2 * R);
    g.strokeStyle = "#e8edf2";
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(-2 * R, off);
    g.lineTo(2 * R, off);
    g.stroke();
    g.font = `14px ${FONT}`;
    g.fillStyle = "#e8edf2";
    for (let p = -60; p <= 60; p += 20) {
      if (p === 0) continue;
      const y = off - (p / 90) * R;
      g.beginPath();
      g.moveTo(-R * 0.25, y);
      g.lineTo(R * 0.25, y);
      g.stroke();
      g.fillText(String(p), R * 0.28, y + 5);
    }
    g.restore();
    g.strokeStyle = "#ffcc33";
    g.lineWidth = 3;
    g.beginPath();
    g.moveTo(cx - R * 0.5, cy);
    g.lineTo(cx - R * 0.15, cy);
    g.lineTo(cx, cy + 10);
    g.lineTo(cx + R * 0.15, cy);
    g.lineTo(cx + R * 0.5, cy);
    g.stroke();
    g.fillStyle = "#c7d3dc";
    g.font = `500 17px ${FONT}`;
    g.fillText(`HDG ${d.heading.toFixed(1).padStart(5)}`, 18, H - 18);
    g.fillText(`RLL ${d.roll.toFixed(1).padStart(6)}`, W - 150, H - 18);
  }

  private drawOrbit(g: CanvasRenderingContext2D, W: number, H: number): void {
    frame(g, W, H, "ORB");
    const d = this.data!;
    const rows: [string, string][] = [
      ["ALT", `${(d.altitude / 1000).toFixed(1)} km`],
      ["VEL", `${(d.speed / 1000).toFixed(3)} km/s`],
      ["APO", `${(d.apoapsis / 1000).toFixed(1)} km`],
      ["PER", `${(d.periapsis / 1000).toFixed(1)} km`],
      ["INC", `${d.inclination.toFixed(2)}°`],
      ["MET", d.met],
    ];
    g.font = `500 22px ${FONT}`;
    rows.forEach(([k, v], i) => {
      g.fillStyle = "#6f8796";
      g.fillText(k, 22, 74 + i * 34);
      g.fillStyle = "#e8edf2";
      g.fillText(v, W - 22 - g.measureText(v).width, 74 + i * 34);
    });
  }

  private drawSystems(g: CanvasRenderingContext2D, W: number, H: number): void {
    frame(g, W, H, "SYS");
    const d = this.data!;
    g.font = `500 17px ${FONT}`;
    d.prop.slice(0, 6).forEach((p, i) => {
      const y = 62 + i * 30;
      g.fillStyle = "#6f8796";
      g.fillText(p.label, 20, y + 12);
      g.strokeStyle = "#2c3a44";
      g.strokeRect(140, y, W - 170, 14);
      g.fillStyle = p.frac > 0.2 ? "#9fd8a6" : "#ffb34d";
      g.fillRect(141, y + 1, Math.max(0, (W - 172) * p.frac), 12);
    });
    g.fillStyle = "#e8edf2";
    g.fillText(`ΔV ${d.dv.toFixed(0)} m/s   M ${(d.mass / 1000).toFixed(2)} t`, 20, H - 46);
    g.fillStyle = d.heat > 1e5 ? "#ffb34d" : "#e8edf2";
    g.fillText(`Q ${(d.q / 1000).toFixed(1)} kPa   HEAT ${(d.heat / 1000).toFixed(0)} kW/m²`, 20, H - 20);
  }
}
