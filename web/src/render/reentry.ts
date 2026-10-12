// Atmospheric entry effects, driven by the core's stagnation heat flux q (Sutton–Graves),
// dynamic pressure and air-relative velocity.
//
// 1. Incandescence (physical): a surface heated by q re-radiates at its radiative-
//    equilibrium temperature, εσT⁴ = q (Anderson, *Hypersonic and High-Temperature Gas
//    Dynamics*, §6.9), ε = 0.85 (charring ablator). The local flux falls off away from the
//    stagnation point as q·cos^1.5 of the angle between the surface normal and the flow
//    (a Lees-type distribution for blunt bodies, approximate). Its visible radiance and
//    colour come from Planck's law integrated against the CIE 1931 colour-matching
//    functions (multi-lobe fits of Wyman, Sloan & Shirley 2013, JCGT 2(2)), relative to
//    sunlight (a 5772 K blackbody scaled to E☉ = 1361 W/m²), so it lands in the same
//    radiance units (U) and white balance as everything else.
// 2. Shock layer and wake (approximate): a glowing sheath ahead of and around the vehicle
//    and a trail behind it. Real shock-layer radiation is non-equilibrium and not modelled;
//    its brightness here is tied to the wall emission and tinted like the N₂⁺/O/Na emission
//    seen in entry footage. A visual aid, labelled as such.
// 3. A plasma light on the vehicle, and buffeting with dynamic pressure.

import * as THREE from "three";
import { PRE_EXPOSURE } from "./units";

import { incandescenceU, wallTemperature } from "./incandescence";

// Lookup: log10 q from 3 to 8 (1 kW/m² to 100 MW/m²) → incandescent radiance (U).
const Q_LOG_MIN = 3, Q_LOG_MAX = 8, TABLE = 256;
function heatTable(): THREE.DataTexture {
  const d = new Float32Array(TABLE * 4);
  for (let i = 0; i < TABLE; i++) {
    const q = Math.pow(10, Q_LOG_MIN + ((Q_LOG_MAX - Q_LOG_MIN) * i) / (TABLE - 1));
    const [r, g, b] = incandescenceU(wallTemperature(q));
    d.set([r, g, b, 1], i * 4);
  }
  const t = new THREE.DataTexture(d, TABLE, 1, THREE.RGBAFormat, THREE.FloatType);
  t.minFilter = t.magFilter = THREE.LinearFilter;
  t.needsUpdate = true;
  return t;
}

/** Shared uniforms for every glowing material. */
const shared = {
  heatTex: { value: heatTable() },
  qStag: { value: 0 },
  /** Unit air-relative velocity in view space (the front faces it). */
  flowView: { value: new THREE.Vector3(1, 0, 0) },
};

/** Make a standard material incandesce with the entry heat flux. */
export function addIncandescence(m: THREE.Material): void {
  if (!(m instanceof THREE.MeshStandardMaterial) || m.userData.incandescent) return;
  m.userData.incandescent = true;
  const prev = m.onBeforeCompile;
  m.onBeforeCompile = (sh, r) => {
    prev.call(m, sh, r);
    sh.uniforms.heatTex = shared.heatTex;
    sh.uniforms.qStag = shared.qStag;
    sh.uniforms.flowView = shared.flowView;
    sh.uniforms.heatPreExposure = PRE_EXPOSURE;
    sh.fragmentShader = sh.fragmentShader
      .replace("#include <common>", "#include <common>\nuniform sampler2D heatTex;\nuniform float qStag, heatPreExposure;\nuniform vec3 flowView;")
      .replace(
        "#include <emissivemap_fragment>",
        `#include <emissivemap_fragment>
        if (qStag > 1000.0) {
          // Local flux: q·cos^1.5 of the angle to the flow (blunt-body falloff, approximate).
          float c = max(dot(normal, flowView), 0.0);
          float ql = qStag * pow(c, 1.5);
          if (ql > 1000.0) {
            float u = (log2(ql) / 3.321928 - ${Q_LOG_MIN.toFixed(1)}) / ${(Q_LOG_MAX - Q_LOG_MIN).toFixed(1)};
            totalEmissiveRadiance += texture2D(heatTex, vec2(clamp(u, 0.0, 1.0), 0.5)).rgb * heatPreExposure;
          }
        }`,
      );
  };
  const key = m.customProgramCacheKey.bind(m);
  m.customProgramCacheKey = () => key() + "|incandescent";
  m.needsUpdate = true;
}

/** Shock-layer sheath + wake (visual aid). Unit geometry: nose at +X, wake toward −X. */
function sheathMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { glow: { value: new THREE.Vector3() }, time: { value: 0 }, preExposure: PRE_EXPOSURE },
    vertexShader: /* glsl */ `
      #include <common>
      #include <logdepthbuf_pars_vertex>
      varying vec3 vP;
      varying float vFacing;
      void main() {
        vP = position;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vec3 n = normalize(normalMatrix * normal);
        vFacing = abs(dot(n, normalize(-mv.xyz)));
        gl_Position = projectionMatrix * mv;
        #include <logdepthbuf_vertex>
      }`,
    fragmentShader: /* glsl */ `
      #include <common>
      #include <logdepthbuf_pars_fragment>
      uniform vec3 glow;
      uniform float time, preExposure;
      varying vec3 vP;
      varying float vFacing;
      float hash(vec3 p) { return fract(sin(dot(p, vec3(12.9898, 78.233, 37.719))) * 43758.5453); }
      float noise(vec3 p) {
        vec3 i = floor(p), f = fract(p);
        f = f * f * (3.0 - 2.0 * f);
        return mix(mix(mix(hash(i), hash(i + vec3(1,0,0)), f.x), mix(hash(i + vec3(0,1,0)), hash(i + vec3(1,1,0)), f.x), f.y),
                   mix(mix(hash(i + vec3(0,0,1)), hash(i + vec3(1,0,1)), f.x), mix(hash(i + vec3(0,1,1)), hash(i + vec3(1,1,1)), f.x), f.y), f.z);
      }
      void main() {
        #include <logdepthbuf_fragment>
        // Optically thin glowing gas: brightness ∝ chord length through it, ≈ the facing
        // term, so the column is brightest along its axis. Brightest at the shock, fading
        // over the whole wake; turbulent streaks along the flow.
        float along = clamp((0.15 - vP.x) / 7.9, 0.0, 1.0);
        float chord = clamp(vFacing, 0.0, 1.0);
        float streak = 0.55 + 0.9 * noise(vec3(vP.x * 4.0 + time * 40.0, vP.y * 7.0, vP.z * 7.0));
        float fade = exp(-5.0 * along) * (1.0 - smoothstep(0.85, 1.0, along));
        gl_FragColor = vec4(glow * chord * streak * fade * preExposure, 1.0);
      }`,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
}

function sheathGeometry(): THREE.BufferGeometry {
  // Bow shock (paraboloid, standoff 0.15 R ahead of a unit-radius nose, Billig 1967) that
  // opens into a wake cone 1 → 0 along −X (scaled per frame).
  const pts: THREE.Vector2[] = [];
  for (let i = 0; i <= 24; i++) {
    const t = i / 24;
    const r = 1.35 * Math.sqrt(t);
    pts.push(new THREE.Vector2(r, 0.15 - t * 0.9));
  }
  for (let i = 1; i <= 24; i++) {
    const t = i / 24;
    pts.push(new THREE.Vector2(1.35 * (1 - 0.75 * t), -0.75 - t * 7));
  }
  const g = new THREE.LatheGeometry(pts, 48);
  g.rotateZ(-Math.PI / 2); // lathe +Y → +X
  return g;
}

export class ReentryFx {
  readonly root = new THREE.Group();
  readonly light = new THREE.PointLight(0xffffff, 0, 0, 2);
  private sheath: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
  private time = 0;
  /** Camera shake amplitude (m) for the world to apply. */
  shake = 0;

  private radius: number;

  constructor(radius: number) {
    this.radius = radius;
    this.light.decay = 2;
    this.sheath = new THREE.Mesh(sheathGeometry(), sheathMaterial());
    this.sheath.frustumCulled = false;
    this.sheath.renderOrder = 3;
    this.root.add(this.sheath, this.light);
  }

  setRadius(r: number): void {
    this.radius = r;
  }

  /**
   * @param q stagnation heat flux, W/m²
   * @param qDyn dynamic pressure, Pa
   * @param flowBody air-relative velocity in the vehicle body frame (m/s)
   * @param viewFromBody rotation body → view (for the incandescence normal test)
   */
  update(dt: number, q: number, qDyn: number, flowBody: THREE.Vector3, viewFromBody: THREE.Quaternion): void {
    this.time += dt;
    const speed = flowBody.length();
    const on = q > 2e4 && speed > 1000;
    shared.qStag.value = q;
    if (speed > 1) shared.flowView.value.copy(flowBody).normalize().applyQuaternion(viewFromBody);
    this.sheath.visible = on;
    this.light.visible = on;
    this.shake = Math.min(qDyn / 40_000, 1) * 0.04 * Math.min(1, speed / 300);
    if (!on) return;
    // Sheath brightness: a fraction of the stagnation-wall emission (visual aid), tinted
    // toward the pink/orange of shock-layer emission.
    const wall = incandescenceU(wallTemperature(q));
    const k = 0.35 * Math.min(1, (q - 2e4) / 2e5);
    const tint = [1.0, 0.55, 0.62];
    const g = [0, 1, 2].map((i) => (0.6 * wall[i]! + 0.4 * (wall[0]! + wall[1]! + wall[2]!) / 3 * tint[i]!) * k);
    this.sheath.material.uniforms.glow!.value.set(g[0]!, g[1]!, g[2]!);
    this.sheath.material.uniforms.time!.value = this.time;
    // Orient: nose (+X of the sheath) along the flow, standing on the vehicle's front.
    const d = flowBody.clone().normalize();
    this.sheath.quaternion.setFromUnitVectors(new THREE.Vector3(1, 0, 0), d);
    const R = this.radius;
    this.sheath.position.copy(d).multiplyScalar(R * 0.9);
    const wake = 1 + Math.min(speed / 7000, 1.2);
    this.sheath.scale.set(R * wake, R, R);
    // Plasma light: an extended source of radiance ~glow seen over ~2π sr → irradiance ≈
    // π·L in U-equivalent; three.js light intensity is irradiance × π⁻¹ … in our U setup
    // (lights carry radiance-like units with pre-exposure), use the glow directly.
    const lum = (g[0]! + g[1]! + g[2]!) / 3;
    this.light.color.setRGB(g[0]! / Math.max(lum, 1e-9), g[1]! / Math.max(lum, 1e-9), g[2]! / Math.max(lum, 1e-9));
    this.light.intensity = Math.PI * lum * PRE_EXPOSURE.value * R * R;
    this.light.position.copy(d).multiplyScalar(R * 1.6);
  }
}
