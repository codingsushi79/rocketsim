// Camera lens effects driven by the Sun, in physical units (U, see units.ts):
//
// - Sun visibility: the fraction of the solar disk's radiance that reaches the camera,
//   measured from the HDR frame itself (so occlusion by bodies or the vehicle and the
//   atmosphere's reddening are included), written to a 1×1 target for the shaders.
// - Ghosts: ray-traced through the double-Gauss prescription (lensTrace.ts, lensWorker.ts;
//   Hullin et al. 2011), drawn as ray-grid meshes with per-vertex radiance.
// - Diffraction spikes: Fraunhofer diffraction by the straight edges of the polygonal stop.
//   Far from the core, the fraction of energy diffracted beyond angle θ is
//   λP / (π² A θ) for an aperture of perimeter P and area A (the edge-diffraction
//   asymptote; Born & Wolf, *Principles of Optics*, §8.5; for a circle it reduces to the
//   Airy tail 2λ/(π² a θ)). A polygon puts it in rays normal to its edges (one per
//   edge): per ray, dF/dθ = λP / (π² A θ² n). The extended solar disk blurs each ray to
//   about its own width.

import * as THREE from "three";
import { FullScreenQuad } from "three/examples/jsm/postprocessing/Pass.js";
import { QUAD_VS } from "./glsl";
import { BLADES, KEEP, THETA_MAX_DEG, THETA_STEPS, WAVELENGTHS, type GhostTable } from "./lensTrace";
import { PRE_EXPOSURE, SUN_RADIANCE_U } from "./units";

/** What the world knows about the Sun this frame. */
export interface SunState {
  /** Unit direction to the Sun in camera space (−z forward). */
  dirView: THREE.Vector3;
  /** Angular radius (rad). */
  angularRadius: number;
  /** Irradiance in units of E☉(1 au). */
  irradiance: number;
  /** Visibility from ray tests against the bodies (used when the disk is off-screen). */
  visibleCpu: number;
}

/** Straight fraction of each (rounded) aperture blade edge; assumed. */
const STRAIGHT_EDGE = 0.25;

/** The solar disk's clamp in SunView (fp16 headroom): measured visibility compares to it. */
export const SUN_DISK_CLAMP = 6e4;

export class LensEffects {
  private table: GhostTable | null = null;
  private visRT = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false });
  private visQuad: FullScreenQuad;
  private spikeQuad: FullScreenQuad;
  private ghostMesh: THREE.Mesh | null = null;
  private ghostScene = new THREE.Scene();
  private ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private pupilArea = 102;
  /** Artistic scale on top of the physical ghost radiance (1 = physical). */
  ghostScale = 1;

  constructor() {
    const worker = new Worker(new URL("./lensWorker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (e: MessageEvent<GhostTable>) => {
      this.table = e.data;
      this.pupilArea = e.data.pupilArea;
      this.buildGhostMesh();
      worker.terminate();
    };
    worker.postMessage(null);

    this.visQuad = new FullScreenQuad(
      new THREE.ShaderMaterial({
        uniforms: {
          src: { value: null },
          sunUv: { value: new THREE.Vector2() },
          radiusUv: { value: new THREE.Vector2() },
          expected: { value: 1 },
          cpuVis: { value: 1 },
          onScreen: { value: 0 },
        },
        vertexShader: QUAD_VS,
        fragmentShader: /* glsl */ `
          uniform sampler2D src;
          uniform vec2 sunUv, radiusUv;
          uniform float expected, cpuVis, onScreen;
          void main() {
            if (onScreen < 0.5) { gl_FragColor = vec4(vec3(cpuVis), 1.0); return; }
            // Mean radiance over the disk (9×9 samples) against the unobstructed disk.
            vec3 sum = vec3(0.0);
            float n = 0.0;
            for (int i = 0; i < 9; i++) {
              for (int j = 0; j < 9; j++) {
                vec2 o = vec2(float(i), float(j)) / 4.0 - 1.0;
                if (dot(o, o) > 1.0) continue;
                sum += texture2D(src, sunUv + o * radiusUv * 0.85).rgb;
                n += 1.0;
              }
            }
            vec3 v = clamp(sum / n / expected, 0.0, 1.0);
            gl_FragColor = vec4(v, 1.0);
          }`,
        depthTest: false,
        depthWrite: false,
      }),
    );

    this.spikeQuad = new FullScreenQuad(
      new THREE.ShaderMaterial({
        uniforms: {
          vis: { value: this.visRT.texture },
          sunDir: { value: new THREE.Vector3(0, 0, -1) },
          invProj: { value: new THREE.Matrix4() },
          sunE: { value: 1 },
          edgeK: { value: new THREE.Vector3() },
          width: { value: 1e-3 },
          minAngle: { value: 1e-3 },
          preExposure: PRE_EXPOSURE,
        },
        vertexShader: QUAD_VS,
        fragmentShader: /* glsl */ `
          uniform sampler2D vis;
          uniform vec3 sunDir, edgeK;
          uniform mat4 invProj;
          uniform float sunE, width, minAngle, preExposure;
          varying vec2 vUv;
          #define BLADES ${BLADES}
          void main() {
            vec4 p = invProj * vec4(vUv * 2.0 - 1.0, 1.0, 1.0);
            vec3 d = normalize(p.xyz / p.w);
            float theta = acos(clamp(dot(d, sunDir), -1.0, 1.0));
            if (theta > 1.2) discard;
            // Offset from the Sun in the image plane (tan space), as (along, across) per ray.
            vec2 q = d.xy / -d.z - sunDir.xy / -sunDir.z;
            float r = length(q);
            vec3 L = vec3(0.0);
            for (int k = 0; k < BLADES; k++) {
              // Ray directions normal to the blade edges (edges at 30° + k·60° for a hexagon
              // with a vertex at 0°, so the normals are at k·360°/n + 180°/n).
              float a = 3.14159265 * (2.0 * float(k) + 1.0) / float(BLADES);
              vec2 u = vec2(cos(a), sin(a));
              float along = dot(q, u);
              if (along <= 0.0) continue;
              float across = abs(q.x * u.y - q.y * u.x);
              // Normalised line profile (per radian across the ray).
              float prof = exp(-0.5 * across * across / (width * width)) / (width * 2.5066283);
              float t = max(theta, minAngle);
              L += edgeK / (t * t) * prof;
            }
            vec3 v = texture2D(vis, vec2(0.5)).rgb;
            gl_FragColor = vec4(3.14159265 * sunE * v * L * preExposure, 1.0);
          }`,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthTest: false,
        depthWrite: false,
      }),
    );
  }

  private buildGhostMesh(): void {
    const t = this.table!;
    const n = t.ghosts * 3;
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    g.setAttribute("ghost", new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4)); // x, y, r, K
    const col = new Float32Array(n * 3);
    for (let b = 0; b < n; b++) col[b * 3 + (b % 3)] = 1;
    g.setAttribute("col", new THREE.InstancedBufferAttribute(col, 3));
    g.instanceCount = n;
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        vis: { value: this.visRT.texture },
        rot: { value: new THREE.Vector2(1, 0) },
        scale: { value: new THREE.Vector2(1, 1) },
        sunE: { value: 1 },
        gain: { value: 1 },
        pxTan: { value: 1e-3 },
        preExposure: PRE_EXPOSURE,
      },
      vertexShader: /* glsl */ `
        attribute vec4 ghost;
        attribute vec3 col;
        uniform sampler2D vis;
        uniform vec2 rot, scale;
        uniform float sunE, gain, preExposure, pxTan;
        varying vec3 vL;
        varying vec2 vP;
        varying float vR, vEdge;
        void main() {
          // Lens frame: source at +x, image inverted; the screen sees −xy, rotated to the Sun.
          vec2 c = -ghost.xy;
          c = vec2(c.x * rot.x - c.y * rot.y, c.x * rot.y + c.y * rot.x);
          float r = ghost.z;
          vec3 v = texture2D(vis, vec2(0.5)).rgb;
          vL = r > 0.0 ? 3.14159265 * sunE * ghost.w * gain * col * v * preExposure : vec3(0.0);
          vP = position.xy * 1.15;
          vR = r;
          vEdge = max(1.5 * pxTan / max(r, 1e-6), 0.04);
          gl_Position = vec4((c + vP * r) * scale, 0.0, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        varying vec3 vL;
        varying vec2 vP;
        varying float vR, vEdge;
        #define BLADES ${BLADES}
        void main() {
          // Regular polygon (the stop, vertex at 0°, inverted by the lens: +180°), unit inradius·sec.
          float a = atan(vP.y, vP.x) + 3.14159265;
          float seg = 6.2831853 / float(BLADES);
          float local = a - seg * floor(a / seg + 0.5);
          float d = length(vP) * cos(local) / cos(3.14159265 / float(BLADES));
          float inside = 1.0 - smoothstep(1.0 - vEdge, 1.0 + vEdge, d);
          if (inside <= 0.0) discard;
          // Real ghosts are a little brighter at the rim (aperture-edge caustic).
          float rim = 1.0 + 0.5 * smoothstep(0.75, 1.0, d);
          gl_FragColor = vec4(vL * inside * rim, 1.0);
        }`,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthTest: false,
      depthWrite: false,
    });
    this.ghostMesh = new THREE.Mesh(g, mat);
    this.ghostMesh.frustumCulled = false;
    this.ghostScene.add(this.ghostMesh);
  }

  /** Interpolate the ghost table at field angle θ (rad). */
  private updateGhosts(theta: number): void {
    const t = this.table!;
    const f = Math.min(THETA_STEPS - 1.001, (theta / ((THETA_MAX_DEG * Math.PI) / 180)) * (THETA_STEPS - 1));
    const i0 = Math.floor(f), w = f - i0;
    const attr = this.ghostMesh!.geometry.getAttribute("ghost") as THREE.InstancedBufferAttribute;
    const A = attr.array as Float32Array;
    for (let b = 0; b < t.ghosts * 3; b++) {
      const a0 = (i0 * KEEP * 3 + b) * 4, a1 = ((i0 + 1) * KEEP * 3 + b) * 4;
      const r0 = t.data[a0 + 2]!, r1 = t.data[a1 + 2]!;
      if (r0 <= 0 || r1 <= 0) {
        A[b * 4 + 2] = 0;
        continue;
      }
      for (let c = 0; c < 4; c++) A[b * 4 + c] = t.data[a0 + c]! + (t.data[a1 + c]! - t.data[a0 + c]!) * w;
    }
    attr.needsUpdate = true;
  }

  /** Measure the Sun's visibility in `hdr` and add spikes and ghosts into it. */
  render(r: THREE.WebGLRenderer, hdr: THREE.WebGLRenderTarget, camera: THREE.PerspectiveCamera, sun: SunState | null, spikes: boolean): void {
    if (!sun || sun.irradiance <= 0) return;
    const theta = Math.acos(Math.max(-1, Math.min(1, -sun.dirView.z)));
    const maxTheta = (THETA_MAX_DEG * Math.PI) / 180;
    // On screen? Project the Sun's centre.
    const tanV = Math.tan(((camera.fov * Math.PI) / 180) / 2);
    const tanH = tanV * camera.aspect;
    const sx = sun.dirView.x / -sun.dirView.z, sy = sun.dirView.y / -sun.dirView.z;
    const onScreen = sun.dirView.z < 0 && Math.abs(sx) < tanH && Math.abs(sy) < tanV;
    if (!onScreen && theta > maxTheta) return;

    const vu = (this.visQuad.material as THREE.ShaderMaterial).uniforms;
    vu.src!.value = hdr.texture;
    vu.sunUv!.value.set(0.5 + (0.5 * sx) / tanH, 0.5 + (0.5 * sy) / tanV);
    const rTan = Math.tan(sun.angularRadius);
    // At least half a texel, so a sub-pixel disk is still sampled.
    const h = hdr.height, w = hdr.width;
    vu.radiusUv!.value.set(Math.max((0.5 * rTan) / tanH, 0.5 / w), Math.max((0.5 * rTan) / tanV, 0.5 / h));
    // A disk smaller than a pixel lights the whole pixel at full radiance (no AA), so the
    // expected value is the disk radiance either way.
    vu.expected!.value = Math.min(SUN_RADIANCE_U * PRE_EXPOSURE.value, SUN_DISK_CLAMP);
    vu.cpuVis!.value = sun.visibleCpu;
    vu.onScreen!.value = onScreen ? 1 : 0;
    r.setRenderTarget(this.visRT);
    this.visQuad.render(r);

    r.setRenderTarget(hdr);
    if (spikes && onScreen) {
      const su = (this.spikeQuad.material as THREE.ShaderMaterial).uniforms;
      su.sunDir!.value.copy(sun.dirView);
      su.invProj!.value.copy(camera.projectionMatrixInverse);
      su.sunE!.value = sun.irradiance;
      // λ·(P/A)/(π² n) per channel; regular polygon of area A: inradius ri = √(A/(n·tan(π/n))),
      // perimeter P = 2·n·ri·tan(π/n), so P/A = 2/ri.
      const ri = Math.sqrt(this.pupilArea / (BLADES * Math.tan(Math.PI / BLADES))) * 1e-3;
      const PA = 2 / ri;
      // Real lenses have rounded blades: only part of each edge is straight, and only the
      // straight part diffracts into a spike. STRAIGHT_EDGE (assumed, typical of modern
      // rounded-blade stops) scales the spike energy; the rest goes into the diffuse halo.
      su.edgeK!.value.set(...(WAVELENGTHS.map((l) => (STRAIGHT_EDGE * l * 1e-9 * PA) / (Math.PI * Math.PI * BLADES)) as [number, number, number]));
      const px = (2 * tanV) / h;
      su.width!.value = Math.max(0.25 * sun.angularRadius, 0.7 * px);
      su.minAngle!.value = Math.max(2 * sun.angularRadius, 3 * px);
      this.spikeQuad.render(r);
    }
    if (this.ghostMesh && theta < maxTheta) {
      this.updateGhosts(theta);
      const gu = (this.ghostMesh.material as THREE.ShaderMaterial).uniforms;
      const len = Math.hypot(sx, sy);
      gu.rot!.value.set(len > 1e-9 ? sx / len : 1, len > 1e-9 ? sy / len : 0);
      gu.scale!.value.set(1 / tanH, 1 / tanV);
      gu.sunE!.value = sun.irradiance;
      gu.gain!.value = this.ghostScale;
      gu.pxTan!.value = (2 * tanV) / hdr.height;
      r.render(this.ghostScene, this.ortho);
    }
  }
}
