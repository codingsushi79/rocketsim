// Shared GLSL snippets.

/** Shader snippet: view-space distance along the pixel ray from a depth sample. */
export const DEPTH_GLSL = /* glsl */ `
  uniform int depthMode;      // 0 = standard, 1 = reversed (zero-to-one), 2 = logarithmic
  uniform float logDepthFC;   // three's logDepthBufFC = 2 / log2(far + 1)
  uniform mat4 projInv;
  // Returns +infinity for background pixels.
  float viewDepth(float d, vec2 ndc) {
    if (depthMode == 1) {
      if (d <= 0.0) return 1e30;
      vec4 v = projInv * vec4(ndc, d, 1.0);
      return -v.z / v.w;
    } else if (depthMode == 2) {
      if (d >= 1.0) return 1e30;
      return exp2(d * 2.0 / logDepthFC) - 1.0;
    } else {
      if (d >= 1.0) return 1e30;
      vec4 v = projInv * vec4(ndc, d * 2.0 - 1.0, 1.0);
      return -v.z / v.w;
    }
  }
`;

export const QUAD_VS = /* glsl */ `
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;
