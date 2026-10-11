// Atmospheric scattering post-pass (spec §3: physically based).
//
// Single scattering by ray marching along each pixel ray through a spherical atmosphere,
// with a secondary march toward the Sun for transmittance (Nishita et al. 1993; O'Neil,
// GPU Gems 2 ch. 16). The model uses Bruneton's Earth parameters (E. Bruneton, "A
// Qualitative and Quantitative Evaluation of 8 Clear Sky Models", IEEE TVCG 2017;
// reference implementation constants):
// - Rayleigh β = (5.802, 13.558, 33.1)e-6 /m, H = 8 km
// - Mie β_s = 3.996e-6 /m, β_e = 4.40e-6 /m, H = 1.2 km, g = 0.8
// - Ozone σ_a = (0.650, 1.881, 0.085)e-6 /m, tent profile centered at 25 km, 15 km half-width
//
// Reads the scene depth, so geometry is attenuated (aerial perspective) and nothing
// behind an object is in-scattered. Multiple scattering (Bruneton's precomputed
// tables) is the planned M7 upgrade; single scattering underestimates twilight and
// deep-shadow sky brightness.

import * as THREE from "three";
import { FullScreenQuad } from "three/examples/jsm/postprocessing/Pass.js";
import type { ActiveDepth } from "./engine";
import { DEPTH_GLSL, QUAD_VS } from "./glsl";
import { PRE_EXPOSURE } from "./units";

export interface AtmosphereParams {
  /** Planet center relative to the camera, m (render space). */
  center: THREE.Vector3;
  /** Ground and atmosphere-top radii, m. */
  groundRadius: number;
  topRadius: number;
  /** Unit vector toward the Sun (render space). */
  sunDir: THREE.Vector3;
  /** Solar irradiance at the planet in units of E☉(1 au). */
  sunIrradiance: number;
}

const FS = /* glsl */ `
  precision highp float;
  uniform sampler2D colorTex;
  uniform sampler2D depthTex;
  uniform mat4 camWorld;
  uniform vec3 center;
  uniform float rGround, rTop;
  uniform vec3 sunDir;
  uniform float sunE;
  uniform int steps;
  uniform float preExposure;
  uniform bool enabled;
  varying vec2 vUv;
  ${DEPTH_GLSL}

  const vec3 BETA_R = vec3(5.802e-6, 13.558e-6, 33.1e-6);
  const float H_R = 8000.0;
  const float BETA_M_S = 3.996e-6;
  const float BETA_M_E = 4.40e-6;
  const float H_M = 1200.0;
  const float G = 0.8;
  const vec3 BETA_O = vec3(0.650e-6, 1.881e-6, 0.085e-6);
  const float PI = 3.14159265358979;

  // Ray–sphere intersection, ray origin o (relative to the sphere center), unit dir d.
  // Returns (t0, t1) with t0 <= t1, or (1, −1) on a miss.
  vec2 hit(vec3 o, vec3 d, float r) {
    float b = dot(o, d);
    float c = dot(o, o) - r * r;
    float disc = b * b - c;
    if (disc < 0.0) return vec2(1.0, -1.0);
    float s = sqrt(disc);
    return vec2(-b - s, -b + s);
  }

  // Densities (Rayleigh, Mie, ozone) at altitude h.
  vec3 density(float h) {
    float o = max(0.0, 1.0 - abs(h - 25000.0) / 15000.0);
    return vec3(exp(-h / H_R), exp(-h / H_M), o);
  }

  vec3 extinction(vec3 d) {
    return BETA_R * d.x + vec3(BETA_M_E) * d.y + BETA_O * d.z;
  }

  // Optical depth from point p toward the Sun, or a huge value if the ground blocks it.
  vec3 sunOpticalDepth(vec3 p, int n) {
    vec2 g = hit(p, sunDir, rGround);
    if (g.x > 0.0 && g.y > 0.0) return vec3(1e9);
    vec2 a = hit(p, sunDir, rTop);
    float len = max(a.y, 0.0);
    float ds = len / float(n);
    vec3 acc = vec3(0.0);
    for (int i = 0; i < 64; i++) {
      if (i >= n) break;
      vec3 q = p + sunDir * (ds * (float(i) + 0.5));
      acc += density(length(q) - rGround) * ds;
    }
    return acc;
  }

  void main() {
    vec4 scene = texture2D(colorTex, vUv);
    if (!enabled) { gl_FragColor = scene; return; }
    vec2 ndc = vUv * 2.0 - 1.0;
    vec4 vd = projInv * vec4(ndc, 0.5, 1.0);
    vec3 viewDir = normalize(vd.xyz / vd.w);
    vec3 dir = normalize((camWorld * vec4(viewDir, 0.0)).xyz);
    // Distance to the scene surface along this ray.
    float vz = viewDepth(texture2D(depthTex, vUv).r, ndc);
    float sceneDist = vz / max(-viewDir.z, 1e-6);

    vec3 o = -center; // camera position relative to the planet center
    vec2 a = hit(o, dir, rTop);
    if (a.y <= 0.0 || a.x > a.y) { gl_FragColor = scene; return; }
    float t0 = max(a.x, 0.0);
    float t1 = a.y;
    vec2 g = hit(o, dir, rGround);
    if (g.x > 0.0) t1 = min(t1, g.x);
    t1 = min(t1, sceneDist);
    if (t1 <= t0) { gl_FragColor = scene; return; }

    int n = steps;
    int nl = max(steps / 4, 4);
    float ds = (t1 - t0) / float(n);
    float mu = dot(dir, sunDir);
    float pr = 3.0 / (16.0 * PI) * (1.0 + mu * mu);
    float pm = 3.0 / (8.0 * PI) * ((1.0 - G * G) * (1.0 + mu * mu)) / ((2.0 + G * G) * pow(1.0 + G * G - 2.0 * G * mu, 1.5));
    vec3 odView = vec3(0.0);
    vec3 inscatter = vec3(0.0);
    for (int i = 0; i < 128; i++) {
      if (i >= n) break;
      vec3 p = o + dir * (t0 + ds * (float(i) + 0.5));
      vec3 dens = density(length(p) - rGround);
      odView += dens * ds * 0.5;
      vec3 odSun = sunOpticalDepth(p, nl);
      vec3 tr = exp(-(extinction(odView) + extinction(odSun)));
      inscatter += tr * (BETA_R * dens.x * pr + vec3(BETA_M_S) * dens.y * pm) * ds;
      odView += dens * ds * 0.5;
    }
    vec3 transmittance = exp(-extinction(odView));
    // Radiance in U: L = π·E·∫ T β P ds  (U = E☉/π per sr; see units.ts).
    vec3 L = PI * sunE * inscatter * preExposure;
    gl_FragColor = vec4(scene.rgb * transmittance + L, 1.0);
  }
`;

export class AtmospherePass {
  private quad: FullScreenQuad;
  private mat: THREE.ShaderMaterial;

  constructor() {
    this.mat = new THREE.ShaderMaterial({
      uniforms: {
        colorTex: { value: null },
        depthTex: { value: null },
        camWorld: { value: new THREE.Matrix4() },
        projInv: { value: new THREE.Matrix4() },
        depthMode: { value: 0 },
        logDepthFC: { value: 1 },
        center: { value: new THREE.Vector3() },
        rGround: { value: 6_371_000 },
        rTop: { value: 6_471_000 },
        sunDir: { value: new THREE.Vector3(1, 0, 0) },
        sunE: { value: 1 },
        steps: { value: 32 },
        enabled: { value: false },
        preExposure: PRE_EXPOSURE,
      },
      vertexShader: QUAD_VS,
      fragmentShader: FS,
      depthTest: false,
      depthWrite: false,
    });
    this.quad = new FullScreenQuad(this.mat);
  }

  render(
    r: THREE.WebGLRenderer,
    src: THREE.WebGLRenderTarget,
    dst: THREE.WebGLRenderTarget,
    camera: THREE.PerspectiveCamera,
    depth: ActiveDepth,
    p: AtmosphereParams | null,
    steps: number,
  ): void {
    const u = this.mat.uniforms;
    u.colorTex!.value = src.texture;
    u.depthTex!.value = src.depthTexture;
    u.camWorld!.value.copy(camera.matrixWorld);
    u.projInv!.value.copy(camera.projectionMatrixInverse);
    u.depthMode!.value = depth === "reversed" ? 1 : depth === "log" ? 2 : 0;
    u.logDepthFC!.value = 2.0 / (Math.log(camera.far + 1.0) / Math.LN2);
    u.enabled!.value = p !== null;
    if (p) {
      u.center!.value.copy(p.center);
      u.rGround!.value = p.groundRadius;
      u.rTop!.value = p.topRadius;
      u.sunDir!.value.copy(p.sunDir);
      u.sunE!.value = p.sunIrradiance;
    }
    u.steps!.value = Math.min(Math.max(steps, 4), 128);
    r.setRenderTarget(dst);
    this.quad.render(r);
  }
}
