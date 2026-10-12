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

export class SaturnRings {
  readonly mesh: THREE.Mesh;
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
        preExposure: PRE_EXPOSURE,
      },
      vertexShader: /* glsl */ `
        #include <common>
        #include <logdepthbuf_pars_vertex>
        varying vec3 vPosB;
        void main() {
          vPosB = position;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          #include <logdepthbuf_vertex>
        }`,
      fragmentShader: /* glsl */ `
        #include <common>
        #include <logdepthbuf_pars_fragment>
        ${RING_GLSL}
        uniform vec3 sunB, camB, radii, tint;
        uniform float sunE, preExposure;
        varying vec3 vPosB;
        // Saturn's shadow: does the ray p + t·s (t > 0) hit the ellipsoid?
        bool inPlanetShadow(vec3 p, vec3 s) {
          vec3 P = p / radii, S = s / radii;
          float b = dot(P, S), cc = dot(P, P) - 1.0, d = b * b - dot(S, S) * cc;
          return d > 0.0 && -b - sqrt(d) > 0.0;
        }
        void main() {
          #include <logdepthbuf_fragment>
          vec2 tw = ringAt(length(vPosB.xy));
          float tau = tw.x, w = tw.y;
          if (tau <= 0.0) discard;
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
  }

  /** Sun direction, irradiance and camera position, all in Saturn's body-fixed frame. */
  update(sunB: THREE.Vector3, irradiance: number, camB: THREE.Vector3): void {
    this.mat.uniforms.sunB!.value.copy(sunB);
    this.mat.uniforms.sunE!.value = irradiance;
    this.mat.uniforms.camB!.value.copy(camB);
  }
}
