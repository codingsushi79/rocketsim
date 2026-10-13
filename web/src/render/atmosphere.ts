// Atmospheric scattering (spec §3: physically based), with multiple scattering.
//
// Model: S. Hillaire, "A Scalable and Production Ready Sky and Atmosphere Rendering
// Technique", Computer Graphics Forum 39(4) (EGSR 2020).
// - A transmittance LUT T(r, μ) (256×64) and a multiple-scattering LUT Ψ_ms(r, μ_s)
//   (32×32) are computed once on the GPU.
// - Ψ_ms is the infinite-order isotropic approximation: Ψ = L₂ / (1 − f_ms), eqs. 5–9 of
//   the paper, including the ground-albedo bounce.
// - The per-pixel pass ray-marches the view ray: single scattering with the LUT's sun
//   transmittance and the Earth's shadow, plus σ_s·Ψ_ms. It reads the scene depth (and a
//   cloud distance) for aerial perspective.
//
// Earth constants are Bruneton's (E. Bruneton, "A Qualitative and Quantitative
// Evaluation of 8 Clear Sky Models", IEEE TVCG 2017; reference implementation):
// - Rayleigh β = (5.802, 13.558, 33.1)e-6 /m, H = 8 km
// - Mie β_s = 3.996e-6 /m, β_e = 4.40e-6 /m, H = 1.2 km, g = 0.8
// - Ozone σ_a = (0.650, 1.881, 0.085)e-6 /m, tent profile centred at 25 km, 15 km half-width
// - Ground albedo 0.3 for the multiple-scattering bounce.
//
// Radiometry (D19): sun irradiance E in units of E☉(1 au); radiance in U = E☉/π per sr,
// so L = π·E·∫ T (β P T_sun + σ_s Ψ) ds.

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
  /** Render (ICRF) axes → body-fixed rotation, for surface-anchored layers (clouds). */
  toBodyFixed?: THREE.Matrix3;
  /** Reference ellipsoid semi-axes (equatorial, polar), m. */
  ellipsoid?: [number, number];
  /** Unit vector toward the Moon and its irradiance (E☉ units; moonlight.ts). */
  moonDir?: THREE.Vector3;
  moonIrradiance?: number;
}

/** GLSL: the planet's reference ellipsoid (semi-axes ellA equatorial, ellC polar, about
 *  body-fixed z). The atmosphere is spherically layered by altitude above it, so the
 *  air at the surface has the same density at the equator and the poles (a sphere of
 *  mean radius is 7 km below the equator and 14 km above the poles: with realistic
 *  haze in the lowest kilometres, the faceted globe mesh showed through as a grid).
 *  Needs uniforms toBodyFixed (mat3), ellA, ellC and hitSphere(). */
export const ELLIPSOID_GLSL = /* glsl */ `
  float ellRadius(vec3 p) {
    vec3 u = normalize(toBodyFixed * p);
    return ellA * ellC / sqrt(ellC * ellC * (u.x * u.x + u.y * u.y) + ellA * ellA * u.z * u.z);
  }
  float ellAlt(vec3 p) { return length(p) - ellRadius(p); }
  // Ray–ellipsoid intersection (o relative to the centre, unit d); (1, −1)/s on a miss.
  vec2 hitEllipsoid(vec3 o, vec3 d) {
    vec3 sc = vec3(1.0, 1.0, ellA / ellC);
    vec3 ob = (toBodyFixed * o) * sc, db = (toBodyFixed * d) * sc;
    float L = length(db);
    return hitSphere(ob, db / L, ellA) / L;
  }
`;

export const TRANSMITTANCE_SIZE = [256, 64] as const;
export const MULTISCATTER_SIZE = 32;

/** Shared atmosphere GLSL: constants, densities, intersections and LUT lookups.
 *  Needs uniforms rGround, rTop and (for lookups) transmittanceLut, multiscatterLut. */
export const ATMOSPHERE_GLSL = /* glsl */ `
  const vec3 BETA_R = vec3(5.802e-6, 13.558e-6, 33.1e-6);
  const float H_R = 8000.0;
  // Aerosols: an exponential layer (scale height 1.2 km) with optical depth 0.10 at 550 nm,
  // the global mean (AERONET climatology; Holben et al. 1998, Remote Sens. Environ.
  // 66:1) — about 35 km horizontal visibility at sea level (Koschmieder, V = 3.912/β) —
  // and single-scattering albedo 0.9. (The common rendering default, 4.4e-6 /m, is an
  // optical depth of 0.005: unrealistically clean air.)
  const float BETA_M_E = 0.10 / 1200.0;
  const float BETA_M_S = 0.9 * BETA_M_E;
  const float H_M = 1200.0;
  const float MIE_G = 0.8;
  const vec3 BETA_O = vec3(0.650e-6, 1.881e-6, 0.085e-6);
  const float GROUND_ALBEDO = 0.3;
  const float PI = 3.14159265358979;

  // Ray–sphere intersection (origin relative to the centre, unit dir). (1, −1) on a miss.
  vec2 hitSphere(vec3 o, vec3 d, float r) {
    float b = dot(o, d);
    float c = dot(o, o) - r * r;
    float disc = b * b - c;
    if (disc < 0.0) return vec2(1.0, -1.0);
    float s = sqrt(disc);
    return vec2(-b - s, -b + s);
  }

  // Densities (Rayleigh, Mie, ozone) at altitude h.
  vec3 atmoDensity(float h) {
    float o = max(0.0, 1.0 - abs(h - 25000.0) / 15000.0);
    return vec3(exp(-h / H_R), exp(-h / H_M), o);
  }
  vec3 atmoExtinction(vec3 d) { return BETA_R * d.x + vec3(BETA_M_E) * d.y + BETA_O * d.z; }
  vec3 atmoScattering(vec3 d) { return BETA_R * d.x + vec3(BETA_M_S) * d.y; }

  float rayleighPhase(float mu) { return 3.0 / (16.0 * PI) * (1.0 + mu * mu); }
  float miePhase(float mu) {
    float g = MIE_G;
    return 3.0 / (8.0 * PI) * ((1.0 - g * g) * (1.0 + mu * mu)) / ((2.0 + g * g) * pow(max(1.0 + g * g - 2.0 * g * mu, 1e-6), 1.5));
  }

  // Bruneton (2017) transmittance-texture parameterisation.
  vec2 transmittanceUv(float r, float mu) {
    float H = sqrt(rTop * rTop - rGround * rGround);
    float rho = sqrt(max(r * r - rGround * rGround, 0.0));
    float disc = r * r * (mu * mu - 1.0) + rTop * rTop;
    float d = max(-r * mu + sqrt(max(disc, 0.0)), 0.0);
    float dMin = rTop - r, dMax = rho + H;
    float xMu = (d - dMin) / max(dMax - dMin, 1e-3);
    float xR = rho / H;
    vec2 n = vec2(${TRANSMITTANCE_SIZE[0]}.0, ${TRANSMITTANCE_SIZE[1]}.0);
    return (vec2(xMu, xR) * (n - 1.0) + 0.5) / n;
  }

  #ifdef ATMO_LUTS
  uniform sampler2D transmittanceLut;
  uniform sampler2D multiscatterLut;
  // Transmittance from a point at radius r toward direction cosine mu (to the top),
  // zero where the ground blocks the ray.
  vec3 transmittanceToTop(float r, float mu) {
    float muHorizon = -sqrt(max(1.0 - (rGround * rGround) / (r * r), 0.0));
    if (mu < muHorizon) return vec3(0.0);
    return texture2D(transmittanceLut, transmittanceUv(min(r, rTop), mu)).rgb;
  }
  vec3 multiscatter(float r, float muS) {
    float n = ${MULTISCATTER_SIZE}.0;
    vec2 uv = vec2(muS * 0.5 + 0.5, clamp((r - rGround) / (rTop - rGround), 0.0, 1.0));
    return texture2D(multiscatterLut, (uv * (n - 1.0) + 0.5) / n).rgb;
  }
  #endif
`;

const TRANSMITTANCE_FS = /* glsl */ `
  precision highp float;
  uniform float rGround, rTop;
  varying vec2 vUv;
  ${ATMOSPHERE_GLSL}
  void main() {
    vec2 n = vec2(${TRANSMITTANCE_SIZE[0]}.0, ${TRANSMITTANCE_SIZE[1]}.0);
    vec2 x = (vUv * n - 0.5) / (n - 1.0);
    float H = sqrt(rTop * rTop - rGround * rGround);
    float rho = H * clamp(x.y, 0.0, 1.0);
    float r = sqrt(rho * rho + rGround * rGround);
    float dMin = rTop - r, dMax = rho + H;
    float d = dMin + clamp(x.x, 0.0, 1.0) * (dMax - dMin);
    float mu = d == 0.0 ? 1.0 : clamp((H * H - rho * rho - d * d) / (2.0 * r * d), -1.0, 1.0);
    vec3 o = vec3(0.0, 0.0, r);
    vec3 dir = vec3(sqrt(max(1.0 - mu * mu, 0.0)), 0.0, mu);
    float len = max(hitSphere(o, dir, rTop).y, 0.0);
    const int N = 64;
    float ds = len / float(N);
    vec3 od = vec3(0.0);
    for (int i = 0; i < N; i++) {
      vec3 p = o + dir * (ds * (float(i) + 0.5));
      od += atmoDensity(length(p) - rGround) * ds;
    }
    gl_FragColor = vec4(exp(-atmoExtinction(od)), 1.0);
  }
`;

const MULTISCATTER_FS = /* glsl */ `
  precision highp float;
  uniform float rGround, rTop;
  varying vec2 vUv;
  #define ATMO_LUTS
  ${ATMOSPHERE_GLSL}
  void main() {
    float n = ${MULTISCATTER_SIZE}.0;
    vec2 x = clamp((vUv * n - 0.5) / (n - 1.0), 0.0, 1.0);
    float muS = x.x * 2.0 - 1.0;
    float r = rGround + max(x.y, 1e-4) * (rTop - rGround);
    vec3 o = vec3(0.0, 0.0, r);
    vec3 sunDir = vec3(sqrt(max(1.0 - muS * muS, 0.0)), 0.0, muS);
    const int DIRS = 64;
    const int STEPS = 20;
    const float uniformPhase = 1.0 / (4.0 * PI);
    vec3 L2 = vec3(0.0), fms = vec3(0.0);
    for (int k = 0; k < DIRS; k++) {
      // Fibonacci sphere directions.
      float z = 1.0 - 2.0 * (float(k) + 0.5) / float(DIRS);
      float phi = float(k) * 2.39996323;
      float s = sqrt(max(1.0 - z * z, 0.0));
      vec3 dir = vec3(s * cos(phi), s * sin(phi), z);
      vec2 g = hitSphere(o, dir, rGround);
      bool ground = g.y > 0.0 && g.x <= g.y && g.x > 0.0; // (1, −1) is a miss
      float len = ground ? g.x : max(hitSphere(o, dir, rTop).y, 0.0);
      float ds = len / float(STEPS);
      vec3 tp = vec3(1.0);
      for (int i = 0; i < STEPS; i++) {
        vec3 p = o + dir * (ds * (float(i) + 0.5));
        float rp = length(p);
        vec3 dens = atmoDensity(rp - rGround);
        vec3 sigS = atmoScattering(dens);
        vec3 sigT = atmoExtinction(dens);
        vec3 stepT = exp(-sigT * ds);
        vec3 tSun = transmittanceToTop(rp, dot(p, sunDir) / rp);
        // Analytic integration over the step (Hillaire 2020, eq. 7 form).
        vec3 integ = (vec3(1.0) - stepT) / max(sigT, vec3(1e-12));
        L2 += tp * sigS * tSun * uniformPhase * integ;
        fms += tp * sigS * integ;
        tp *= stepT;
      }
      if (ground) {
        vec3 pg = o + dir * len;
        float rg = length(pg);
        float ndl = max(dot(pg / rg, sunDir), 0.0);
        L2 += tp * transmittanceToTop(rg, ndl) * ndl * GROUND_ALBEDO / PI;
      }
    }
    L2 /= float(DIRS);
    fms /= float(DIRS);
    gl_FragColor = vec4(L2 / (vec3(1.0) - fms), 1.0);
  }
`;

const FS = /* glsl */ `
  precision highp float;
  uniform sampler2D colorTex;
  uniform sampler2D depthTex;
  uniform sampler2D cloudTex;
  uniform bool hasClouds;
  uniform mat4 camWorld;
  uniform vec3 center;
  uniform float rGround, rTop;
  uniform vec3 sunDir;
  uniform float sunE;
  uniform int steps;
  uniform float preExposure;
  uniform bool enabled;
  uniform mat3 toBodyFixed;
  uniform float ellA, ellC;
  varying vec2 vUv;
  ${DEPTH_GLSL}
  #define ATMO_LUTS
  ${ATMOSPHERE_GLSL}
  ${ELLIPSOID_GLSL}

  void main() {
    vec4 scene = texture2D(colorTex, vUv);
    if (!enabled) { gl_FragColor = scene; return; }
    vec2 ndc = vUv * 2.0 - 1.0;
    vec4 vd = projInv * vec4(ndc, 0.5, 1.0);
    vec3 viewDir = normalize(vd.xyz / vd.w);
    vec3 dir = normalize((camWorld * vec4(viewDir, 0.0)).xyz);
    float vz = viewDepth(texture2D(depthTex, vUv).r, ndc);
    float sceneDist = vz / max(-viewDir.z, 1e-6);
    // Clouds in front of the surface end the aerial-perspective ray there (km in alpha).
    if (hasClouds) {
      float cd = texture2D(cloudTex, vUv).a;
      if (cd > 0.0) sceneDist = min(sceneDist, cd * 1000.0);
    }

    vec3 o = -center;
    vec2 a = hitSphere(o, dir, rTop);
    if (a.y <= 0.0 || a.x > a.y) { gl_FragColor = scene; return; }
    float t0 = max(a.x, 0.0);
    float t1 = a.y;
    vec2 g = hitEllipsoid(o, dir);
    // A miss is (1, −1)/s: only a real hit ends the ray at the ground. The globe mesh
    // and coarse terrain tiles lie up to a few km under the true surface (flat
    // triangles): a scene depth just beyond the ellipsoid is that surface.
    bool hitG = g.y > 0.0 && g.x <= g.y && g.x > 0.0;
    if (hitG) {
      t1 = min(t1, g.x);
      if (sceneDist > g.x - 30000.0) sceneDist = max(sceneDist, g.x);
    }
    t1 = min(t1, sceneDist);
    if (t1 <= t0) { gl_FragColor = scene; return; }

    // At least 16 samples (fewer band visibly over the ground), jittered per pixel so the
    // remaining sampling error is noise, not rings (the step boundaries line up between
    // neighbouring pixels otherwise).
    int n = max(steps, 16);
    float jit = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
    float mu = dot(dir, sunDir);
    float pr = rayleighPhase(mu), pm = miePhase(mu);
    vec3 tView = vec3(1.0);
    vec3 inscatter = vec3(0.0);
    // Samples concentrated toward the ray's lowest point (where the density is): split the
    // ray there and space each half quadratically toward it. Uniform steps missed the few
    // km around the tangent point of a limb ray from orbit (2000+ km long), and the dense
    // near-ground layers of rays seen from space.
    float tm = clamp(-dot(o, dir), t0, t1);
    int nA = tm > t0 + 1.0 ? n / 2 : 0;
    int nB = n - nA;
    for (int i = 0; i < 256; i++) {
      if (i >= n) break;
      float ta, tb;
      if (i < nA) {
        // Toward tm from t0: u from 1 to 0 (t increasing).
        float u0 = 1.0 - (float(i) + jit - 0.5) / float(nA), u1 = 1.0 - (float(i + 1) + jit - 0.5) / float(nA);
        u0 = clamp(u0, 0.0, 1.0); u1 = clamp(u1, 0.0, 1.0);
        if (i == 0) u0 = 1.0;
        if (i == nA - 1) u1 = 0.0;
        ta = tm - (tm - t0) * u0 * u0;
        tb = tm - (tm - t0) * u1 * u1;
      } else {
        int k = i - nA;
        float u0 = clamp((float(k) + jit - 0.5) / float(nB), 0.0, 1.0), u1 = clamp((float(k + 1) + jit - 0.5) / float(nB), 0.0, 1.0);
        if (k == nB - 1) u1 = 1.0;
        if (k == 0) u0 = 0.0;
        ta = tm + (t1 - tm) * u0 * u0;
        tb = tm + (t1 - tm) * u1 * u1;
      }
      float ds = tb - ta;
      if (ds <= 0.0) continue;
      vec3 p = o + dir * (0.5 * (ta + tb));
      // Altitude above the ellipsoid, as a radius in the spherical LUT model.
      float rp = rGround + max(ellAlt(p), 0.0);
      vec3 dens = atmoDensity(rp - rGround);
      vec3 sigT = atmoExtinction(dens);
      vec3 stepT = exp(-sigT * ds);
      float muS = dot(p, sunDir) / length(p);
      vec3 tSun = transmittanceToTop(rp, muS);
      vec3 single = (BETA_R * dens.x * pr + vec3(BETA_M_S) * dens.y * pm) * tSun;
      vec3 multi = atmoScattering(dens) * multiscatter(rp, muS);
      vec3 integ = (vec3(1.0) - stepT) / max(sigT, vec3(1e-12));
      inscatter += tView * (single + multi) * integ;
      tView *= stepT;
    }
    vec3 L = PI * sunE * inscatter * preExposure;
    gl_FragColor = vec4(scene.rgb * tView + L, 1.0);
  }
`;

export class AtmospherePass {
  private quad: FullScreenQuad;
  private mat: THREE.ShaderMaterial;
  readonly transmittance: THREE.WebGLRenderTarget;
  readonly multiscatter: THREE.WebGLRenderTarget;
  private lutRadii: [number, number] | null = null;

  constructor() {
    const lut = (w: number, h: number) =>
      new THREE.WebGLRenderTarget(w, h, {
        type: THREE.FloatType,
        format: THREE.RGBAFormat,
        depthBuffer: false,
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        wrapS: THREE.ClampToEdgeWrapping,
        wrapT: THREE.ClampToEdgeWrapping,
      });
    this.transmittance = lut(TRANSMITTANCE_SIZE[0], TRANSMITTANCE_SIZE[1]);
    this.multiscatter = lut(MULTISCATTER_SIZE, MULTISCATTER_SIZE);
    this.mat = new THREE.ShaderMaterial({
      uniforms: {
        colorTex: { value: null },
        depthTex: { value: null },
        cloudTex: { value: null },
        hasClouds: { value: false },
        transmittanceLut: { value: this.transmittance.texture },
        multiscatterLut: { value: this.multiscatter.texture },
        camWorld: { value: new THREE.Matrix4() },
        projInv: { value: new THREE.Matrix4() },
        depthMode: { value: 0 },
        logDepthFC: { value: 1 },
        center: { value: new THREE.Vector3() },
        rGround: { value: 6_371_000 },
        toBodyFixed: { value: new THREE.Matrix3() },
        ellA: { value: 6_371_000 },
        ellC: { value: 6_371_000 },
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

  /** (Re)compute the LUTs for these radii. Cheap (two small passes), done on change. */
  private ensureLuts(r: THREE.WebGLRenderer, rGround: number, rTop: number): void {
    if (this.lutRadii && this.lutRadii[0] === rGround && this.lutRadii[1] === rTop) return;
    this.lutRadii = [rGround, rTop];
    const prev = r.getRenderTarget();
    const tq = new FullScreenQuad(
      new THREE.ShaderMaterial({ uniforms: { rGround: { value: rGround }, rTop: { value: rTop } }, vertexShader: QUAD_VS, fragmentShader: TRANSMITTANCE_FS, depthTest: false, depthWrite: false }),
    );
    r.setRenderTarget(this.transmittance);
    tq.render(r);
    const mq = new FullScreenQuad(
      new THREE.ShaderMaterial({
        uniforms: { rGround: { value: rGround }, rTop: { value: rTop }, transmittanceLut: { value: this.transmittance.texture }, multiscatterLut: { value: null } },
        vertexShader: QUAD_VS,
        fragmentShader: MULTISCATTER_FS,
        depthTest: false,
        depthWrite: false,
      }),
    );
    r.setRenderTarget(this.multiscatter);
    mq.render(r);
    tq.dispose();
    mq.dispose();
    r.setRenderTarget(prev);
  }

  /** LUTs for other passes (clouds), valid after the first render with params. */
  luts(r: THREE.WebGLRenderer, p: AtmosphereParams): { transmittance: THREE.Texture; multiscatter: THREE.Texture } {
    this.ensureLuts(r, p.groundRadius, p.topRadius);
    return { transmittance: this.transmittance.texture, multiscatter: this.multiscatter.texture };
  }

  render(
    r: THREE.WebGLRenderer,
    src: THREE.WebGLRenderTarget,
    dst: THREE.WebGLRenderTarget,
    camera: THREE.PerspectiveCamera,
    depth: ActiveDepth,
    p: AtmosphereParams | null,
    steps: number,
    clouds: THREE.Texture | null = null,
  ): void {
    const u = this.mat.uniforms;
    if (p) this.ensureLuts(r, p.groundRadius, p.topRadius);
    // With clouds, the colour comes from the cloud pass (alpha = cloud distance, km).
    u.colorTex!.value = clouds ?? src.texture;
    u.depthTex!.value = src.depthTexture;
    u.cloudTex!.value = clouds;
    u.hasClouds!.value = clouds !== null;
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
      if (p.toBodyFixed) u.toBodyFixed!.value.copy(p.toBodyFixed);
      u.ellA!.value = p.ellipsoid?.[0] ?? p.groundRadius;
      u.ellC!.value = p.ellipsoid?.[1] ?? p.groundRadius;
    }
    u.steps!.value = Math.min(Math.max(steps, 4), 128);
    r.setRenderTarget(dst);
    this.quad.render(r);
  }
}
