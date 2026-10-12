// Volumetric clouds: a ray-marched cloud shell around the Earth, depth-aware,
// composited before the atmosphere pass.
//
// - **Where.** Coverage is NASA Blue Marble: Clouds (Visible Earth 57747; MODIS
//   composite), looked up by body-fixed latitude and longitude so it turns with the
//   Earth. A tiling 3D Worley noise volume erodes it for structure below the map's
//   texel size.
// - **Profile.** The base is at 1.5 km. The top rises with coverage, from 3 km (thin
//   cumulus) to 12 km (deep convection).
// - **Optics.** Each column's optical depth reproduces the map's reflectance with a
//   two-stream relation (see cloudSigma), spread over the height profile.
//   Single-scattering albedo ≈ 1. Phase is a dual-lobe Henyey–Greenstein (g = 0.8 / −0.3).
// - **Multiple scattering.** Approximated with Wrenninge's octave method (M. Wrenninge et
//   al., "Oz: The Great and Volumetric", SIGGRAPH 2013 talk): Σ aⁱ σ_s T(bⁱτ) P(cⁱg) with
//   a = b = c = ½.
// - **Sun.** Light comes through the cloud (a short light march) and through the
//   atmosphere (the transmittance LUT, which also gives the Earth's shadow and reddened
//   sunsets).
// - **Sky.** A small ambient term for skylight.
//
// Output: rgb = scene·T + L, alpha = distance (km) at which the cloud becomes opaque
// (transmittance below ½), so the atmosphere pass applies aerial perspective to the cloud
// instead of the ground behind it.

import * as THREE from "three";
import { FullScreenQuad } from "three/examples/jsm/postprocessing/Pass.js";
import { ATMOSPHERE_GLSL, type AtmosphereParams } from "./atmosphere";
import type { ActiveDepth } from "./engine";
import { DEPTH_GLSL, QUAD_VS } from "./glsl";
import { PRE_EXPOSURE } from "./units";

const NOISE_SIZE = 64;

/** Tileable 3D Worley noise (3 octaves, inverted, 0–1), R8. Deterministic. */
function worleyVolume(n: number): THREE.Data3DTexture {
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
  const t = new THREE.Data3DTexture(data, n, n, n);
  t.format = THREE.RedFormat;
  t.type = THREE.UnsignedByteType;
  t.wrapS = t.wrapT = t.wrapR = THREE.RepeatWrapping;
  t.minFilter = t.magFilter = THREE.LinearFilter;
  t.unpackAlignment = 1;
  t.needsUpdate = true;
  return t;
}

const FS = /* glsl */ `
  precision highp float;
  precision highp sampler3D;
  layout(location = 0) out highp vec4 cloudOut;
  #define gl_FragColor cloudOut
  uniform sampler2D colorTex;
  uniform sampler2D depthTex;
  uniform sampler2D coverageTex;
  uniform sampler3D noiseTex;
  uniform mat4 camWorld;
  uniform mat3 toBodyFixed;
  uniform vec3 center;
  uniform float rGround, rTop;
  uniform vec3 sunDir;
  uniform float sunE;
  uniform int steps;
  uniform int lightSteps;
  uniform float preExposure;
  uniform float frame;
  uniform float pixelAngle;
  uniform float texelMeters;
  varying vec2 vUv;
  ${DEPTH_GLSL}
  #define ATMO_LUTS
  ${ATMOSPHERE_GLSL}

  const float CLOUD_BASE = 1500.0;
  const float CLOUD_TOP_MAX = 12000.0;
  const float NOISE_SCALE = 1.0 / 24000.0; // noise period 24 km

  float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }

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
  float cloudSigma(vec3 q, float detail, float lod) {
    float r = length(q);
    float h = r - rGround;
    if (h < CLOUD_BASE || h > CLOUD_TOP_MAX) return 0.0;
    vec3 bf = toBodyFixed * q;
    float lon = atan(bf.y, bf.x);
    float lat = asin(clamp(bf.z / r, -1.0, 1.0));
    vec2 uv = vec2(lon / (2.0 * PI) + 0.5, lat / PI + 0.5);
    // Explicit LOD: derivatives are undefined inside the march loop.
    float raw = textureLod(coverageTex, uv, lod).r;
    // ~0.08 is the clear-sky floor of the composite.
    float R = clamp((raw - 0.08) / 0.88, 0.0, 0.92);
    if (R <= 0.0) return 0.0;
    float tau = 7.5 * R / (1.0 - R);
    float top = CLOUD_BASE + 1000.0 + (CLOUD_TOP_MAX - CLOUD_BASE - 1000.0) * smoothstep(0.1, 0.9, R);
    float hn = (h - CLOUD_BASE) / (top - CLOUD_BASE);
    if (hn >= 1.0) return 0.0;
    // Profile with unit mean over the column: quick rise, rounded top.
    float profile = smoothstep(0.0, 0.12, hn) * (1.0 - smoothstep(0.45, 1.0, hn)) / 0.58;
    float sigma = tau / (top - CLOUD_BASE) * profile;
    if (detail > 0.0) {
      float n = texture(noiseTex, bf * NOISE_SCALE).r * 0.7 + texture(noiseTex, bf * NOISE_SCALE * 3.7).r * 0.3;
      sigma *= mix(1.0, clamp(2.2 * n - 0.6, 0.0, 2.0), detail * (1.0 - 0.5 * R));
    }
    return sigma;
  }

  void main() {
    vec4 scene = texture2D(colorTex, vUv);
    vec2 ndc = vUv * 2.0 - 1.0;
    vec4 vd = projInv * vec4(ndc, 0.5, 1.0);
    vec3 viewDir = normalize(vd.xyz / vd.w);
    vec3 dir = normalize((camWorld * vec4(viewDir, 0.0)).xyz);
    float vz = viewDepth(texture2D(depthTex, vUv).r, ndc);
    float sceneDist = vz / max(-viewDir.z, 1e-6);

    vec3 o = -center;
    float rIn = rGround + CLOUD_BASE, rOut = rGround + CLOUD_TOP_MAX;
    vec2 outer = hitSphere(o, dir, rOut);
    if (outer.y <= 0.0 || outer.x > outer.y) { gl_FragColor = vec4(scene.rgb, 0.0); return; }
    float t0 = max(outer.x, 0.0);
    float t1 = outer.y;
    vec2 inner = hitSphere(o, dir, rIn);
    float rc = length(o);
    if (rc > rIn) {
      // Above the base: stop where the ray enters the cloud-free core.
      if (inner.x > 0.0) t1 = min(t1, inner.x);
    } else if (inner.y > 0.0) {
      // Below the base: start where the ray leaves the core.
      t0 = max(t0, inner.y);
    }
    vec2 ground = hitSphere(o, dir, rGround);
    if (ground.x > 0.0) t1 = min(t1, ground.x);
    t1 = min(t1, sceneDist);
    // From low altitude, the shell is long and grazing: cap the marched distance.
    t1 = min(t1, t0 + 300000.0);
    if (t1 <= t0) { gl_FragColor = vec4(scene.rgb, 0.0); return; }

    // Adaptive steps: about 250 m of altitude change per sample (the layer is only a few
    // km thick, so grazing rays need long steps along the ray but not across the layer).
    float jitter = hash(gl_FragCoord.xy + frame * 0.618);
    float mu = dot(dir, sunDir);
    vec3 T = vec3(1.0);
    vec3 L = vec3(0.0);
    float opaqueAt = 0.0;
    float maxIter = float(steps) * 4.0;
    float t = t0;
    for (int i = 0; i < 1100; i++) {
      if (float(i) >= maxIter || t >= t1) break;
      vec3 qa = o + dir * t;
      float cosZ = abs(dot(dir, qa) / length(qa));
      float ds = clamp(300.0 / max(cosZ, 0.03), 150.0, 5000.0);
      float tc = t + ds * jitter;
      t += ds;
      if (tc > t1) break;
      vec3 q = o + dir * tc;
      float detail = 1.0 - smoothstep(20000.0, 120000.0, tc);
      // Mip level from the pixel footprint vs. the map's texel size at the equator.
      float lod = max(log2(tc * pixelAngle / texelMeters), 0.0);
      float sigma = cloudSigma(q, detail, lod);
      if (sigma <= 0.0) continue;
      // Light march toward the Sun through the cloud.
      float od = 0.0;
      float lds = 600.0;
      for (int j = 0; j < 8; j++) {
        if (j >= lightSteps) break;
        od += cloudSigma(q + sunDir * (lds * (float(j) + 0.5)), detail, lod) * lds;
        lds *= 1.6;
      }
      float rq = length(q);
      vec3 tAtm = transmittanceToTop(rq, dot(q, sunDir) / rq);
      // Wrenninge multiple-scattering octaves.
      float ms = 0.0;
      float a = 1.0, b = 1.0, c = 1.0;
      for (int k = 0; k < 4; k++) {
        ms += a * exp(-b * od) * phase(mu, c);
        a *= 0.5; b *= 0.5; c *= 0.5;
      }
      // Skylight: a few percent of the attenuated sunlight, isotropic.
      vec3 ambient = tAtm * 0.035 + vec3(0.004, 0.006, 0.01) * smoothstep(-0.1, 0.2, dot(q / rq, sunDir));
      vec3 S = PI * sunE * (tAtm * ms + ambient);
      float stepT = exp(-sigma * ds);
      // Energy-conserving integration over the step (Hillaire 2015, "Physically based
      // and unified volumetric rendering in Frostbite").
      L += T * S * (1.0 - stepT);
      T *= stepT;
      if (opaqueAt == 0.0 && T.g < 0.5) opaqueAt = tc;
      if (T.g < 0.003) break;
    }
    gl_FragColor = vec4(scene.rgb * T + L * preExposure, opaqueAt * 0.001);
  }
`;

export interface CloudSettings {
  /** Primary ray-march steps (0 = clouds off). */
  steps: number;
  lightSteps: number;
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
    this.mat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      uniforms: {
        colorTex: { value: null },
        depthTex: { value: null },
        coverageTex: { value: coverage },
        noiseTex: { value: worleyVolume(NOISE_SIZE) },
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
    u.colorTex!.value = src.texture;
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
    u.steps!.value = s.steps;
    u.lightSteps!.value = s.lightSteps;
    u.frame!.value = this.frame++ % 64;
    u.pixelAngle!.value = ((camera.fov * Math.PI) / 180) / Math.max(1, dst.height);
    const img = u.coverageTex!.value.image as { width?: number } | undefined;
    u.texelMeters!.value = (2 * Math.PI * p.groundRadius) / (img?.width ?? 2048);
    r.setRenderTarget(dst);
    this.quad.render(r);
  }
}
