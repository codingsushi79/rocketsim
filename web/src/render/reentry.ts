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
// 2. Plasma envelope (approximate, Firefly-style): flame layers shaped by the hull and
//    streaming off it downstream, plus sparks. Real shock-layer radiation is
//    non-equilibrium and not modelled; brightness and colour are tied to the wall emission.
//    A visual aid, labelled as such.
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

/** Number of flame-envelope layers per hull mesh. */
const LAYERS = 4;

/**
 * Plasma envelope in the style of KSP's Firefly: each hull mesh is drawn again LAYERS
 * times, its leeward vertices extruded downstream along the airflow (longer for outer
 * layers), so the flame follows the vehicle's own shape and trails off its edges. Turbulent
 * streaks scroll along the flow. Colour follows the stagnation-wall temperature (orange) and
 * shifts toward a pink-white core at high heating (N₂⁺/O/ablation-product emission in entry
 * footage). Brightness is tied to the wall emission: a visual aid, not a radiation model.
 */
function envelopeMaterial(layer: number, u: EnvelopeUniforms): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { ...u, layer: { value: layer } },
    vertexShader: /* glsl */ `
      #include <common>
      #include <logdepthbuf_pars_vertex>
      uniform vec3 flowW;      // unit air-relative velocity, world axes (the front faces it)
      uniform float len, size, time, layer;
      varying float vLee, vAlong, vFacing, vSeed;
      varying vec3 vW;
      float h(vec3 p) { return fract(sin(dot(p, vec3(12.9898, 78.233, 37.719))) * 43758.5453); }
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vec3 n = normalize(mat3(modelMatrix) * normal);
        float facing = dot(n, flowW);
        // Leeward vertices stream downstream; windward ones only puff out a little.
        float lee = smoothstep(0.35, -0.5, facing);
        float l = len * (0.25 + 0.75 * (layer + 1.0) / ${LAYERS}.0);
        float jitter = 0.7 + 0.6 * h(floor(position * 4.0) + layer);
        float wobble = 0.85 + 0.15 * sin(time * 23.0 + dot(position, vec3(3.1, 4.7, 2.3)) + layer * 1.7);
        float ext = l * lee * jitter * wobble;
        wp.xyz += n * size * (0.06 + 0.05 * layer) - flowW * ext;
        vLee = lee;
        vAlong = ext / max(len, 1e-3);
        vFacing = facing;
        vSeed = h(floor(position * 6.0));
        vW = position;
        vec4 mv = viewMatrix * wp;
        gl_Position = projectionMatrix * mv;
        #include <logdepthbuf_vertex>
      }`,
    fragmentShader: /* glsl */ `
      #include <common>
      #include <logdepthbuf_pars_fragment>
      uniform vec3 hot, cool;
      uniform float intensity, time, layer, preExposure;
      varying float vLee, vAlong, vFacing, vSeed;
      varying vec3 vW;
      float h(vec3 p) { return fract(sin(dot(p, vec3(12.9898, 78.233, 37.719))) * 43758.5453); }
      float noise(vec3 p) {
        vec3 i = floor(p), f = fract(p);
        f = f * f * (3.0 - 2.0 * f);
        return mix(mix(mix(h(i), h(i + vec3(1,0,0)), f.x), mix(h(i + vec3(0,1,0)), h(i + vec3(1,1,0)), f.x), f.y),
                   mix(mix(h(i + vec3(0,0,1)), h(i + vec3(1,0,1)), f.x), mix(h(i + vec3(0,1,1)), h(i + vec3(1,1,1)), f.x), f.y), f.z);
      }
      void main() {
        #include <logdepthbuf_fragment>
        float a = clamp(vAlong, 0.0, 1.0);
        // Streaks: stretched noise scrolling downstream; flicker per layer.
        float streak = noise(vec3(vW.yz * 5.0 + vSeed * 3.0, a * 3.0 - time * 6.0 + layer));
        streak = 0.35 + 1.3 * pow(streak, 2.0);
        float fade = (1.0 - a) * (1.0 - a);
        // The windward cap glows hot; the trailing flame cools toward orange-red.
        float cap = smoothstep(0.2, 0.9, vFacing);
        vec3 c = mix(cool, hot, clamp(cap + (1.0 - a) * 0.5, 0.0, 1.0));
        float w = intensity * streak * fade * (0.35 + 0.65 * (1.0 - layer / ${LAYERS}.0)) * (0.25 + 0.75 * max(vLee, cap));
        gl_FragColor = vec4(c * w * preExposure, 1.0);
      }`,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
}

interface EnvelopeUniforms {
  flowW: { value: THREE.Vector3 };
  len: { value: number };
  size: { value: number };
  time: { value: number };
  intensity: { value: number };
  hot: { value: THREE.Color };
  cool: { value: THREE.Color };
  preExposure: { value: number };
}

/** Sparks: hot ablation particles shed off the windward rim and carried downstream. */
const SPARKS = 400;

export class ReentryFx {
  readonly root = new THREE.Group();
  readonly light = new THREE.PointLight(0xffffff, 0, 0, 2);
  private time = 0;
  /** Camera shake amplitude (m) for the world to apply. */
  shake = 0;
  private radius: number;
  private u: EnvelopeUniforms = {
    flowW: { value: new THREE.Vector3(1, 0, 0) },
    len: { value: 10 },
    size: { value: 2 },
    time: { value: 0 },
    intensity: { value: 0 },
    hot: { value: new THREE.Color(1, 0.8, 0.85) },
    cool: { value: new THREE.Color(1, 0.35, 0.1) },
    preExposure: PRE_EXPOSURE,
  };
  private materials: THREE.ShaderMaterial[] = [];
  private shells: THREE.Mesh[] = [];
  private sparks: THREE.Points;
  private sparkState = new Float32Array(SPARKS * 4); // body-frame position (3), age
  private sparkVel = new Float32Array(SPARKS * 3);

  constructor(radius: number) {
    this.radius = radius;
    this.light.decay = 2;
    for (let k = 0; k < LAYERS; k++) this.materials.push(envelopeMaterial(k, this.u));
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(SPARKS * 3), 3));
    g.setAttribute("age", new THREE.BufferAttribute(new Float32Array(SPARKS), 1));
    this.sparks = new THREE.Points(
      g,
      new THREE.ShaderMaterial({
        uniforms: { intensity: this.u.intensity, preExposure: PRE_EXPOSURE, cool: this.u.cool },
        vertexShader: /* glsl */ `
          #include <common>
          #include <logdepthbuf_pars_vertex>
          attribute float age;
          varying float vAge;
          void main() {
            vAge = age;
            vec4 mv = modelViewMatrix * vec4(position, 1.0);
            gl_PointSize = clamp(60.0 / -mv.z, 1.5, 6.0);
            gl_Position = projectionMatrix * mv;
            #include <logdepthbuf_vertex>
          }`,
        fragmentShader: /* glsl */ `
          #include <common>
          #include <logdepthbuf_pars_fragment>
          uniform float intensity, preExposure;
          uniform vec3 cool;
          varying float vAge;
          void main() {
            #include <logdepthbuf_fragment>
            vec2 d = gl_PointCoord - 0.5;
            float r = 1.0 - smoothstep(0.2, 0.5, length(d));
            float life = 1.0 - clamp(vAge, 0.0, 1.0);
            vec3 c = mix(cool, vec3(1.0, 0.9, 0.7), life);
            gl_FragColor = vec4(c * r * life * intensity * 3.0 * preExposure, 1.0);
          }`,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    this.sparks.frustumCulled = false;
    this.sparkState.fill(2); // all expired
    this.root.add(this.sparks, this.light);
  }

  setRadius(r: number): void {
    this.radius = r;
  }

  /** Attach envelope layers to the vehicle's hull meshes (children: they follow staging). */
  attach(meshes: THREE.Mesh[]): void {
    for (const m of meshes) {
      for (const mat of this.materials) {
        const s = new THREE.Mesh(m.geometry, mat);
        s.frustumCulled = false;
        s.renderOrder = 5;
        s.visible = false;
        m.add(s);
        this.shells.push(s);
      }
    }
  }

  /**
   * @param q stagnation heat flux, W/m²
   * @param qDyn dynamic pressure, Pa
   * @param flowBody air-relative velocity in the vehicle body frame (m/s)
   * @param viewFromBody rotation body → view (for the incandescence normal test)
   * @param bodyToWorld rotation body → world (render axes)
   */
  update(dt: number, q: number, qDyn: number, flowBody: THREE.Vector3, viewFromBody: THREE.Quaternion, bodyToWorld = new THREE.Quaternion()): void {
    this.time += dt;
    const speed = flowBody.length();
    const on = q > 3e4 && speed > 1000;
    shared.qStag.value = q;
    if (speed > 1) shared.flowView.value.copy(flowBody).normalize().applyQuaternion(viewFromBody);
    for (const s of this.shells) s.visible = on;
    this.sparks.visible = on;
    this.light.visible = on;
    this.shake = Math.min(qDyn / 40_000, 1) * 0.04 * Math.min(1, speed / 300);
    if (!on) return;
    const R = this.radius;
    const dBody = flowBody.clone().normalize();
    this.u.flowW.value.copy(dBody).applyQuaternion(bodyToWorld);
    this.u.time.value = this.time;
    this.u.size.value = R;
    // Flame length grows with heating and speed: a few vehicle radii up to ~6.
    const heat = Math.min(1, Math.log10(q / 3e4) / Math.log10(2e6 / 3e4));
    this.u.len.value = R * (1.5 + 5 * heat) * Math.min(1, speed / 6000);
    // Colours: the wall's incandescent colour (orange) and a hotter pink-white core.
    const wall = incandescenceU(wallTemperature(q));
    const wl = Math.max(wall[0], 1e-9);
    // Saturated plasma colours (entry footage: deep orange flame, yellow-white at the shield).
    this.u.cool.value.setRGB(1, Math.min(0.5, 0.25 + wall[1] / wl), 0.05 + 0.05 * heat);
    this.u.hot.value.setRGB(1, 0.62 + 0.15 * heat, 0.3 + 0.2 * heat);
    // Brightness: a fraction of the stagnation-wall radiance (visual aid), smoothly on.
    this.u.intensity.value = (0.08 * (wall[0] + wall[1] + wall[2]) / 3 + 0.18 * heat) * Math.min(1, (q - 3e4) / 1e5);
    // Sparks: respawn at the windward rim, drift downstream and outward.
    const pos = this.sparks.geometry.getAttribute("position") as THREE.BufferAttribute;
    const age = this.sparks.geometry.getAttribute("age") as THREE.BufferAttribute;
    const P = pos.array as Float32Array, A = age.array as Float32Array;
    const side = new THREE.Vector3(0, 1, 0).cross(dBody);
    if (side.lengthSq() < 1e-6) side.set(0, 0, 1).cross(dBody);
    side.normalize();
    const side2 = new THREE.Vector3().crossVectors(dBody, side);
    const spawnRate = 400 * heat;
    let toSpawn = spawnRate * dt;
    for (let i = 0; i < SPARKS; i++) {
      const s = this.sparkState;
      s[i * 4 + 3] = s[i * 4 + 3]! + dt / 0.6;
      if (s[i * 4 + 3]! >= 1 && toSpawn > 0) {
        toSpawn -= 1;
        const a = Math.random() * Math.PI * 2;
        const rim = new THREE.Vector3().addScaledVector(side, Math.cos(a) * R).addScaledVector(side2, Math.sin(a) * R).addScaledVector(dBody, R * 0.3);
        s.set([rim.x, rim.y, rim.z, Math.random() * 0.2], i * 4);
        const v = dBody.clone().multiplyScalar(-(25 + 40 * Math.random()) * (1 + heat)).addScaledVector(rim.clone().normalize(), 3 + 4 * Math.random());
        this.sparkVel.set([v.x, v.y, v.z], i * 3);
      }
      for (let c = 0; c < 3; c++) s[i * 4 + c] = s[i * 4 + c]! + this.sparkVel[i * 3 + c]! * dt;
      P[i * 3] = s[i * 4]!;
      P[i * 3 + 1] = s[i * 4 + 1]!;
      P[i * 3 + 2] = s[i * 4 + 2]!;
      A[i] = s[i * 4 + 3]!;
    }
    pos.needsUpdate = true;
    age.needsUpdate = true;
    // Plasma light on the vehicle, from the windward side.
    const lum = this.u.intensity.value;
    this.light.color.copy(this.u.cool.value).lerp(this.u.hot.value, 0.5);
    this.light.intensity = Math.PI * lum * 0.3 * PRE_EXPOSURE.value * R * R;
    this.light.position.copy(dBody).multiplyScalar(R * 1.6);
  }
}
