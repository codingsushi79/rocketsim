// Renderer: HDR pipeline with floating origin, reversed-Z float depth (or logarithmic
// depth as the fallback), atmosphere post-pass, lens effects (Sun visibility, diffraction
// spikes, ray-traced ghosts), auto-exposure, veiling glare and AgX tone mapping.
//
// Floating origin (spec §1): the camera always sits at the render-space origin. All
// positions are computed in f64 (JS numbers) relative to the camera and only then
// stored in three.js objects, so nothing large is ever rounded to f32 on the GPU.

import * as THREE from "three";
import { FullScreenQuad } from "three/examples/jsm/postprocessing/Pass.js";
import type { DepthMode, GraphicsSettings } from "../settings";
import { EXPOSURE_MAX, EXPOSURE_MIN, PRE_EXPOSURE } from "./units";
import { AtmospherePass, type AtmosphereParams } from "./atmosphere";
import type { CloudPass, CloudSettings } from "./clouds";
import { QUAD_VS } from "./glsl";
import { Glare } from "./glare";
import { LensEffects, type SunState } from "./lens";

export type ActiveDepth = "reversed" | "log" | "standard";

const LUM_SIZE = 256;

export class Engine {
  readonly renderer: THREE.WebGLRenderer;
  readonly camera: THREE.PerspectiveCamera;
  readonly skyScene = new THREE.Scene();
  readonly scene = new THREE.Scene();
  readonly depth: ActiveDepth;
  readonly atmosphere: AtmospherePass;
  /** Volumetric clouds (set once the coverage texture is loaded). */
  clouds: CloudPass | null = null;
  cloudSettings: CloudSettings = { steps: 48, lightSteps: 5 };
  private cloudRT!: THREE.WebGLRenderTarget;
  /** Current exposure as a GPU texture (r = exposure, g = metered mean luminance), for
   *  overlays that must keep a fixed display brightness (orbit lines, markers). */
  readonly exposureUniform: { value: THREE.Texture | null } = { value: null };

  private hdr!: THREE.WebGLRenderTarget;
  private composited!: THREE.WebGLRenderTarget;
  private exposed!: THREE.WebGLRenderTarget;
  private lum: THREE.WebGLRenderTarget;
  private adapt: [THREE.WebGLRenderTarget, THREE.WebGLRenderTarget];
  private adaptIndex = 0;
  private glare = new Glare();
  private glared!: THREE.WebGLRenderTarget;
  readonly lens = new LensEffects();
  /** The Sun this frame (set by the world before render). */
  sun: SunState | null = null;
  private lumQuad: FullScreenQuad;
  private adaptQuad: FullScreenQuad;
  private exposeQuad: FullScreenQuad;
  private outputQuad: FullScreenQuad;
  private settings: GraphicsSettings;
  private size = new THREE.Vector2(1, 1);
  private firstFrame = true;
  /** Fixed exposure override (tests); null = auto. */
  fixedExposure: number | null = null;

  constructor(canvas: HTMLCanvasElement, settings: GraphicsSettings, forceDepth?: DepthMode | "standard", preserveDrawingBuffer = false) {
    this.settings = settings;
    const want = forceDepth ?? settings.depthMode;
    const make = (opts: Partial<THREE.WebGLRendererParameters>) =>
      new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: "high-performance", preserveDrawingBuffer, ...opts });
    let renderer: THREE.WebGLRenderer;
    let depth: ActiveDepth;
    if (want === "standard") {
      renderer = make({});
      depth = "standard";
    } else if (want === "log") {
      renderer = make({ logarithmicDepthBuffer: true });
      depth = "log";
    } else {
      renderer = make({ reversedDepthBuffer: true });
      depth = "reversed";
      if (!renderer.capabilities.reversedDepthBuffer) {
        // EXT_clip_control unavailable: fall back to logarithmic depth. The context
        // has no clip-control state set, so it can be reused by the new renderer.
        renderer.dispose();
        renderer = make({ logarithmicDepthBuffer: true });
        depth = "log";
      }
    }
    this.renderer = renderer;
    this.depth = depth;
    renderer.autoClear = false;
    renderer.toneMapping = THREE.NoToneMapping;
    renderer.outputColorSpace = THREE.LinearSRGBColorSpace; // tone/OETF applied in our output pass

    this.camera = new THREE.PerspectiveCamera(50, 1, 0.05, 1e13);
    this.camera.position.set(0, 0, 0);

    const halfRT = (w: number, h: number, opts: THREE.RenderTargetOptions = {}) =>
      new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: false, ...opts });
    this.lum = halfRT(LUM_SIZE, LUM_SIZE, { generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter });
    // Exposure is stored as log2 in float32 (it spans ~1e-3 to 3e7).
    const floatRT = () => new THREE.WebGLRenderTarget(1, 1, { type: THREE.FloatType, format: THREE.RGBAFormat, depthBuffer: false });
    this.adapt = [floatRT(), floatRT()];
    this.createTargets(1, 1);

    this.atmosphere = new AtmospherePass();

    this.lumQuad = new FullScreenQuad(
      new THREE.ShaderMaterial({
        uniforms: { src: { value: null }, preExposure: PRE_EXPOSURE },
        vertexShader: QUAD_VS,
        fragmentShader: /* glsl */ `
          uniform sampler2D src;
          uniform float preExposure;
          varying vec2 vUv;
          void main() {
            vec3 c = texture2D(src, vUv).rgb;
            float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
            // Meter on lit pixels only (r = Σ l·w, g = Σ w, b = Σ l over all pixels),
            // so a bright object against black space is exposed for the object.
            // Clamp single-pixel extremes (the solar disk) so they don't dominate.
            l = min(l, 64.0);
            // "Lit" means above 1e-6 U in absolute radiance (40× the brightest Milky
            // Way, MILKY_WAY_WHITE_U ≈ 2.7e-8 U), so the sky never counts however far
            // the pre-exposure has opened up.
            // Centre-weighted (as camera metering): the focus object is at the centre.
            vec2 d = vUv - 0.5;
            float cw = 1.0 + 4.0 * exp(-dot(d, d) / 0.02);
            float w = l / preExposure > 1e-6 ? cw : 0.0;
            gl_FragColor = vec4(l * w, w, l, 1.0);
          }`,
      }),
    );
    this.adaptQuad = new FullScreenQuad(
      new THREE.ShaderMaterial({
        uniforms: {
          lum: { value: null },
          prev: { value: null },
          rate: { value: 1 },
          first: { value: 1 },
          minExp: { value: EXPOSURE_MIN },
          sunE: { value: 0 },
          maxExp: { value: EXPOSURE_MAX },
          lod: { value: Math.log2(LUM_SIZE) },
          preExposure: PRE_EXPOSURE,
        },
        vertexShader: QUAD_VS,
        fragmentShader: /* glsl */ `
          uniform sampler2D lum, prev;
          uniform float rate, first, minExp, maxExp, lod, preExposure, sunE;
          varying vec2 vUv;
          void main() {
            // The luminance buffer is pre-exposed: divide by preExposure for true U.
            // Mean luminance of lit pixels (1×1 mip) when they cover > 1% of the frame
            // (an object, a planet, city lights); otherwise (stars and Milky Way only)
            // the mean over all pixels, which opens up the exposure like a dark-adapted eye.
            vec3 m = textureLod(lum, vec2(0.5), lod).rgb;
            float mean = (m.g > 0.01 ? m.r / m.g : m.b) / preExposure;
            mean = max(mean, 1e-15);
            // Key: 0.18 for lit scenes; 0.012 for star-only views (a dark sky stays dark).
            float key = m.g > 0.01 ? 0.18 : 0.012;
            float ex = clamp(key / mean, minExp, maxExp);
            // Sunlit scenes: never brighter than the "sunny 16" exposure for the local solar
            // irradiance E (an 18 % grey card facing the Sun → 0.18), as a camera set for
            // daylight would be. Sunlit regolith (albedo 0.12) then reads dark grey, as in
            // real photographs, instead of being metered up to mid-grey. Applies when the
            // lit pixels are sunlit (mean above 0.3 % of E), not to city lights at night.
            if (sunE > 0.0 && m.g > 0.01 && mean > 0.003 * sunE) ex = min(ex, 1.0 / sunE);
            float target = log2(ex);
            float p = texture2D(prev, vec2(0.5)).r;
            float e = first > 0.5 ? target : mix(p, target, rate);
            gl_FragColor = vec4(e, log2(mean), 1.0, 1.0); // log2(exposure), log2(mean U)
          }`,
      }),
    );
    this.exposeQuad = new FullScreenQuad(
      new THREE.ShaderMaterial({
        uniforms: { src: { value: null }, exposureTex: { value: null }, fixedExposure: { value: -1 }, preExposure: PRE_EXPOSURE },
        vertexShader: QUAD_VS,
        fragmentShader: /* glsl */ `
          uniform sampler2D src, exposureTex;
          uniform float fixedExposure, preExposure;
          varying vec2 vUv;
          void main() {
            float e = fixedExposure > 0.0 ? fixedExposure : exp2(texture2D(exposureTex, vec2(0.5)).r);
            // Clamp to fp16 range (the solar disk can exceed it after a large exposure step).
            gl_FragColor = vec4(min(texture2D(src, vUv).rgb * (e / preExposure), vec3(6e4)), 1.0);
          }`,
      }),
    );
    for (const q of [this.lumQuad, this.adaptQuad, this.exposeQuad]) {
      (q.material as THREE.Material).depthTest = false;
      (q.material as THREE.Material).depthWrite = false;
    }
    this.outputQuad = new FullScreenQuad(
      new THREE.ShaderMaterial({
        uniforms: { src: { value: null }, toneMappingExposure: { value: 1 } },
        vertexShader: QUAD_VS,
        fragmentShader: /* glsl */ `
          #include <tonemapping_pars_fragment>
          uniform sampler2D src;
          varying vec2 vUv;
          void main() {
            vec3 c = AgXToneMapping(texture2D(src, vUv).rgb);
            gl_FragColor = sRGBTransferOETF(vec4(c, 1.0));
          }`,
        depthTest: false,
        depthWrite: false,
      }),
    );
  }

  private createTargets(w: number, h: number): void {
    this.hdr?.dispose();
    this.composited?.dispose();
    this.exposed?.dispose();
    const depthTexture = new THREE.DepthTexture(w, h, THREE.FloatType);
    this.hdr = new THREE.WebGLRenderTarget(w, h, {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      depthBuffer: true,
      depthTexture,
      samples: this.settings.msaa,
    });
    this.composited = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, depthBuffer: false });
    this.cloudRT?.dispose();
    this.cloudRT = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, depthBuffer: false });
    this.exposed = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, depthBuffer: false });
    this.glared?.dispose();
    this.glared = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, depthBuffer: false });
  }

  applySettings(s: GraphicsSettings): void {
    const msaaChanged = s.msaa !== this.settings.msaa;
    this.settings = s;
    if (msaaChanged) this.createTargets(this.size.x, this.size.y);
    this.resize(true);
  }

  resize(force = false): void {
    const canvas = this.renderer.domElement;
    const cw = canvas.clientWidth || window.innerWidth;
    const ch = canvas.clientHeight || window.innerHeight;
    const ratio = Math.min(window.devicePixelRatio || 1, 3) * this.settings.renderScale;
    const w = Math.max(1, Math.floor(cw * ratio));
    const h = Math.max(1, Math.floor(ch * ratio));
    if (!force && w === this.size.x && h === this.size.y) return;
    this.size.set(w, h);
    this.renderer.setPixelRatio(1);
    this.renderer.setSize(w, h, false);
    this.createTargets(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  get pixelSize(): THREE.Vector2 {
    return this.size;
  }

  /** Radians per pixel at the screen center (for point-source rendering). */
  get radiansPerPixel(): number {
    return ((this.camera.fov * Math.PI) / 180) / this.size.y;
  }

  render(dt: number, atmo: AtmosphereParams | null): void {
    const r = this.renderer;
    this.resize();
    // 1. Sky (infinitely far: rotation only) and scene into the HDR target. Overlays
    // read last frame's exposure.
    this.exposureUniform.value = this.adapt[this.adaptIndex]!.texture;
    r.setRenderTarget(this.hdr);
    r.setClearColor(0x000000, 1);
    r.clear(true, true, true);
    const camQ = this.camera.quaternion;
    const skyCam = this.skyCamera;
    skyCam.quaternion.copy(camQ);
    skyCam.fov = this.camera.fov;
    skyCam.aspect = this.camera.aspect;
    skyCam.updateProjectionMatrix();
    r.render(this.skyScene, skyCam);
    r.render(this.scene, this.camera);

    // 2. Atmosphere: in-scattering and transmittance along each pixel ray.
    let clouds: THREE.Texture | null = null;
    const cs = this.settings.cloudSteps ?? 48;
    this.cloudSettings = { steps: cs, lightSteps: cs <= 32 ? 3 : cs <= 64 ? 5 : 6 };
    if (atmo && atmo.toBodyFixed && this.clouds && cs > 0) {
      const luts = this.atmosphere.luts(r, atmo);
      this.clouds.render(r, this.hdr, this.cloudRT, this.camera, this.depth, atmo, luts, atmo.toBodyFixed, this.cloudSettings);
      clouds = this.cloudRT.texture;
    }
    this.atmosphere.render(r, this.hdr, this.composited, this.camera, this.depth, atmo, this.settings.atmosphereSteps, clouds);

    // 2b. Lens: Sun visibility from the frame, then diffraction spikes and ghosts (added
    // before metering, as on a real sensor).
    if (this.settings.bloom) this.lens.render(r, this.composited, this.camera, this.sun, true);

    // 3. Auto-exposure: mean luminance → adapted exposure (GPU only, no readback).
    (this.lumQuad.material as THREE.ShaderMaterial).uniforms.src!.value = this.composited.texture;
    r.setRenderTarget(this.lum);
    this.lumQuad.render(r);
    const prev = this.adapt[this.adaptIndex]!;
    const next = this.adapt[1 - this.adaptIndex]!;
    const au = (this.adaptQuad.material as THREE.ShaderMaterial).uniforms;
    au.lum!.value = this.lum.texture;
    au.prev!.value = prev.texture;
    au.rate!.value = 1 - Math.exp(-dt * 2.5);
    au.first!.value = this.firstFrame ? 1 : 0;
    au.sunE!.value = this.sun?.irradiance ?? 0;
    r.setRenderTarget(next);
    this.adaptQuad.render(r);
    this.adaptIndex = 1 - this.adaptIndex;
    this.firstFrame = false;

    // 4. Exposure, bloom, tone mapping.
    const eu = (this.exposeQuad.material as THREE.ShaderMaterial).uniforms;
    eu.src!.value = this.composited.texture;
    eu.exposureTex!.value = next.texture;
    eu.fixedExposure!.value = this.fixedExposure ?? -1;
    r.setRenderTarget(this.exposed);
    this.exposeQuad.render(r);
    let out = this.exposed;
    if (this.settings.bloom) {
      this.glare.render(r, this.exposed, this.glared);
      out = this.glared;
    }
    (this.outputQuad.material as THREE.ShaderMaterial).uniforms.src!.value = out.texture;
    r.setRenderTarget(null);
    this.outputQuad.render(r);

    // Pre-exposure for the next frame: last adapted exposure, read back asynchronously
    // (no pipeline stall; a frame or two of lag is harmless).
    if (this.fixedExposure !== null) {
      PRE_EXPOSURE.value = this.fixedExposure;
    } else if (!this.readbackPending) {
      this.readbackPending = true;
      r.readRenderTargetPixelsAsync(next, 0, 0, 1, 1, this.readback)
        .then((v) => {
          const e = Math.pow(2, (v as Float32Array)[0]!);
          if (Number.isFinite(e) && e > 0) PRE_EXPOSURE.value = e;
        })
        .catch(() => {})
        .finally(() => (this.readbackPending = false));
    }
  }

  private readback = new Float32Array(4);
  private readbackPending = false;

  /** Current exposure estimate (display value per U), for the debug overlay. */
  get exposure(): number {
    return PRE_EXPOSURE.value;
  }

  /** Camera for the sky pass: same orientation and lens, at the origin. */
  private skyCamera = new THREE.PerspectiveCamera(50, 1, 0.1, 10);

  forceExposure(e: number | null): void {
    this.fixedExposure = e;
    if (e !== null) PRE_EXPOSURE.value = e;
  }

  resetAdaptation(): void {
    this.firstFrame = true;
  }

  dispose(): void {
    this.hdr.dispose();
    this.composited.dispose();
    this.exposed.dispose();
    this.lum.dispose();
    this.adapt.forEach((t) => t.dispose());
    this.renderer.dispose();
  }
}
