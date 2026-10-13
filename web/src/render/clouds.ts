// Volumetric clouds: a ray-marched cloud shell around the Earth, depth-aware,
// composited before the atmosphere pass.
//
// - **Where.** Coverage is NASA Blue Marble: Clouds (Visible Earth 57747; MODIS
//   composite), looked up by body-fixed latitude and longitude so it turns with the
//   Earth, with a B-spline bicubic filter (Sigg & Hadwiger 2005, GPU Gems 2 ch. 20) so the
//   texels never show as polygons. A tiling 3D Worley noise volume adds billows below the
//   map's texel size at three scales (60, 15, 4 km), each faded in only where it spans
//   several pixels (no aliasing from orbit, full detail up close). The modulation is
//   normalised to unit mean, so each texel keeps the map's reflectance on average.
// - **Profile.** The base is at 1.5 km. The top rises with coverage, from 3 km (thin
//   cumulus) to 12 km (deep convection).
// - **Optics.** Each column's optical depth reproduces the map's reflectance with a
//   two-stream relation (see cloudSigma), spread over the height profile.
//   Single-scattering albedo ≈ 1. Phase is a dual-lobe Henyey–Greenstein (g = 0.8 / −0.3).
// - **Multiple scattering.** Single scattering exactly, plus a diffuse source calibrated to
//   two-stream so a column reflects what the map says it does (see the shader). Wrenninge's
//   4-octave method, used before, saturated at R ≈ 0.22 for any τ (measured), so thick
//   clouds came out ~3× too dark.
// - **Sun.** Light comes through the cloud (a short light march) and through the
//   atmosphere (the transmittance LUT, which also gives the Earth's shadow and reddened
//   sunsets).
// - **Sky.** A small ambient term for skylight.
//
// The march runs at half resolution (a quarter of the pixels; it is the costliest pass)
// and is upsampled with depth-aware weights. Output: rgb = scene·T + L, alpha = distance (km) at which the cloud becomes opaque
// (transmittance below ½), so the atmosphere pass applies aerial perspective to the cloud
// instead of the ground behind it.

import * as THREE from "three";
import { FullScreenQuad } from "three/examples/jsm/postprocessing/Pass.js";
import { ATMOSPHERE_GLSL, type AtmosphereParams } from "./atmosphere";
import type { ActiveDepth } from "./engine";
import { DEPTH_GLSL, QUAD_VS } from "./glsl";
import { PRE_EXPOSURE } from "./units";

const NOISE_SIZE = 64;

/** Tileable 3D Worley noise (3 octaves, inverted, 0–1), R8, and its mean. Deterministic. */
function worleyVolume(n: number): { tex: THREE.Data3DTexture; mean: number; quant: THREE.DataTexture } {
  const data = new Uint8Array(n * n * n);
  let seed = 1234567;
  const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const octaves = [4, 8, 16].map((cells) => {
    const pts = new Float32Array(cells * cells * cells * 3);
    for (let i = 0; i < pts.length; i++) pts[i] = rand();
    return { cells, pts };
  });
  const worley = (x: number, y: number, z: number, o: { cells: number; pts: Float32Array }) => {
    const c = o.cells;
    const fx = x * c, fy = y * c, fz = z * c;
    const ix = Math.floor(fx), iy = Math.floor(fy), iz = Math.floor(fz);
    let best = 9;
    for (let dz = -1; dz <= 1; dz++)
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const cx = ix + dx, cy = iy + dy, cz = iz + dz;
          const wx = ((cx % c) + c) % c, wy = ((cy % c) + c) % c, wz = ((cz % c) + c) % c;
          const k = ((wz * c + wy) * c + wx) * 3;
          const px = cx + o.pts[k]!, py = cy + o.pts[k + 1]!, pz = cz + o.pts[k + 2]!;
          const d = (px - fx) ** 2 + (py - fy) ** 2 + (pz - fz) ** 2;
          if (d < best) best = d;
        }
    return Math.min(1, Math.sqrt(best));
  };
  for (let z = 0; z < n; z++)
    for (let y = 0; y < n; y++)
      for (let x = 0; x < n; x++) {
        const u = x / n, v = y / n, w = z / n;
        const f = 0.625 * (1 - worley(u, v, w, octaves[0]!)) + 0.25 * (1 - worley(u, v, w, octaves[1]!)) + 0.125 * (1 - worley(u, v, w, octaves[2]!));
        data[(z * n + y) * n + x] = Math.round(Math.min(1, f) * 255);
      }
  let sum = 0;
  for (const v of data) sum += v;
  // Quantiles of the billow field for the coverage threshold: row 0 the 60 km octave alone,
  // row 1 the 60/15 km mix (0.6/0.4) used up close. Sampled at random points (trilinear,
  // tiling); the two scales of one tiling volume are close to independent.
  const tri = (x: number, y: number, z: number) => {
    const fx = x * n - 0.5, fy = y * n - 0.5, fz = z * n - 0.5;
    const x0 = Math.floor(fx), y0 = Math.floor(fy), z0 = Math.floor(fz);
    const tx = fx - x0, ty = fy - y0, tz = fz - z0;
    const at = (i: number, j: number, k: number) => data[(((k % n) + n) % n * n + (((j % n) + n) % n)) * n + (((i % n) + n) % n)]! / 255;
    let v = 0;
    for (let c = 0; c < 8; c++) {
      const dx = c & 1, dy = (c >> 1) & 1, dz = c >> 2;
      v += at(x0 + dx, y0 + dy, z0 + dz) * (dx ? tx : 1 - tx) * (dy ? ty : 1 - ty) * (dz ? tz : 1 - tz);
    }
    return v;
  };
  const M = 60000;
  const one: number[] = [], mix: number[] = [];
  for (let i = 0; i < M; i++) {
    const x = rand(), y = rand(), z = rand();
    const a = tri(x, y, z);
    one.push(a);
    mix.push(0.6 * a + 0.4 * tri(x * 4, y * 4, z * 4));
  }
  one.sort((a, b) => a - b);
  mix.sort((a, b) => a - b);
  const W = 256;
  const cdf = new Float32Array(W * 2 * 4);
  for (let i = 0; i < W; i++) {
    // Threshold for cover fraction f = i/(W−1): the (1 − f) quantile.
    const q = Math.min(M - 1, Math.floor((1 - i / (W - 1)) * (M - 1)));
    cdf[i * 4] = i === 0 ? 2 : one[q]!;
    cdf[(W + i) * 4] = i === 0 ? 2 : mix[q]!;
  }
  const quant = new THREE.DataTexture(cdf, W, 2, THREE.RGBAFormat, THREE.FloatType);
  quant.minFilter = quant.magFilter = THREE.LinearFilter;
  quant.needsUpdate = true;
  const t = new THREE.Data3DTexture(data, n, n, n);
  t.format = THREE.RedFormat;
  t.type = THREE.UnsignedByteType;
  t.wrapS = t.wrapT = t.wrapR = THREE.RepeatWrapping;
  t.minFilter = t.magFilter = THREE.LinearFilter;
  t.unpackAlignment = 1;
  t.needsUpdate = true;
  return { tex: t, mean: sum / data.length / 255, quant };
}

const FS = /* glsl */ `
  precision highp float;
  precision highp sampler3D;
  layout(location = 0) out highp vec4 cloudOut;
  #define gl_FragColor cloudOut
  layout(location = 1) out highp vec4 cloudAux;
  uniform sampler2D depthTex;
  uniform sampler2D coverageTex;
  uniform sampler3D noiseTex;
  uniform mat4 camWorld;
  uniform mat3 toBodyFixed;
  uniform vec3 center;
  uniform float rGround, rTop;
  uniform vec3 sunDir, moonDir;
  uniform float sunE, moonE;
  uniform int steps;
  uniform int lightSteps;
  uniform float preExposure;
  uniform float frame;
  uniform float pixelAngle;
  uniform float texelMeters;
  uniform float noiseMean;
  uniform sampler2D noiseQuant;
  varying vec2 vUv;
  ${DEPTH_GLSL}
  #define ATMO_LUTS
  ${ATMOSPHERE_GLSL}

  const float CLOUD_BASE = 1500.0;
  const float CLOUD_TOP_MAX = 12000.0;
  // Billow periods (m).
  const vec3 NOISE_PERIOD = vec3(60000.0, 15000.0, 4000.0);
  // Broken-cloud model: cloudy parts have τ ≥ TAU_C, reflectance RC = τ/(τ + 7.5) (same
  // two-stream relation), so a texel of mean reflectance R < RC is a fraction R/RC cloud.
  const float RC = 0.57;

  // B-spline bicubic lookup with four bilinear taps (Sigg & Hadwiger 2005).
  vec4 cubicW(float v) {
    vec4 n = vec4(1.0, 2.0, 3.0, 4.0) - v;
    vec4 s = n * n * n;
    float x = s.x, y = s.y - 4.0 * s.x, z = s.z - 4.0 * s.y + 6.0 * s.x;
    return vec4(x, y, z, 6.0 - x - y - z) / 6.0;
  }
  float coverageAt(vec2 uv, float lod) {
    float l = floor(lod);
    vec2 size = vec2(textureSize(coverageTex, int(l)));
    vec2 p = uv * size - 0.5;
    vec2 f = fract(p);
    p -= f;
    vec4 xc = cubicW(f.x), yc = cubicW(f.y);
    vec4 c = p.xxyy + vec2(-0.5, 1.5).xyxy;
    vec4 sw = vec4(xc.xz + xc.yw, yc.xz + yc.yw);
    vec4 off = (c + vec4(xc.yw, yc.yw) / sw) / size.xxyy;
    float s0 = textureLod(coverageTex, off.xz, l).r, s1 = textureLod(coverageTex, off.yz, l).r;
    float s2 = textureLod(coverageTex, off.xw, l).r, s3 = textureLod(coverageTex, off.yw, l).r;
    float sx = sw.x / (sw.x + sw.y), sy = sw.z / (sw.z + sw.w);
    return mix(mix(s3, s2, sx), mix(s1, s0, sx), sy);
  }

  float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }

  // Backscatter of the cloud phase function, π·P(180°)/2 ≈ 0.105 (P from the dual-lobe
  // HG below, evaluated at μ = −1), and the diffuse decay with light depth.
  const float SS_PHASE = 0.066776;
  const float MS_K = 0.15;

  float hg(float mu, float g) {
    float g2 = g * g;
    return (1.0 - g2) / (4.0 * PI * pow(max(1.0 + g2 - 2.0 * g * mu, 1e-4), 1.5));
  }
  float phase(float mu, float k) {
    return mix(hg(mu, -0.3 * k), hg(mu, 0.8 * k), 0.7);
  }

  // Cloud extinction σ (1/m) at q, relative to the Earth's centre (render axes = ICRF).
  // The map is a visible-reflectance composite, so a column's optical depth is set to
  // reproduce it: a plane-parallel cloud of albedo ≈ 1 reflects R ≈ τ/(τ + 7.5) (two-stream,
  // asymmetry 0.85; Bohren 1987, Am. J. Phys. 55:524), hence τ = 7.5·R/(1 − R). The profile
  // distributes τ over the column. "detail" (0–1) adds noise erosion near the camera and
  // fades it out where it would alias.
  // Octave weight: on only where the period spans ≥ ~8 pixels (no aliasing).
  float octave(float period, float fp) { return smoothstep(4.0, 12.0, period / max(fp, 1.0)); }

  // fp: the pixel footprint (m) at q, for scale-aware detail; fine = include the 4 km octave.
  // Returns (σ, column τ of the cloudy part).
  vec2 cloudSample(vec3 q, float fp, float lod, bool fine) {
    float r = length(q);
    float h = r - rGround;
    if (h < CLOUD_BASE || h > CLOUD_TOP_MAX) return vec2(0.0);
    vec3 bf = toBodyFixed * q;
    float lon = atan(bf.y, bf.x);
    float lat = asin(clamp(bf.z / r, -1.0, 1.0));
    vec2 uv = vec2(lon / (2.0 * PI) + 0.5, lat / PI + 0.5);
    // Explicit LOD: derivatives are undefined inside the march loop.
    float raw = coverageAt(uv, lod);
    // ~0.08 is the clear-sky floor of the composite.
    float R = clamp((raw - 0.08) / 0.88, 0.0, 0.92);
    if (R <= 0.0) return vec2(0.0);
    float f = min(R / RC, 1.0);
    float Rcl = max(R, RC);
    // Two regimes, blended by whether sub-texel billows (15 km) span several pixels:
    // - unresolved: a homogeneous column whose optical depth reproduces the texel's mean
    //   reflectance, τ = 7.5·R/(1 − R) (two-stream, as above): far views look like the map;
    // - resolved: a fraction f of the texel is cloud of τ_c = 7.5·R_c/(1 − R_c), placed where
    //   the billow field exceeds its (1 − f) quantile (same mean reflectance).
    // (Thresholding the 60 km octave, coarser than the 5 km texel, cut the smooth coverage
    // into opaque texel-sized blobs: the blocky clouds.)
    float w15 = octave(NOISE_PERIOD.y, fp);
    float tauU = 7.5 * R / (1.0 - R);
    float tauC = 7.5 * Rcl / (1.0 - Rcl);
    float cov = 1.0, excess = 0.5;
    if (w15 > 0.0) {
      float n60 = textureLod(noiseTex, bf / NOISE_PERIOD.x, 0.0).r;
      float n15 = textureLod(noiseTex, bf / NOISE_PERIOD.y, 0.0).r;
      float nb = 0.6 * n60 + 0.4 * n15;
      float fu = f * (255.0 / 256.0) + 0.5 / 256.0;
      float th = textureLod(noiseQuant, vec2(fu, 0.75), 0.0).r;
      // Edge softness at least the noise's change across a pixel (anti-aliasing).
      float edge = 0.04 + 0.6 * fp / NOISE_PERIOD.y;
      float c = smoothstep(th - edge, th + edge, nb);
      cov = mix(1.0, c, w15);
      excess = mix(0.5, clamp((nb - th) / max(1.0 - th, 0.05), 0.0, 1.0), w15);
    }
    float tau = mix(tauU, tauC, w15);
    if (cov <= 0.0) return vec2(0.0);
    // Tops rise with the texel's reflectance and tower where the billows are strongest.
    float top = CLOUD_BASE + (1000.0 + (CLOUD_TOP_MAX - CLOUD_BASE - 1000.0) * smoothstep(0.1, 0.9, R)) * (0.45 + 1.1 * excess);
    top = min(top, CLOUD_TOP_MAX);
    float hn = (h - CLOUD_BASE) / (top - CLOUD_BASE);
    if (hn >= 1.0) return vec2(0.0);
    // Profile with unit mean over the column: quick rise, rounded top.
    float profile = smoothstep(0.0, 0.12, hn) * (1.0 - smoothstep(0.45, 1.0, hn)) / 0.58;
    float sigma = tau / (top - CLOUD_BASE) * profile * cov;
    // Close up: 4 km billows erode the surfaces (unit mean, so τ is kept on average).
    if (fine) {
      float w4 = octave(NOISE_PERIOD.z, fp);
      if (w4 > 0.0) {
        float n4 = textureLod(noiseTex, bf / NOISE_PERIOD.z, 0.0).r;
        float c4 = 0.6 * noiseMean;
        sigma *= mix(1.0, max(0.0, (n4 - c4) / (noiseMean - c4)), 0.6 * w4);
      }
    }
    return vec2(sigma, tau);
  }
  float cloudSigma(vec3 q, float fp, float lod, bool fine) { return cloudSample(q, fp, lod, fine).x; }

  void main() {
    vec2 ndc = vUv * 2.0 - 1.0;
    vec4 vd = projInv * vec4(ndc, 0.5, 1.0);
    vec3 viewDir = normalize(vd.xyz / vd.w);
    vec3 dir = normalize((camWorld * vec4(viewDir, 0.0)).xyz);
    // Exact full-res texel (a half-res texel centre lies on a full-res texel boundary).
    float vz = viewDepth(texelFetch(depthTex, ivec2(vUv * vec2(textureSize(depthTex, 0))), 0).r, ndc);
    float sceneDist = vz / max(-viewDir.z, 1e-6);

    vec3 o = -center;
    float rIn = rGround + CLOUD_BASE, rOut = rGround + CLOUD_TOP_MAX;
    vec2 outer = hitSphere(o, dir, rOut);
    if (outer.y <= 0.0 || outer.x > outer.y) { gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); cloudAux = vec4(0.0); return; }
    float t0 = max(outer.x, 0.0);
    float t1 = outer.y;
    vec2 inner = hitSphere(o, dir, rIn);
    float rc = length(o);
    if (rc > rIn) {
      // Above the base: stop where the ray enters the cloud-free core.
      if (inner.y > 0.0 && inner.x <= inner.y && inner.x > 0.0) t1 = min(t1, inner.x);
    } else if (inner.y > 0.0) {
      // Below the base: start where the ray leaves the core.
      t0 = max(t0, inner.y);
    }
    vec2 ground = hitSphere(o, dir, rGround);
    // hitSphere returns (1, −1) on a miss: only a real hit ends the ray at the ground.
    if (ground.y > 0.0 && ground.x <= ground.y && ground.x > 0.0) t1 = min(t1, ground.x);
    // Terrain occludes the layer, but streamed terrain far away is coarse: a tile's flat
    // triangles can sit kilometres under the true surface, inside the layer (that cut
    // the march in tile-shaped patches). Allow the geometric error of the level of detail
    // shown, a few pixel footprints, which keeps the vehicle's silhouette exact.
    t1 = min(t1, sceneDist + 8.0 * sceneDist * pixelAngle);
    // From low altitude, the shell is long and grazing: cap the marched distance.
    t1 = min(t1, t0 + 300000.0);
    if (t1 <= t0) { gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); cloudAux = vec4(0.0); return; }

    // Adaptive steps: about 250 m of altitude change per sample (the layer is only a few
    // km thick, so grazing rays need long steps along the ray but not across the layer).
    float jitter = hash(gl_FragCoord.xy + frame * 0.618);
    float mu = dot(dir, sunDir);
    vec3 T = vec3(1.0);
    vec3 L = vec3(0.0);
    float opaqueAt = 0.0;
    float maxIter = float(steps) * 6.0;
    float t = t0;
    // Two-speed march (Schneider 2015, "The real-time volumetric cloudscapes of Horizon
    // Zero Dawn"): coarse steps through clear air; on entering cloud, step back and refine
    // to quarter steps until the ray has been clear for a while. Thin low clouds are only
    // ~1 km thick: two or three coarse jittered samples gave pixel-to-pixel noise in the
    // optical depth (hard, aliased edges).
    bool fineMode = false;
    int clear = 0;
    for (int i = 0; i < 1600; i++) {
      if (float(i) >= maxIter || t >= t1) break;
      vec3 qa = o + dir * t;
      float cosZ = abs(dot(dir, qa) / length(qa));
      float dsC = clamp(300.0 / max(cosZ, 0.03), 150.0, 5000.0);
      float ds = fineMode ? max(0.25 * dsC, 40.0) : dsC;
      float tc = t + ds * jitter;
      t += ds;
      if (tc > t1) break;
      vec3 q = o + dir * tc;
      float fp = tc * pixelAngle;
      // Mip level from the pixel footprint vs. the map's texel size at the equator.
      float lod = max(log2(fp / texelMeters), 0.0);
      vec2 cs = cloudSample(q, fp, lod, true);
      float sigma = cs.x, tauCol = cs.y;
      if (sigma <= 0.0) {
        if (fineMode && ++clear > 8) fineMode = false;
        continue;
      }
      if (!fineMode) {
        fineMode = true;
        clear = 0;
        t -= ds;
        continue;
      }
      clear = 0;
      // The light: the Sun, or the Moon where sunlight is weaker (the night side; moonlight
      // is ~2.5e-6 of sunlight, so where both matter the Sun dominates anyway). One light
      // march either way.
      float rq = length(q);
      vec3 lDir = sunDir;
      float lE = sunE, lmu = mu;
      vec3 tAtm = transmittanceToTop(rq, dot(q, sunDir) / rq);
      if (moonE > 0.0 && sunE * tAtm.g < moonE) {
        lDir = moonDir;
        lE = moonE;
        lmu = dot(dir, moonDir);
        tAtm = transmittanceToTop(rq, dot(q, moonDir) / rq);
      }
      if (lE * tAtm.g <= 0.0) {
        // Unlit (in the shadow of the Earth for both): extinction only.
        float stepT0 = exp(-sigma * ds);
        T *= stepT0;
        if (opaqueAt == 0.0 && T.g < 0.5) opaqueAt = tc;
        if (T.g < 0.003) break;
        continue;
      }
      // Light march toward the light through the cloud.
      float od = 0.0;
      float lds = 600.0;
      for (int j = 0; j < 8; j++) {
        if (j >= lightSteps) break;
        od += cloudSigma(q + lDir * (lds * (float(j) + 0.5)), fp, lod, false) * lds;
        lds *= 1.6;
      }
      // Single scattering (ϖ ≈ 1) plus a diffuse multiple-scattering source sized so that a
      // plane-parallel column of optical depth τ reflects R = τ/(τ + 7.5), the same two-stream
      // relation that inverted the map (sun and view at zenith; Bohren 1987). For a slab,
      // ∫e^(−t)·A·e^(−k·t)dt = A(1 − e^(−(1+k)τ))/(1+k) must supply R − SS, with
      // SS = π·P(180°)·(1 − e^(−2τ))/2. The e^(−k·od) factor (k = 0.15) darkens cloud
      // sides and bases facing away from the Sun.
      float Rcol = tauCol / (tauCol + 7.5);
      float SS = PI * SS_PHASE * (1.0 - exp(-2.0 * tauCol)) * 0.5;
      float A = max(Rcol - SS, 0.0) * (1.0 + MS_K) / max(1.0 - exp(-(1.0 + MS_K) * tauCol), 1e-4);
      float src = PI * phase(lmu, 1.0) * exp(-od) + A * exp(-MS_K * od);
      // Skylight: a few percent of the attenuated sunlight, isotropic.
      vec3 ambient = PI * (tAtm * 0.035 + vec3(0.004, 0.006, 0.01) * smoothstep(-0.1, 0.2, dot(q / rq, lDir)));
      vec3 S = lE * (tAtm * src + ambient);
      float stepT = exp(-sigma * ds);
      // Energy-conserving integration over the step (Hillaire 2015, "Physically based
      // and unified volumetric rendering in Frostbite").
      L += T * S * (1.0 - stepT);
      T *= stepT;
      if (opaqueAt == 0.0 && T.g < 0.5) opaqueAt = tc;
      if (T.g < 0.003) break;
    }
    gl_FragColor = vec4(L * preExposure, T.g);
    cloudAux = vec4(opaqueAt * 0.001, 0.0, 0.0, 1.0);
  }
`;

// Full-resolution composite of the half-resolution march: joint bilateral upsampling
// (Kopf et al. 2007), weights = bilinear × depth similarity, so cloud edges stay sharp
// against the vehicle and terrain silhouettes.
const UPSAMPLE_FS = /* glsl */ `
  precision highp float;
  layout(location = 0) out highp vec4 upOut;
  #define gl_FragColor upOut
  uniform sampler2D colorTex, depthTex, cloudTex, auxTex;
  uniform vec2 halfSize;
  varying vec2 vUv;
  ${DEPTH_GLSL}
  float logDepth(vec2 uv) {
    float z = viewDepth(texture(depthTex, uv).r, uv * 2.0 - 1.0);
    return log(min(z, 1e12) + 1.0);
  }
  void main() {
    vec4 scene = texture(colorTex, vUv);
    float z0 = logDepth(vUv);
    vec2 hp = vUv * halfSize - 0.5;
    vec2 b = floor(hp), f = hp - b;
    vec4 acc = vec4(0.0);
    float wsum = 0.0, oacc = 0.0, osum = 0.0;
    for (int j = 0; j < 2; j++) {
      for (int i = 0; i < 2; i++) {
        vec2 c = clamp(b + vec2(float(i), float(j)), vec2(0.0), halfSize - 1.0);
        // The march sampled the depth at its own texel centre: compare with that.
        float zc = logDepth((c + 0.5) / halfSize);
        float wb = (i == 0 ? 1.0 - f.x : f.x) * (j == 0 ? 1.0 - f.y : f.y);
        float w = wb * (exp(-abs(zc - z0) * 6.0) + 1e-4);
        acc += w * texelFetch(cloudTex, ivec2(c), 0);
        float o = texelFetch(auxTex, ivec2(c), 0).r;
        wsum += w;
        if (o > 0.0) { oacc += w * o; osum += w; }
      }
    }
    acc /= wsum;
    // Opaque distance (km) only where most of the weight is cloud.
    float opaque = osum > 0.5 * wsum ? oacc / osum : 0.0;
    gl_FragColor = vec4(scene.rgb * acc.a + acc.rgb, opaque);
  }
`;

export interface CloudSettings {
  /** Primary ray-march steps (0 = clouds off). */
  steps: number;
  lightSteps: number;
  /** March resolution divisor (1 = full, 2 = half). */
  scale: 1 | 2;
}

export class CloudPass {
  private quad: FullScreenQuad;
  private mat: THREE.ShaderMaterial;
  private frame = 0;

  constructor(coverage: THREE.Texture) {
    coverage.wrapS = THREE.RepeatWrapping;
    coverage.wrapT = THREE.ClampToEdgeWrapping;
    coverage.colorSpace = THREE.NoColorSpace;
    coverage.anisotropy = 8;
    const noise = worleyVolume(NOISE_SIZE);
    this.mat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      uniforms: {
        depthTex: { value: null },
        coverageTex: { value: coverage },
        noiseTex: { value: noise.tex },
        noiseMean: { value: noise.mean },
        noiseQuant: { value: noise.quant },
        transmittanceLut: { value: null },
        multiscatterLut: { value: null },
        camWorld: { value: new THREE.Matrix4() },
        projInv: { value: new THREE.Matrix4() },
        depthMode: { value: 0 },
        logDepthFC: { value: 1 },
        toBodyFixed: { value: new THREE.Matrix3() },
        center: { value: new THREE.Vector3() },
        rGround: { value: 6_371_000 },
        rTop: { value: 6_471_000 },
        sunDir: { value: new THREE.Vector3(1, 0, 0) },
        sunE: { value: 1 },
        moonDir: { value: new THREE.Vector3(0, 0, 1) },
        moonE: { value: 0 },
        steps: { value: 48 },
        lightSteps: { value: 5 },
        preExposure: PRE_EXPOSURE,
        frame: { value: 0 },
        pixelAngle: { value: 1e-3 },
        texelMeters: { value: 20_000 },
      },
      // GLSL 3 for sampler3D; three maps varying/texture2D/gl_FragColor for us.
      vertexShader: QUAD_VS,
      fragmentShader: FS,
      depthTest: false,
      depthWrite: false,
    });
    this.quad = new FullScreenQuad(this.mat);
    this.upMat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      uniforms: {
        colorTex: { value: null },
        depthTex: { value: null },
        cloudTex: { value: null },
        auxTex: { value: null },
        halfSize: { value: new THREE.Vector2(1, 1) },
        projInv: { value: new THREE.Matrix4() },
        depthMode: { value: 0 },
        logDepthFC: { value: 1 },
      },
      vertexShader: QUAD_VS,
      fragmentShader: UPSAMPLE_FS,
      depthTest: false,
      depthWrite: false,
    });
    this.upQuad = new FullScreenQuad(this.upMat);
  }

  /** March targets (full or half resolution): [0] = (L, T), [1] = opaque distance. */
  private half: THREE.WebGLRenderTarget | null = null;
  private upMat: THREE.ShaderMaterial;
  private upQuad: FullScreenQuad;

  private halfTarget(w: number, h: number, scale: number): THREE.WebGLRenderTarget {
    const hw = Math.max(1, Math.ceil(w / scale)), hh = Math.max(1, Math.ceil(h / scale));
    if (!this.half || this.half.width !== hw || this.half.height !== hh) {
      this.half?.dispose();
      this.half = new THREE.WebGLRenderTarget(hw, hh, { type: THREE.HalfFloatType, depthBuffer: false, count: 2 });
      for (const t of this.half.textures) {
        t.minFilter = t.magFilter = THREE.NearestFilter;
        t.generateMipmaps = false;
      }
    }
    return this.half;
  }

  render(
    r: THREE.WebGLRenderer,
    src: THREE.WebGLRenderTarget,
    dst: THREE.WebGLRenderTarget,
    camera: THREE.PerspectiveCamera,
    depth: ActiveDepth,
    p: AtmosphereParams,
    luts: { transmittance: THREE.Texture; multiscatter: THREE.Texture },
    toBodyFixed: THREE.Matrix3,
    s: CloudSettings,
  ): void {
    const u = this.mat.uniforms;
    u.depthTex!.value = src.depthTexture;
    u.transmittanceLut!.value = luts.transmittance;
    u.multiscatterLut!.value = luts.multiscatter;
    u.camWorld!.value.copy(camera.matrixWorld);
    u.projInv!.value.copy(camera.projectionMatrixInverse);
    u.depthMode!.value = depth === "reversed" ? 1 : depth === "log" ? 2 : 0;
    u.logDepthFC!.value = 2.0 / (Math.log(camera.far + 1.0) / Math.LN2);
    u.toBodyFixed!.value.copy(toBodyFixed);
    u.center!.value.copy(p.center);
    u.rGround!.value = p.groundRadius;
    u.rTop!.value = p.topRadius;
    u.sunDir!.value.copy(p.sunDir);
    u.sunE!.value = p.sunIrradiance;
    if (p.moonDir) u.moonDir!.value.copy(p.moonDir);
    u.moonE!.value = p.moonIrradiance ?? 0;
    u.steps!.value = s.steps;
    u.lightSteps!.value = s.lightSteps;
    u.frame!.value = this.frame++ % 64;
    const half = this.halfTarget(dst.width, dst.height, s.scale);
    u.pixelAngle!.value = ((camera.fov * Math.PI) / 180) / half.height
    const img = u.coverageTex!.value.image as { width?: number } | undefined;
    u.texelMeters!.value = (2 * Math.PI * p.groundRadius) / (img?.width ?? 2048);
    r.setRenderTarget(half);
    this.quad.render(r);

    const v = this.upMat.uniforms;
    v.colorTex!.value = src.texture;
    v.depthTex!.value = src.depthTexture;
    v.cloudTex!.value = half.textures[0];
    v.auxTex!.value = half.textures[1];
    v.halfSize!.value.set(half.width, half.height);
    v.projInv!.value.copy(camera.projectionMatrixInverse);
    v.depthMode!.value = u.depthMode!.value;
    v.logDepthFC!.value = u.logDepthFC!.value;
    r.setRenderTarget(dst);
    this.upQuad.render(r);
  }
}
