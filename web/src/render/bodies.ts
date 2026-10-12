// Celestial body meshes. Geometry is built in the body-fixed frame (x toward 0°
// longitude, z north) and oriented each frame by the core's ICRF→body-fixed rotation,
// so the ground lines up with the physics.

import * as THREE from "three";
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
const NIGHT_LIGHTS_U = 2e-6;

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
        varying vec2 vUv;
        varying vec3 vNormalW;
        varying vec3 vViewW;
        const float ALPHA = ${OCEAN_ALPHA.toFixed(4)};
        const float F0 = ${WATER_F0.toFixed(4)};
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
          // Specular glint: L = π·f·E·cosθ in U (units.ts), f = D·F·G/(4 n·l n·v).
          if (water > 0.01 && ndl > 0.0) {
            vec3 h = normalize(sunDir + v);
            float ndh = max(dot(n, h), 0.0);
            float ndv = max(dot(n, v), 1e-4);
            float a2 = ALPHA * ALPHA;
            float dd = ndh * ndh * (a2 - 1.0) + 1.0;
            float D = a2 / (PI * dd * dd);
            float k = ALPHA * 0.5;
            float G = (ndl / (ndl * (1.0 - k) + k)) * (ndv / (ndv * (1.0 - k) + k));
            float F = F0 + (1.0 - F0) * pow(1.0 - max(dot(v, h), 0.0), 5.0);
            float spec = D * F * G / (4.0 * ndl * ndv);
            day += vec3(PI * spec * sunE * ndl) * water * shadow;
          }
          vec3 lights = texture2D(nightMap, vUv).rgb * nightScale * (1.0 - smoothstep(-0.08, 0.06, ndl)) * (1.0 - 0.8 * cov);
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
