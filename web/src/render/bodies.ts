// Celestial body meshes. Geometry is built in the body-fixed frame (x toward 0°
// longitude, z north) and oriented each frame by the core's ICRF→body-fixed rotation,
// so the ground lines up with the physics.

import * as THREE from "three";
import { RING_GLSL } from "./rings";
import { PRE_EXPOSURE, SUN_RADIANCE_U } from "./units";

/** Lat/lon ellipsoid in the body-fixed frame. UV: u = (lon + 180°)/360°,
 *  v = (lat + 90°)/180° (equirectangular maps with north at the top). */
export function ellipsoidGeometry(a: number, b: number, c: number, nLon: number, nLat: number): THREE.BufferGeometry {
  const pos: number[] = [], nor: number[] = [], uv: number[] = [], idx: number[] = [];
  for (let j = 0; j <= nLat; j++) {
    const v = j / nLat;
    const lat = -Math.PI / 2 + v * Math.PI;
    const cl = Math.cos(lat), sl = Math.sin(lat);
    for (let i = 0; i <= nLon; i++) {
      const u = i / nLon;
      const lon = -Math.PI + u * 2 * Math.PI;
      // Point on the ellipsoid at parametric-equals-geodetic approximation is fine for
      // texturing; the outward normal is the true ellipsoid normal.
      const x = a * cl * Math.cos(lon), y = b * cl * Math.sin(lon), z = c * sl;
      pos.push(x, y, z);
      const n = new THREE.Vector3(x / (a * a), y / (b * b), z / (c * c)).normalize();
      nor.push(n.x, n.y, n.z);
      uv.push(u, v);
    }
  }
  for (let j = 0; j < nLat; j++) {
    for (let i = 0; i < nLon; i++) {
      const p = j * (nLon + 1) + i, q = p + nLon + 1;
      idx.push(p, p + 1, q, q, p + 1, q + 1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("normal", new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}

const COMMON_VS = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_vertex>
  varying vec2 vUv;
  varying vec3 vNormalW;
  void main() {
    vUv = uv;
    vNormalW = normalize(mat3(modelMatrix) * normal);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    #include <logdepthbuf_vertex>
  }
`;

/** Night-lights radiance per unit (linear) Black Marble texture value, in U. Rough
 *  calibration: VIIRS DNB city radiances are ~1e-8–1e-7 W cm⁻² sr⁻¹ against ~1e-2 for
 *  sunlit land, i.e. ~1e-6 of daylight. */
export const NIGHT_LIGHTS_U = 2e-6;

/** GLSL: city lights from a linear Black Marble texel. The composite has a dim blue
 *  base layer (ocean ≈ sRGB (5,5,15), deserts ≈ (37,34,63)) that is artwork, not light
 *  (real night-side airglow is ~4e-9 U, far below it), so it is subtracted first. */
export const NIGHT_LIGHTS_GLSL = /* glsl */ `
  vec3 cityLights(vec3 t) { return max(t - vec3(0.022, 0.020, 0.055), vec3(0.0)); }
`;

/** Ocean surface roughness for the glint: GGX α ≈ the RMS slope of Cox & Munk (1954)
 *  for ~5 m/s wind, σ² ≈ 0.003 + 5.12e-3·U ≈ 0.029 → α ≈ 0.17. */
const OCEAN_ALPHA = 0.17;
/** Water's normal-incidence Fresnel reflectance (n ≈ 1.33): ((n−1)/(n+1))² ≈ 0.02. */
const WATER_F0 = 0.02;

/** Earth: Blue Marble day albedo, Black Marble night lights, ocean glint (Natural Earth
 *  water mask, GGX + Schlick), and shadows of the cloud layer (Blue Marble clouds). */
export class EarthView {
  readonly mesh: THREE.Mesh;
  private mat: THREE.ShaderMaterial;

  constructor(day: THREE.Texture, night: THREE.Texture, water: THREE.Texture, clouds: THREE.Texture, a: number, c: number, segments: number) {
    for (const t of [day, night]) {
      t.colorSpace = THREE.SRGBColorSpace;
      t.anisotropy = 8;
      t.generateMipmaps = true;
      t.minFilter = THREE.LinearMipmapLinearFilter;
    }
    for (const t of [water, clouds]) {
      t.colorSpace = THREE.NoColorSpace;
      t.anisotropy = 8;
    }
    this.mat = new THREE.ShaderMaterial({
      uniforms: {
        dayMap: { value: day },
        nightMap: { value: night },
        waterMap: { value: water },
        cloudMap: { value: clouds },
        sunDir: { value: new THREE.Vector3(1, 0, 0) },
        sunE: { value: 1 },
        nightScale: { value: NIGHT_LIGHTS_U },
        moonDir: { value: new THREE.Vector3(0, 0, 1) },
        moonE: { value: 0 },
        cloudShadows: { value: 1 },
        preExposure: PRE_EXPOSURE,
        /** Radius scale: pulled 2 km inward while 3D tiles cover the surface. */
        inset: { value: 1 },
      },
      vertexShader: /* glsl */ `
        #include <common>
        #include <logdepthbuf_pars_vertex>
        uniform float inset;
        varying vec2 vUv;
        varying vec3 vNormalW;
        varying vec3 vViewW;
        void main() {
          vUv = uv;
          vNormalW = normalize(mat3(modelMatrix) * normal);
          vec4 wp = modelMatrix * vec4(position * inset, 1.0);
          vViewW = cameraPosition - wp.xyz;
          gl_Position = projectionMatrix * viewMatrix * wp;
          #include <logdepthbuf_vertex>
        }`,
      fragmentShader: /* glsl */ `
        #include <common>
        #include <logdepthbuf_pars_fragment>
        uniform sampler2D dayMap, nightMap, waterMap, cloudMap;
        uniform vec3 sunDir;
        uniform float sunE, nightScale, preExposure, cloudShadows;
        ${NIGHT_LIGHTS_GLSL}
        varying vec2 vUv;
        varying vec3 vNormalW;
        varying vec3 vViewW;
        const float ALPHA = ${OCEAN_ALPHA.toFixed(4)};
        const float F0 = ${WATER_F0.toFixed(4)};
        uniform vec3 moonDir;
        uniform float moonE;
        // Specular glint: L = π·f·E·cosθ in U (units.ts), f = D·F·G/(4 n·l n·v); returns f·cosθ.
        float glint(vec3 n, vec3 v, vec3 l) {
          float ndl = dot(n, l);
          if (ndl <= 0.0) return 0.0;
          vec3 h = normalize(l + v);
          float ndh = max(dot(n, h), 0.0);
          float ndv = max(dot(n, v), 1e-4);
          float a2 = ALPHA * ALPHA;
          float dd = ndh * ndh * (a2 - 1.0) + 1.0;
          float D = a2 / (PI * dd * dd);
          float k = ALPHA * 0.5;
          float G = (ndl / (ndl * (1.0 - k) + k)) * (ndv / (ndv * (1.0 - k) + k));
          float F = F0 + (1.0 - F0) * pow(1.0 - max(dot(v, h), 0.0), 5.0);
          return D * F * G / (4.0 * ndl * ndv) * ndl;
        }
        void main() {
          #include <logdepthbuf_fragment>
          vec3 n = normalize(vNormalW);
          vec3 v = normalize(vViewW);
          float ndl = dot(n, sunDir);
          vec3 albedo = texture2D(dayMap, vUv).rgb;
          float water = texture2D(waterMap, vUv).r;
          // Cloud shadow: coverage sampled toward the Sun (cloud deck ~3 km up).
          float cov = smoothstep(0.12, 0.8, texture2D(cloudMap, vUv).r);
          float shadow = 1.0 - cloudShadows * 0.75 * cov;
          vec3 day = albedo * sunE * max(ndl, 0.0) * shadow;
          day += vec3(PI * glint(n, v, sunDir) * sunE) * water * shadow;
          // Moonlight (moonlight.ts): ~2.5e-6 of sunlight at full moon, so it only shows on
          // the night side, with its glint on the sea, to a dark-adapted exposure.
          float ndm = dot(n, moonDir);
          day += (albedo * max(ndm, 0.0) + vec3(PI * glint(n, v, moonDir)) * water) * moonE * shadow;
          vec3 lights = cityLights(texture2D(nightMap, vUv).rgb) * nightScale * (1.0 - smoothstep(-0.08, 0.06, ndl)) * (1.0 - 0.8 * cov);
          gl_FragColor = vec4((day + lights) * preExposure, 1.0);
        }`,
    });
    this.mesh = new THREE.Mesh(ellipsoidGeometry(a, a, c, segments * 2, segments), this.mat);
    this.mesh.frustumCulled = false;
  }

  setSun(dir: THREE.Vector3, irradiance: number): void {
    this.mat.uniforms.sunDir!.value.copy(dir);
    this.mat.uniforms.sunE!.value = irradiance;
  }

  /** Moonlight on the globe: direction to the Moon and its irradiance (E☉ units). */
  setMoon(dir: THREE.Vector3, irradiance: number): void {
    this.mat.uniforms.moonDir!.value.copy(dir);
    this.mat.uniforms.moonE!.value = irradiance;
  }

  /** Shrink the globe below the 3D tiles (1 = full size). */
  setInset(scale: number): void {
    this.mat.uniforms.inset!.value = scale;
  }
}

/** A Lambertian body of uniform albedo (until M8 brings mission textures). */
export class PlainBody {
  readonly mesh: THREE.Mesh;
  private mat: THREE.ShaderMaterial;

  constructor(a: number, b: number, c: number, albedo: THREE.Color, segments: number) {
    this.mat = new THREE.ShaderMaterial({
      uniforms: { albedo: { value: albedo }, sunDir: { value: new THREE.Vector3(1, 0, 0) }, sunE: { value: 1 }, preExposure: PRE_EXPOSURE },
      vertexShader: COMMON_VS,
      fragmentShader: /* glsl */ `
        #include <common>
        #include <logdepthbuf_pars_fragment>
        uniform vec3 albedo, sunDir;
        uniform float sunE, preExposure;
        varying vec2 vUv;
        varying vec3 vNormalW;
        void main() {
          #include <logdepthbuf_fragment>
          gl_FragColor = vec4(albedo * sunE * max(dot(normalize(vNormalW), sunDir), 0.0) * preExposure, 1.0);
        }`,
    });
    this.mesh = new THREE.Mesh(ellipsoidGeometry(a, b, c, segments, segments / 2), this.mat);
    this.mesh.frustumCulled = false;
  }

  setSun(dir: THREE.Vector3, irradiance: number): void {
    this.mat.uniforms.sunDir!.value.copy(dir);
    this.mat.uniforms.sunE!.value = irradiance;
  }
}

/** A whole-globe texture (gas giants, Venus's cloud deck, Titan's haze), Lambertian with
 *  the albedo gain from `tools/assets/prepare_globes.py`. Optionally shadowed by rings.
 *  `shell` lifts the rendered surface above the reference ellipsoid (cloud tops); with the
 *  camera below the shell it collapses onto the surface and hides. */
export class GlobeBody {
  readonly mesh: THREE.Mesh;
  private mat: THREE.ShaderMaterial;
  private sunB = new THREE.Vector3();
  private q = new THREE.Quaternion();

  constructor(
    map: THREE.Texture,
    gain: number,
    readonly radii: [number, number, number],
    readonly shell: number,
    segments: number,
    rings: THREE.Texture | null = null,
    ringRange: [number, number] = [0, 0],
  ) {
    const [a, b, c] = radii;
    this.mat = new THREE.ShaderMaterial({
      uniforms: {
        map: { value: map },
        gain: { value: gain },
        sunDir: { value: new THREE.Vector3(1, 0, 0) },
        sunB: { value: this.sunB },
        sunE: { value: 1 },
        ringMap: { value: rings },
        ringRange: { value: new THREE.Vector2(...ringRange) },
        preExposure: PRE_EXPOSURE,
      },
      defines: rings ? { RINGS: 1 } : {},
      vertexShader: /* glsl */ `
        #include <common>
        #include <logdepthbuf_pars_vertex>
        varying vec2 vUv;
        varying vec3 vNormalW;
        varying vec3 vPosB;
        void main() {
          vUv = uv;
          vPosB = position;
          vNormalW = normalize(mat3(modelMatrix) * normal);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          #include <logdepthbuf_vertex>
        }`,
      fragmentShader: /* glsl */ `
        #include <common>
        #include <logdepthbuf_pars_fragment>
        #ifdef RINGS
        ${RING_GLSL}
        #endif
        uniform sampler2D map;
        uniform vec3 sunDir, sunB;
        uniform float sunE, gain, preExposure;
        varying vec2 vUv;
        varying vec3 vNormalW;
        varying vec3 vPosB;
        void main() {
          #include <logdepthbuf_fragment>
          vec3 albedo = texture2D(map, vUv).rgb * gain;
          float ndl = max(dot(normalize(vNormalW), sunDir), 0.0);
          #ifdef RINGS
          ndl *= ringShadow(vPosB, sunB);
          #endif
          gl_FragColor = vec4(albedo * sunE * ndl * preExposure, 1.0);
        }`,
    });
    this.mesh = new THREE.Mesh(ellipsoidGeometry(a + shell, b + shell, c + shell, segments, segments / 2), this.mat);
    this.mesh.frustumCulled = false;
  }

  setSun(dir: THREE.Vector3, irradiance: number): void {
    this.mat.uniforms.sunDir!.value.copy(dir);
    this.mat.uniforms.sunE!.value = irradiance;
    // Body-fixed Sun direction for the ring shadow (the quaternion is set before this).
    this.sunB.copy(dir).applyQuaternion(this.q.copy(this.mesh.quaternion).invert());
  }

  /** Hide the shell when the camera (distance from the centre) is below it. */
  setCameraDistance(d: number): void {
    if (this.shell > 0) this.mesh.visible = this.mesh.visible && d > this.radii[0] + this.shell;
  }
}

/** A 1×1 texture of a linear colour (for untextured globes such as Titan's haze). */
export function solidTexture(r: number, g: number, b: number): THREE.DataTexture {
  const t = new THREE.DataTexture(new Uint8Array([r * 255, g * 255, b * 255, 255]), 1, 1);
  t.colorSpace = THREE.NoColorSpace;
  t.needsUpdate = true;
  return t;
}

/** The Sun: a disk of physical radiance (≈46,240 U; bloom does the glare). */
export class SunView {
  readonly mesh: THREE.Mesh;

  constructor(radius: number) {
    const mat = new THREE.ShaderMaterial({
      uniforms: { radiance: { value: SUN_RADIANCE_U }, preExposure: PRE_EXPOSURE },
      vertexShader: COMMON_VS,
      fragmentShader: /* glsl */ `
        #include <common>
        #include <logdepthbuf_pars_fragment>
        uniform float radiance, preExposure;
        varying vec2 vUv;
        varying vec3 vNormalW;
        void main() {
          #include <logdepthbuf_fragment>
          // Uniform disk (limb darkening is invisible under bloom at these scales).
          gl_FragColor = vec4(vec3(1.0, 0.96, 0.9) * min(radiance * preExposure, 6e4), 1.0);
        }`,
    });
    this.mesh = new THREE.Mesh(ellipsoidGeometry(radius, radius, radius, 64, 32), mat);
    this.mesh.frustumCulled = false;
  }
}

/** Geometric albedos (V band) for point-source brightness: NASA GSFC planetary fact sheets. */
export const GEOMETRIC_ALBEDO: Record<number, number> = {
  199: 0.142,
  299: 0.689,
  399: 0.434,
  301: 0.12,
  499: 0.17,
  599: 0.538,
  699: 0.499,
  799: 0.488,
  899: 0.442,
  999: 0.52,
};

/** Approximate body tints for uniform-albedo rendering (until textures arrive in M8). */
export const BODY_TINT: Record<number, [number, number, number]> = {
  199: [0.14, 0.13, 0.12],
  299: [0.69, 0.62, 0.5],
  301: [0.13, 0.12, 0.115],
  499: [0.26, 0.15, 0.09],
  599: [0.55, 0.5, 0.42],
  699: [0.55, 0.5, 0.38],
  799: [0.4, 0.55, 0.6],
  899: [0.3, 0.4, 0.62],
  999: [0.5, 0.45, 0.4],
};
