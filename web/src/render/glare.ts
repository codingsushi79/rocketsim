// Veiling glare: the lens's point-spread function beyond the diffraction core, as an
// energy-conserving convolution.
//
// A fraction F of the light reaching each pixel is scattered (dust, surface roughness,
// internal reflections). For photographic lenses the veiling glare index is ~1–3 %
// (ISO 9358:1994; Kingslake, *Optics in Photography*, ch. 9); its PSF falls off roughly as
// θ⁻² … θ⁻³. We build it as a sum of Gaussians over a mip pyramid (σ_k ≈ 2^k px), with
// weights w_k ∝ σ_k^(2−n) for a θ⁻ⁿ profile (n = 3), normalised to F:
//   out = (1 − F)·in + F · Σ w_k·blur_k(in) / Σ w_k
// so total energy is preserved (unlike an additive "bloom", which brightens the image).
// Down- and upsampling: the 13-tap / tent filters of Jimenez 2014 ("Next Generation Post
// Processing in Call of Duty: Advanced Warfare", SIGGRAPH course).

import * as THREE from "three";
import { FullScreenQuad } from "three/examples/jsm/postprocessing/Pass.js";
import { QUAD_VS } from "./glsl";

/** Scattered fraction (veiling glare index) and PSF exponent. */
export const GLARE_FRACTION = 0.02;
const PSF_EXPONENT = 3;
const LEVELS = 7;

export class Glare {
  private down: THREE.WebGLRenderTarget[] = [];
  private up: THREE.WebGLRenderTarget[] = [];
  private downQuad: FullScreenQuad;
  private upQuad: FullScreenQuad;
  private combineQuad: FullScreenQuad;
  private w = 0;
  private h = 0;
  private weights: number[] = [];

  constructor() {
    this.downQuad = new FullScreenQuad(
      new THREE.ShaderMaterial({
        uniforms: { src: { value: null }, texel: { value: new THREE.Vector2() } },
        vertexShader: QUAD_VS,
        fragmentShader: /* glsl */ `
          uniform sampler2D src;
          uniform vec2 texel;
          varying vec2 vUv;
          vec3 s(vec2 o) { return min(texture2D(src, vUv + o * texel).rgb, vec3(6e4)); }
          void main() {
            // Jimenez 2014: 13 taps, five overlapping 4-tap boxes.
            vec3 a = s(vec2(-2, 2)), b = s(vec2(0, 2)), c = s(vec2(2, 2));
            vec3 d = s(vec2(-2, 0)), e = s(vec2(0, 0)), f = s(vec2(2, 0));
            vec3 g = s(vec2(-2, -2)), h = s(vec2(0, -2)), i = s(vec2(2, -2));
            vec3 j = s(vec2(-1, 1)), k = s(vec2(1, 1)), l = s(vec2(-1, -1)), m = s(vec2(1, -1));
            vec3 o = e * 0.125 + (a + c + g + i) * 0.03125 + (b + d + f + h) * 0.0625 + (j + k + l + m) * 0.125;
            gl_FragColor = vec4(o, 1.0);
          }`,
        depthTest: false,
        depthWrite: false,
      }),
    );
    this.upQuad = new FullScreenQuad(
      new THREE.ShaderMaterial({
        uniforms: { src: { value: null }, coarser: { value: null }, texel: { value: new THREE.Vector2() }, wSelf: { value: 1 }, hasCoarser: { value: 0 } },
        vertexShader: QUAD_VS,
        fragmentShader: /* glsl */ `
          uniform sampler2D src, coarser;
          uniform vec2 texel;
          uniform float wSelf, hasCoarser;
          varying vec2 vUv;
          void main() {
            // Accumulate this level's weighted blur plus the (tent-upsampled) coarser sum.
            vec3 acc = texture2D(src, vUv).rgb * wSelf;
            if (hasCoarser > 0.5) {
              vec3 t = vec3(0.0);
              t += texture2D(coarser, vUv + texel * vec2(-1, -1)).rgb;
              t += texture2D(coarser, vUv + texel * vec2(0, -1)).rgb * 2.0;
              t += texture2D(coarser, vUv + texel * vec2(1, -1)).rgb;
              t += texture2D(coarser, vUv + texel * vec2(-1, 0)).rgb * 2.0;
              t += texture2D(coarser, vUv).rgb * 4.0;
              t += texture2D(coarser, vUv + texel * vec2(1, 0)).rgb * 2.0;
              t += texture2D(coarser, vUv + texel * vec2(-1, 1)).rgb;
              t += texture2D(coarser, vUv + texel * vec2(0, 1)).rgb * 2.0;
              t += texture2D(coarser, vUv + texel * vec2(1, 1)).rgb;
              acc += t / 16.0;
            }
            gl_FragColor = vec4(acc, 1.0);
          }`,
        depthTest: false,
        depthWrite: false,
      }),
    );
    this.combineQuad = new FullScreenQuad(
      new THREE.ShaderMaterial({
        uniforms: { src: { value: null }, glare: { value: null }, F: { value: GLARE_FRACTION } },
        vertexShader: QUAD_VS,
        fragmentShader: /* glsl */ `
          uniform sampler2D src, glare;
          uniform float F;
          varying vec2 vUv;
          void main() {
            gl_FragColor = vec4(texture2D(src, vUv).rgb * (1.0 - F) + texture2D(glare, vUv).rgb * F, 1.0);
          }`,
        depthTest: false,
        depthWrite: false,
      }),
    );
    // w_k ∝ σ_k^(2−n), σ_k = 2^k, normalised to 1.
    const raw = Array.from({ length: LEVELS }, (_, k) => Math.pow(2, (k + 1) * (2 - PSF_EXPONENT)));
    const sum = raw.reduce((a, b) => a + b, 0);
    this.weights = raw.map((x) => x / sum);
  }

  private resize(w: number, h: number): void {
    if (w === this.w && h === this.h) return;
    this.w = w;
    this.h = h;
    for (const t of [...this.down, ...this.up]) t.dispose();
    this.down = [];
    this.up = [];
    let cw = w, ch = h;
    for (let k = 0; k < LEVELS; k++) {
      cw = Math.max(1, cw >> 1);
      ch = Math.max(1, ch >> 1);
      const opts = { type: THREE.HalfFloatType, depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter };
      this.down.push(new THREE.WebGLRenderTarget(cw, ch, opts));
      this.up.push(new THREE.WebGLRenderTarget(cw, ch, opts));
    }
  }

  /** In-place on `target` (via `scratch`): target ← (1−F)·target + F·PSF∗target. */
  render(r: THREE.WebGLRenderer, target: THREE.WebGLRenderTarget, scratch: THREE.WebGLRenderTarget): void {
    this.resize(target.width, target.height);
    const du = (this.downQuad.material as THREE.ShaderMaterial).uniforms;
    let src: THREE.WebGLRenderTarget = target;
    for (const d of this.down) {
      du.src!.value = src.texture;
      du.texel!.value.set(1 / src.width, 1 / src.height);
      r.setRenderTarget(d);
      this.downQuad.render(r);
      src = d;
    }
    const uu = (this.upQuad.material as THREE.ShaderMaterial).uniforms;
    for (let k = LEVELS - 1; k >= 0; k--) {
      uu.src!.value = this.down[k]!.texture;
      uu.wSelf!.value = this.weights[k]!;
      uu.hasCoarser!.value = k < LEVELS - 1 ? 1 : 0;
      if (k < LEVELS - 1) {
        uu.coarser!.value = this.up[k + 1]!.texture;
        uu.texel!.value.set(1 / this.up[k + 1]!.width, 1 / this.up[k + 1]!.height);
      }
      r.setRenderTarget(this.up[k]!);
      this.upQuad.render(r);
    }
    const cu = (this.combineQuad.material as THREE.ShaderMaterial).uniforms;
    cu.src!.value = target.texture;
    cu.glare!.value = this.up[0]!.texture;
    r.setRenderTarget(scratch);
    this.combineQuad.render(r);
  }
}
