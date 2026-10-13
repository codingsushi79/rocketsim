// Engine exhaust plume, rendered as a volume (ray-marched inside a bounding cylinder).
//
// Shape, from the gas dynamics of a supersonic jet leaving a nozzle at exit pressure p_e
// into ambient pressure p_a:
// - Vacuum (p_a ≪ p_e, strongly under-expanded): the gas keeps expanding past the lip.
//   Density falls as 1/r² from the exit with a core of half-angle θ_c; with the cosine
//   plume model ρ ∝ cos^(2/(γ−1))(πθ/2θ_lim) (Simons 1972, AIAA J. 10:1534) and γ ≈ 1.2,
//   the brightness half-width is ≈ 25–30°.
// - In air the expansion stops where the plume's pressure falls to p_a. For isentropic
//   flow with ρ ∝ r⁻², p ∝ r^(−2γ), so the jet's radius levels off at
//   r_b = R_e·(p_e/p_a)^(1/(2γ)): the plume balloons as the vehicle climbs.
// - Shock diamonds in a mismatched jet repeat every L ≈ 1.306·D·√(M_j² − 1) (Pack 1950,
//   Q. J. Mech. Appl. Math. 3:173), M_j the fully-expanded jet Mach number.
// Brightness: a fixed visual radiance at the core (see spacecraft.ts); a real vacuum
// hypergolic plume is far fainter. The glow length in air (afterburning with entrained
// air) is a visual choice, stated below, not a radiation model.

import * as THREE from "three";
import { PRE_EXPOSURE } from "./units";

export interface NozzleData {
  /** Exit radius, m. */
  exitRadius: number;
  /** Exit static pressure, Pa (vehicle data, or 2.5 % of vacuum thrust over the exit area,
   *  typical of high-expansion upper-stage nozzles). */
  exitPressure: number;
  /** Exit Mach number (vehicle data, else 4). */
  exitMach: number;
}

/** Ratio of specific heats of hot combustion products (Sutton & Biblarz, Rocket
 *  Propulsion Elements, 9th ed., table 5-5: 1.2–1.25). */
const GAMMA = 1.2;
/** Brightness half-angle of the vacuum core (cosine model with γ = 1.2, above). */
const CORE_HALF_ANGLE = (27 * Math.PI) / 180;

const VS = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_vertex>
  varying vec3 vLocal;
  void main() {
    vLocal = position;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    #include <logdepthbuf_vertex>
  }`;

const FS = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_fragment>
  uniform vec3 camLocal;      // camera in the unit cylinder's coordinates
  uniform vec3 size;          // (L, Rmax, Rmax): unit → metres
  uniform float Re, rb, slope, Lglow, cell, diamonds, intensity, radiance, preExposure, time, mixing;
  uniform vec3 color;
  varying vec3 vLocal;

  // Jet radius at distance s downstream: from R_e toward r_b (or along the vacuum cone).
  float radiusAt(float s) {
    // Plus the turbulent mixing layer in dense air (supersonic shear layers spread at
    // dR/ds ≈ 0.05–0.1; Papamoschou & Roshko 1988, J. Fluid Mech. 197:453).
    float d = rb - Re;
    float r = abs(d) < 1e-3 ? Re : rb - d * exp(-s * slope / abs(d));
    return r + mixing * s;
  }
  float emission(vec3 p) {
    float s = -p.x;
    if (s < 0.0) return 0.0;
    float rho = length(p.yz);
    float R = max(radiusAt(s), 0.25 * Re);
    float w = exp(-2.5 * (rho * rho) / (R * R));
    // Mass conservation (area dilution) and cooling along the plume.
    float n = (Re * Re) / (R * R) * exp(-s / Lglow);
    float dia = 0.0;
    if (diamonds > 0.0) {
      for (int k = 0; k < 6; k++) {
        float sk = (float(k) + 0.6) * cell;
        float q = (s - sk) / (0.12 * cell);
        dia += exp(-q * q);
      }
      dia *= diamonds * exp(-s / (4.0 * cell)) * exp(-4.0 * rho * rho / (R * R));
    }
    return n * (w + 1.5 * dia);
  }

  void main() {
    #include <logdepthbuf_fragment>
    // Ray through this fragment, in metres in the plume frame (x downstream negative).
    vec3 o = camLocal * size;
    vec3 f = vLocal * size;
    vec3 dir = normalize(f - o);
    // Clip to the bounding cylinder: x in [−L, 0], radius Rmax.
    float L = size.x, Rm = size.y;
    float t0 = 0.0, t1 = 1e9;
    // Slabs in x.
    if (abs(dir.x) > 1e-6) {
      float ta = (0.0 - o.x) / dir.x, tb = (-L - o.x) / dir.x;
      t0 = max(t0, min(ta, tb));
      t1 = min(t1, max(ta, tb));
    } else if (o.x > 0.0 || o.x < -L) discard;
    // Infinite cylinder y² + z² = Rm².
    float a = dot(dir.yz, dir.yz), b = dot(o.yz, dir.yz), c = dot(o.yz, o.yz) - Rm * Rm;
    if (a > 1e-12) {
      float disc = b * b - a * c;
      if (disc <= 0.0) discard;
      float sq = sqrt(disc);
      t0 = max(t0, (-b - sq) / a);
      t1 = min(t1, (-b + sq) / a);
    } else if (c > 0.0) discard;
    if (t1 <= t0) discard;
    const int N = 40;
    float dt = (t1 - t0) / float(N);
    float acc = 0.0, core = 0.0;
    float j0 = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
    for (int i = 0; i < N; i++) {
      vec3 p = o + dir * (t0 + (float(i) + j0) * dt);
      float e = emission(p);
      acc += e * dt;
      core += e * dt * exp(-(-p.x) / (1.5 * Re));
    }
    // Normalised so a line of sight through the exit plane's centre gives ≈ radiance.
    float flicker = 0.95 + 0.05 * sin(time * 91.0);
    float Lr = intensity * acc / (1.12 * Re) * flicker;
    vec3 c3 = mix(color, vec3(1.0, 0.95, 0.88), clamp(core / max(acc, 1e-6), 0.0, 1.0));
    gl_FragColor = vec4(c3 * Lr * radiance * preExposure, 1.0);
  }`;

export class Plume {
  readonly mesh: THREE.Mesh<THREE.CylinderGeometry, THREE.ShaderMaterial>;
  private noz: NozzleData;

  constructor(noz: NozzleData, color: THREE.Color, radianceU: number) {
    this.noz = noz;
    // Unit cylinder along −X from 0 to −1, radius 1.
    const g = new THREE.CylinderGeometry(1, 1, 1, 32, 1, false);
    g.rotateZ(Math.PI / 2);
    g.translate(-0.5, 0, 0);
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        camLocal: { value: new THREE.Vector3() },
        size: { value: new THREE.Vector3(1, 1, 1) },
        Re: { value: noz.exitRadius },
        rb: { value: 1e6 },
        slope: { value: Math.tan(CORE_HALF_ANGLE) },
        Lglow: { value: 4 * noz.exitRadius },
        mixing: { value: 0 },
        cell: { value: 4 * noz.exitRadius },
        diamonds: { value: 0 },
        intensity: { value: 0 },
        radiance: { value: radianceU },
        preExposure: PRE_EXPOSURE,
        time: { value: 0 },
        color: { value: color },
      },
      vertexShader: VS,
      fragmentShader: FS,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.FrontSide,
    });
    this.mesh = new THREE.Mesh(g, mat);
    this.mesh.frustumCulled = false;
  }

  /** Shape for throttle fraction `k` (0–1) at ambient pressure `pAmb` (Pa). */
  update(k: number, pAmb: number, camera: THREE.Camera, time: number): void {
    const u = this.mesh.material.uniforms;
    const Re = this.noz.exitRadius;
    const pe = this.noz.exitPressure * Math.max(k, 0.05); // exit pressure ∝ chamber pressure ∝ throttle
    const pa = Math.max(pAmb, 1e-3);
    // Pressure-matched radius (above); effectively unbounded in vacuum.
    // An over-expanded jet contracts only modestly (oblique shocks at the lip, then the
    // mixing layer grows): keep the column at ≥ 0.75 R_e.
    const rb = Re * Math.max(0.75, Math.min((pe / pa) ** (1 / (2 * GAMMA)), 1e4));
    // Glow length: a few exit radii in vacuum; the afterburning column in dense air is
    // longer (visual choice: up to ~30 exit diameters at sea level).
    const dense = Math.min(1, pAmb / 30_000);
    const Lglow = Re * (7 + 53 * dense);
    // Shock diamonds: in a strongly mismatched jet in dense air.
    const g = GAMMA;
    const me = this.noz.exitMach;
    const p0 = pe * (1 + 0.5 * (g - 1) * me * me) ** (g / (g - 1));
    const mj = Math.sqrt(Math.max((2 / (g - 1)) * ((p0 / pa) ** ((g - 1) / g) - 1), 1.05));
    const rj = Math.max(Math.min(rb, 50 * Re), 0.3 * Re);
    const cell = 1.306 * 2 * rj * Math.sqrt(mj * mj - 1);
    const mismatch = Math.abs(Math.log(pe / pa));
    const diamonds = pAmb > 500 ? Math.min(1, mismatch / 1.5) * Math.min(1, pAmb / 5_000) : 0;
    // Bounds: until the emission is ~1 % of the exit's.
    const L = Math.min(Lglow * 4.6, Re * 200);
    const rEnd = rb - (rb - Re) * Math.exp((-L * Math.tan(CORE_HALF_ANGLE)) / Math.max(Math.abs(rb - Re), 1e-3));
    const Rmax = (Math.max(Re, Math.min(rb, rEnd)) + 0.06 * dense * L) * 1.8;
    this.mesh.scale.set(L, Rmax, Rmax);
    u.size!.value.set(L, Rmax, Rmax);
    u.rb!.value = rb;
    u.Lglow!.value = Lglow;
    u.cell!.value = cell;
    u.diamonds!.value = diamonds;
    u.mixing!.value = 0.06 * dense;
    u.intensity!.value = 0.3 + 0.7 * k;
    u.time!.value = time;
    // Camera in unit-cylinder coordinates; from inside the volume, draw the back faces.
    this.mesh.updateWorldMatrix(true, false);
    const inv = this.mesh.matrixWorld.clone().invert();
    const cl = new THREE.Vector3().setFromMatrixPosition(camera.matrixWorld).applyMatrix4(inv);
    u.camLocal!.value.copy(cl);
    const inside = cl.x <= 0 && cl.x >= -1 && cl.y * cl.y + cl.z * cl.z <= 1;
    this.mesh.material.side = inside ? THREE.BackSide : THREE.FrontSide;
  }
}

/** Nozzle data for an engine from the vehicle definition. */
export function nozzleData(e: { thrust_vac: number; exit_area?: number; exit_pressure?: number; exit_mach?: number }, exitRadius: number): NozzleData {
  const area = e.exit_area ?? Math.PI * exitRadius * exitRadius;
  return {
    exitRadius,
    exitPressure: e.exit_pressure ?? (0.025 * e.thrust_vac) / area,
    exitMach: e.exit_mach ?? 4,
  };
}
