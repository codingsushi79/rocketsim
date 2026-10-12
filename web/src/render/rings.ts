// Saturn's main rings: a radial optical-depth and albedo profile, the ring mesh, and the
// GLSL shared with the planet (ring shadow on the globe).
//
// Radii, optical-depth ranges and particle albedos: NASA NSSDC Saturnian Rings Fact Sheet,
// https://nssdc.gsfc.nasa.gov/planetary/factsheet/satringfact.html (retrieved 2026-10-12).
// The shape *within* each range is an approximation (not an occultation profile): C ring and
// Cassini Division low, B ring peaking in its middle, A ring fading outward.
//
// Brightness: single scattering in a plane-parallel slab with isotropic phase function
// (Chandrasekhar 1960, *Radiative Transfer*, Dover; as used for the rings by Cuzzi et al. 1984,
// "Saturn's rings: properties and processes", in Planetary Rings, Univ. Arizona Press):
//   lit face:   I/F = ϖ/4 · μ0/(μ+μ0) · (1 − exp(−τ(1/μ + 1/μ0)))
//   unlit face: I/F = ϖ/4 · μ0/(μ−μ0) · (exp(−τ/μ) − exp(−τ/μ0))
// with μ, μ0 the |cosines| of the view and Sun directions to the ring normal. Ring
// particles are backscattering, so isotropic P underestimates brightness near opposition.

import * as THREE from "three";
import { mergeVertices } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { PRE_EXPOSURE } from "./units";

const KM = 1000;

/** [inner radius m, outer radius m, τ at inner, τ at outer, single-scattering albedo]. */
const SEGMENTS: [number, number, number, number, number][] = [
  [74_658 * KM, 91_975 * KM, 0.05, 0.15, 0.2], // C ring (τ 0.05–0.35, albedo 0.12–0.30)
  [91_975 * KM, 104_000 * KM, 0.6, 2.5, 0.5], // B ring inner half (τ 0.4–2.5, albedo 0.4–0.6)
  [104_000 * KM, 117_507 * KM, 2.5, 1.2, 0.5], // B ring outer half
  [117_507 * KM, 122_340 * KM, 0.08, 0.1, 0.3], // Cassini Division (τ 0–0.1, albedo 0.2–0.4)
  [122_340 * KM, 133_410 * KM, 0.7, 0.5, 0.5], // A ring inside the Encke gap (τ 0.4–1.0)
  [133_735 * KM, 136_487 * KM, 0.5, 0.4, 0.5], // A ring between the Encke (~325 km) and Keeler gaps
  [136_529 * KM, 136_780 * KM, 0.4, 0.4, 0.5], // A ring outside the Keeler gap (~42 km wide)
  [139_800 * KM, 139_850 * KM, 0.1, 0.1, 0.6], // F ring (τ 0.1, albedo 0.6; ~50 km core)
];

export const RING_INNER = 74_658 * KM;
export const RING_OUTER = 140_000 * KM;
const N = 4096; // ≈ 16 km per texel

/** Radial profile texture: R = τ, G = single-scattering albedo. */
export function ringProfileTexture(): THREE.DataTexture {
  const data = new Float32Array(N * 4);
  for (let i = 0; i < N; i++) {
    const r = RING_INNER + ((i + 0.5) / N) * (RING_OUTER - RING_INNER);
    for (const [r0, r1, t0, t1, w] of SEGMENTS) {
      if (r >= r0 && r < r1) {
        const f = (r - r0) / (r1 - r0);
        data[i * 4] = t0 + (t1 - t0) * f;
        data[i * 4 + 1] = w;
      }
    }
  }
  const t = new THREE.DataTexture(data, N, 1, THREE.RGBAFormat, THREE.FloatType);
  t.minFilter = t.magFilter = THREE.LinearFilter;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.needsUpdate = true;
  return t;
}

/** Ring optical depth at body-fixed radius `r` (needs uniforms ringMap, ringRange). */
export const RING_GLSL = /* glsl */ `
  uniform sampler2D ringMap;
  uniform vec2 ringRange;
  vec2 ringAt(float r) {
    if (r < ringRange.x || r > ringRange.y) return vec2(0.0);
    return texture2D(ringMap, vec2((r - ringRange.x) / (ringRange.y - ringRange.x), 0.5)).rg;
  }
  // Transmission of sunlight from body-fixed point p through the ring plane (z = 0).
  float ringShadow(vec3 p, vec3 sunB) {
    if (abs(sunB.z) < 1e-6 || p.z * sunB.z >= 0.0) return 1.0;
    vec3 q = p - sunB * (p.z / sunB.z);
    return exp(-ringAt(length(q.xy)).x / abs(sunB.z));
  }
`;

/** Ring particle tint, sRGB-ish linear (approximate, from Cassini true-colour images). */
const RING_TINT = new THREE.Color(1.0, 0.9, 0.76);

// Ring particle size distribution and tiers (see RingParticles below).
const A_MIN = 0.01, A_MAX = 5;
const MEAN_A2 = Math.log(A_MAX / A_MIN) / ((A_MIN ** -2 - A_MAX ** -2) / 2);
const LAYER = 10;
const TIER_A0 = 0.02;
const TIERS = 8; // 0.02 … 5.12 m
const RANGE_PER_RADIUS = 150; // tier visible to 150 × its smallest radius
const MAX_PARTICLES = 60_000;

/** Radius of the high-precision patch under the camera (m). */
const PATCH_R = 100_000;
const PATCH_SEGMENTS = 96;

export class SaturnRings {
  readonly mesh: THREE.Mesh;
  /** The ring plane near the camera, positioned in f64 on the CPU: the big mesh's vertices
   *  are ~1.4e8 m from its origin, quantised by float32 to ±8–16 m, which shows as a
   *  stepped, jittering plane close up (floating-origin precision). */
  readonly patch: THREE.Mesh;
  private mat: THREE.ShaderMaterial;

  constructor(profile: THREE.Texture, a: number, c: number) {
    const g = new THREE.RingGeometry(RING_INNER, RING_OUTER, 512, 1);
    this.mat = new THREE.ShaderMaterial({
      uniforms: {
        ringMap: { value: profile },
        ringRange: { value: new THREE.Vector2(RING_INNER, RING_OUTER) },
        sunB: { value: new THREE.Vector3(1, 0, 0) },
        camB: { value: new THREE.Vector3(0, 0, 1) },
        sunE: { value: 1 },
        radii: { value: new THREE.Vector3(a, a, c) },
        tint: { value: RING_TINT },
        handover: { value: 0 },
        patchCenter: { value: new THREE.Vector2() },
        patchR: { value: 0 },
        preExposure: PRE_EXPOSURE,
      },
      vertexShader: /* glsl */ `
        #include <common>
        #include <logdepthbuf_pars_vertex>
        uniform vec2 patchCenter;
        varying vec3 vPosB;
        void main() {
          #ifdef PATCH
          vPosB = vec3(patchCenter, 0.0) + position;
          #else
          vPosB = position;
          #endif
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          #include <logdepthbuf_vertex>
        }`,
      fragmentShader: /* glsl */ `
        #include <common>
        #include <logdepthbuf_pars_fragment>
        ${RING_GLSL}
        uniform vec3 sunB, camB, radii, tint;
        uniform float sunE, preExposure, handover, patchR;
        uniform vec2 patchCenter;
        varying vec3 vPosB;
        // Saturn's shadow: does the ray p + t·s (t > 0) hit the ellipsoid?
        bool inPlanetShadow(vec3 p, vec3 s) {
          vec3 P = p / radii, S = s / radii;
          float b = dot(P, S), cc = dot(P, P) - 1.0, d = b * b - dot(S, S) * cc;
          return d > 0.0 && -b - sqrt(d) > 0.0;
        }
        void main() {
          #include <logdepthbuf_fragment>
          // The patch draws exactly the disc of radius patchR; the big mesh everything else.
          if (patchR > 0.0) {
            float dp = distance(vPosB.xy, patchCenter);
            #ifdef PATCH
            if (dp > patchR) discard;
            #else
            if (dp < patchR) discard;
            #endif
          }
          vec2 tw = ringAt(length(vPosB.xy));
          float tau = tw.x, w = tw.y;
          if (tau <= 0.0) discard;
          // Near the camera the larger particles are drawn individually (RingParticles):
          // the sheet keeps only the unresolved ones. With n(a) ∝ a⁻³ the cross-section is
          // uniform in ln a, so the unresolved fraction is ln(a_res/a_min)/ln(a_max/a_min),
          // a_res = distance / RANGE_PER_RADIUS (the smallest particle drawn there).
          if (handover > 0.0) {
            // Close to the 10 m particle layer the sheet is seen edge-on, where a 2-D plane
            // turns into an opaque smoky slab through the camera: there, near the camera,
            // the individual particles alone represent the ring.
            float nearPlane = 1.0 - smoothstep(${(LAYER * 3).toFixed(1)}, ${(LAYER * 60).toFixed(1)}, abs(camB.z));
            float dc = distance(vPosB, camB);
            float hole = mix(1.0, smoothstep(0.5 * handover, 2.0 * handover, dc), nearPlane);
            if (hole <= 0.0) discard;
            tau *= hole;
            float ares = max(dc / ${RANGE_PER_RADIUS.toFixed(1)}, ${A_MIN});
            tau *= clamp(log(ares / ${A_MIN}) / log(${A_MAX.toFixed(1)} / ${A_MIN}), 0.0, 1.0);
            if (tau <= 0.0) discard;
          }
          vec3 v = normalize(camB - vPosB);
          float mu = max(abs(v.z), 1e-3), mu0 = max(abs(sunB.z), 1e-3);
          float IF;
          if (v.z * sunB.z > 0.0) {
            IF = w / 4.0 * mu0 / (mu + mu0) * (1.0 - exp(-tau * (1.0 / mu + 1.0 / mu0)));
          } else if (abs(mu - mu0) > 1e-3) {
            IF = w / 4.0 * mu0 / (mu - mu0) * (exp(-tau / mu) - exp(-tau / mu0));
          } else {
            IF = w / 4.0 * tau / mu0 * exp(-tau / mu0);
          }
          if (inPlanetShadow(vPosB, sunB)) IF = 0.0;
          float alpha = 1.0 - exp(-tau / mu);

          // Premultiplied: the ring's own radiance plus the background attenuated by e^(−τ/μ).
          gl_FragColor = vec4(tint * IF * sunE * preExposure, alpha);
        }`,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      blendSrcAlpha: THREE.OneFactor,
      blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
    });
    this.mesh = new THREE.Mesh(g, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2;
    const pm = this.mat.clone();
    pm.uniforms = this.mat.uniforms; // shared, so updates reach both
    pm.defines = { PATCH: 1 };
    // Circumscribed polygon, so the shader's exact circle is fully covered.
    this.patch = new THREE.Mesh(new THREE.CircleGeometry(PATCH_R / Math.cos(Math.PI / PATCH_SEGMENTS), PATCH_SEGMENTS), pm);
    this.patch.frustumCulled = false;
    this.patch.renderOrder = 2;
    this.patch.visible = false;
  }

  /** Place the patch under the camera. `camB`: camera in Saturn's body frame; `saturn`:
   *  Saturn's centre in render space; `q`: body → ICRF. Computed in f64 here. */
  placePatch(camB: THREE.Vector3, saturn: THREE.Vector3, q: THREE.Quaternion): void {
    const rc = Math.hypot(camB.x, camB.y);
    const on = Math.abs(camB.z) < PATCH_R * 0.5 && rc > RING_INNER - PATCH_R && rc < RING_OUTER + PATCH_R;
    this.patch.visible = on;
    this.mat.uniforms.patchR!.value = on ? PATCH_R : 0;
    if (!on) return;
    this.mat.uniforms.patchCenter!.value.set(camB.x, camB.y);
    const o = new THREE.Vector3(camB.x, camB.y, 0).applyQuaternion(q);
    this.patch.position.copy(saturn).add(o);
    this.patch.quaternion.copy(q);
  }

  /** Sun direction, irradiance and camera position, all in Saturn's body-fixed frame. */
  update(sunB: THREE.Vector3, irradiance: number, camB: THREE.Vector3, handover = 0): void {
    this.mat.uniforms.handover!.value = handover;
    this.mat.uniforms.sunB!.value.copy(sunB);
    this.mat.uniforms.sunE!.value = irradiance;
    this.mat.uniforms.camB!.value.copy(camB);
  }
}

/** Normal optical depth and single-scattering albedo at radius r (m), from SEGMENTS. */
export function ringTauAt(r: number): [number, number] {
  for (const [r0, r1, t0, t1, w] of SEGMENTS) if (r >= r0 && r < r1) return [t0 + ((t1 - t0) * (r - r0)) / (r1 - r0), w];
  return [0, 0];
}

// Individual ring particles near the camera.
//
// Sizes: n(a) ∝ a⁻³ for radii 1 cm … 5 m (Voyager radio occultation, Zebker, Marouf & Tyler
// 1985, Icarus 64:531; Cuzzi et al. 2009, in *Saturn from Cassini–Huygens*, ch. 15). The
// number per area follows the local normal optical depth: τ = N·π⟨a²⟩. Vertical: a layer
// ~10 m thick (fact sheet: 5–30 m). Orbits: circular Keplerian, Ω(r) = √(GM/r³), so the
// field shears realistically. Rendering: size octaves (tiers) appear within a distance
// proportional to their size (every resolved particle ≥ ~10 px), so each tier costs about
// the same number of instances; particles are placed by a deterministic hash per cell in
// co-moving coordinates (r, θ − Ω(r)·t), stable from frame to frame.


function hash32(a: number, b: number, c: number, d: number): number {
  let h = (a * 374761393 + b * 668265263 + c * 2147483647 + d * 1274126177) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return (h ^ (h >>> 16)) >>> 0;
}
function rng(seed: number): () => number {
  let s = seed || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

export class RingParticles {
  readonly mesh: THREE.InstancedMesh;
  private mat: THREE.ShaderMaterial;
  private dummy = new THREE.Object3D();
  /** Distance from the camera within which the ring sheet hands over to particles (m). */
  readonly handover = TIER_A0 * 2 ** (TIERS - 1) * RANGE_PER_RADIUS;

  constructor(private gm: number, a: number, c: number) {
    // Indexed (merged) so the displaced rock gets smooth normals, not flat facets.
    const g = mergeVertices(new THREE.IcosahedronGeometry(1, 2).deleteAttribute("normal").deleteAttribute("uv"));
    // Lumpy rocks: displace vertices by a few hashed amounts.
    const p = g.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < p.count; i++) {
      const v = new THREE.Vector3().fromBufferAttribute(p, i);
      // Smooth lumps: a few low-order waves over the sphere (rubble-pile shapes).
      const k = 1 + 0.18 * Math.sin(3.1 * v.x + 1.7) * Math.cos(2.3 * v.y - 0.4) + 0.12 * Math.sin(4.7 * v.z + 2.9 * v.x) + 0.06 * Math.cos(9.1 * v.y + 5.3 * v.z);
      p.setXYZ(i, v.x * k, v.y * k, v.z * k);
    }
    g.computeVertexNormals();
    this.mat = new THREE.ShaderMaterial({
      uniforms: {
        sunDir: { value: new THREE.Vector3(1, 0, 0) },
        sunE: { value: 1 },
        saturn: { value: new THREE.Vector3() },
        radii: { value: new THREE.Vector3(a, a, c) },
        tint: { value: RING_TINT },
        preExposure: PRE_EXPOSURE,
      },
      vertexShader: /* glsl */ `
        #include <common>
        #include <logdepthbuf_pars_vertex>
        attribute float albedo;
        uniform vec3 sunDir, saturn, radii;
        varying vec3 vN;
        varying float vA;
        varying float vLit;
        // Saturn's shadow at the particle (ray toward the Sun vs the ellipsoid; axes are
        // ICRF here, so this uses the sphere of the equatorial radius: ~1% at the poles).
        float lit(vec3 p) {
          vec3 o = p - saturn;
          float b = dot(o, sunDir), cc = dot(o, o) - radii.x * radii.x, d = b * b - cc;
          return (d > 0.0 && -b - sqrt(d) > 0.0) ? 0.0 : 1.0;
        }
        void main() {
          vec4 wp = modelMatrix * instanceMatrix * vec4(position, 1.0);
          vN = normalize(mat3(modelMatrix) * mat3(instanceMatrix) * normal);
          vA = albedo;
          vLit = lit((modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz);
          gl_Position = projectionMatrix * viewMatrix * wp;
          #include <logdepthbuf_vertex>
        }`,
      fragmentShader: /* glsl */ `
        #include <common>
        #include <logdepthbuf_pars_fragment>
        uniform vec3 sunDir, tint;
        uniform float sunE, preExposure;
        varying vec3 vN;
        varying float vA;
        varying float vLit;
        void main() {
          #include <logdepthbuf_fragment>
          float ndl = max(dot(normalize(vN), sunDir), 0.0);
          // Lambertian icy regolith; a little ring-shine fill (the lit ring around them).
          vec3 L = tint * vA * sunE * (ndl * vLit + 0.02);
          gl_FragColor = vec4(L * preExposure, 1.0);
        }`,
    });
    this.mesh = new THREE.InstancedMesh(g, this.mat, MAX_PARTICLES);
    this.mesh.geometry.setAttribute("albedo", new THREE.InstancedBufferAttribute(new Float32Array(MAX_PARTICLES), 1));
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
  }

  /**
   * @param camS camera position relative to Saturn's centre (ICRF, m)
   * @param pole Saturn's pole (ICRF unit vector)
   * @param t TDB seconds (any fixed origin)
   * @param saturnRender Saturn's centre in render space (camera at the origin)
   */
  update(camS: THREE.Vector3, pole: THREE.Vector3, t: number, saturnRender: THREE.Vector3, sunDir: THREE.Vector3, sunE: number): void {
    this.mat.uniforms.sunDir!.value.copy(sunDir);
    this.mat.uniforms.sunE!.value = sunE;
    this.mat.uniforms.saturn!.value.copy(saturnRender);
    // Inertial ring frame: e1 toward the equator's node on the ICRF equator.
    const e1 = new THREE.Vector3(0, 0, 1).cross(pole).normalize();
    const e2 = new THREE.Vector3().crossVectors(pole, e1);
    const zc = camS.dot(pole);
    const xc = camS.dot(e1), yc = camS.dot(e2);
    const rc = Math.hypot(xc, yc);
    const maxRange = this.handover;
    let n = 0;
    if (Math.abs(zc) < maxRange && rc > RING_INNER - maxRange && rc < RING_OUTER + maxRange) {
      const thc = Math.atan2(yc, xc);
      const albedo = this.mesh.geometry.getAttribute("albedo") as THREE.InstancedBufferAttribute;
      for (let k = 0; k < TIERS && n < MAX_PARTICLES; k++) {
        const a0 = TIER_A0 * 2 ** k, a1 = 2 * a0;
        const D = a0 * RANGE_PER_RADIUS;
        const horiz = Math.sqrt(Math.max(0, D * D - zc * zc));
        if (horiz <= 0) continue;
        const L = D / 4;
        // Fraction of the particle number in this tier (n ∝ a⁻³ → N(>a) ∝ a⁻²).
        const frac = (a0 ** -2 - a1 ** -2) / (A_MIN ** -2 - A_MAX ** -2);
        const i0 = Math.floor((rc - horiz) / L), i1 = Math.floor((rc + horiz) / L);
        for (let i = i0; i <= i1 && n < MAX_PARTICLES; i++) {
          const rRow = (i + 0.5) * L;
          const [tau, w] = ringTauAt(rRow);
          if (tau <= 0) continue;
          const perCell = (tau / (Math.PI * MEAN_A2)) * frac * L * L;
          const nRow = Math.max(1, Math.round((2 * Math.PI * rRow) / L));
          const dPhi = (2 * Math.PI) / nRow;
          const omega = Math.sqrt(this.gm / rRow ** 3);
          // Co-moving angle of the camera in this row, wrapped (f64: Ω·t ~ 1e5 rad).
          const shift = (omega * t) % (2 * Math.PI);
          const phiCam = thc - shift;
          const span = Math.ceil(horiz / L) + 1;
          const jc = Math.floor(((phiCam % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI) / dPhi);
          for (let jj = jc - span; jj <= jc + span && n < MAX_PARTICLES; jj++) {
            const j = ((jj % nRow) + nRow) % nRow;
            const rand = rng(hash32(k, i, j, 7919));
            // Poisson-ish: floor(mean) plus one more with the fractional probability.
            let count = Math.floor(perCell);
            if (rand() < perCell - count) count++;
            for (let m = 0; m < count && n < MAX_PARTICLES; m++) {
              const r = rRow + (rand() - 0.5) * L;
              const phi = (j + rand()) * dPhi;
              const z = (rand() - 0.5) * LAYER;
              const a = 1 / Math.sqrt(a0 ** -2 - rand() * (a0 ** -2 - a1 ** -2));
              // The row's angular rate for every particle in it: with the particle's own
              // rate, ~27 years of Keplerian shear since the epoch origin would smear a
              // cell around the ring. The error, 1.5·Ω·Δr ≈ 1 cm/s, is invisible; rows
              // still shear against each other.
              const th = phi + shift;
              const px = r * Math.cos(th), py = r * Math.sin(th);
              // Relative to the camera, in ICRF.
              const dx = px - xc, dy = py - yc, dz = z - zc;
              if (dx * dx + dy * dy + dz * dz > D * D) {
                for (let q = 0; q < 7; q++) rand(); // keep the draw sequence fixed
                continue;
              }
              const pos = new THREE.Vector3().addScaledVector(e1, dx).addScaledVector(e2, dy).addScaledVector(pole, dz);
              this.dummy.position.copy(pos);
              this.dummy.rotation.set(rand() * 6.283, rand() * 6.283, rand() * 6.283);
              // Elongated rubble: independent stretches per axis.
              this.dummy.scale.set(a * (0.7 + 0.6 * rand()), a * (0.7 + 0.6 * rand()), a * (0.7 + 0.6 * rand()));
              this.dummy.updateMatrix();
              this.mesh.setMatrixAt(n, this.dummy.matrix);
              albedo.setX(n, w * (0.75 + 0.5 * rand()));
              n++;
            }
          }
        }
      }
      albedo.needsUpdate = true;
    }
    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.mesh.visible = n > 0;
  }
}
