// Sky: Milky Way background (NASA SVS Deep Star Maps 2020) and Hipparcos stars with
// correct positions (proper motion applied to the simulation epoch), magnitudes and
// colors. Drawn in the sky pass (rotation-only camera, at infinity). Render axes are
// ICRF axes.

import * as THREE from "three";
import { MILKY_WAY_WHITE_U, PRE_EXPOSURE, irradianceFromMagnitude } from "./units";

const SKY_RADIUS = 5; // inside the sky camera's near/far range

/** Unit vector for right ascension / declination (rad), ICRF axes. */
export function radecToVector(ra: number, dec: number): THREE.Vector3 {
  const c = Math.cos(dec);
  return new THREE.Vector3(c * Math.cos(ra), c * Math.sin(ra), Math.sin(dec));
}

/** B−V → linear sRGB color of a blackbody (Ballesteros 2012 temperature, then a
 *  Planck-weighted approximation), normalized to unit luminance. */
export function starColor(bv: number): THREE.Color {
  const b = Math.min(Math.max(bv, -0.4), 2.0);
  const t = 4600 * (1 / (0.92 * b + 1.7) + 1 / (0.92 * b + 0.62));
  // Planck spectrum sampled at representative R, G, B wavelengths.
  const planck = (lambdaNm: number) => {
    const l = lambdaNm * 1e-9;
    return 1 / (Math.pow(l, 5) * (Math.exp(1.4388e-2 / (l * t)) - 1));
  };
  const r = planck(610), g = planck(550), bl = planck(465);
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  return new THREE.Color(r / lum, g / lum, bl / lum);
}

interface StarRecord {
  ra: number; // deg, J1991.25
  dec: number;
  v: number;
  bv: number;
  pmra: number; // mas/yr, μα·cosδ
  pmde: number;
}

export async function loadStars(url: string): Promise<StarRecord[]> {
  const buf = await (await fetch(url)).arrayBuffer();
  const dv = new DataView(buf);
  const n = dv.getUint32(0, true);
  const out: StarRecord[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const o = 4 + i * 24;
    out[i] = {
      ra: dv.getFloat32(o, true),
      dec: dv.getFloat32(o + 4, true),
      v: dv.getFloat32(o + 8, true),
      bv: dv.getFloat32(o + 12, true),
      pmra: dv.getFloat32(o + 16, true),
      pmde: dv.getFloat32(o + 20, true),
    };
  }
  return out;
}

/** Star point sprites. Each star delivers its irradiance spread over a small Gaussian
 *  footprint: pixel radiance = π·E / Ω_footprint (U; see units.ts). */
export class StarField {
  readonly points: THREE.Points;
  private mat: THREE.ShaderMaterial;

  constructor(stars: StarRecord[], limitMag: number, tdbYearsSinceJ2000: number) {
    const sel = stars.filter((s) => s.v <= limitMag);
    const pos = new Float32Array(sel.length * 3);
    const col = new Float32Array(sel.length * 3);
    const irr = new Float32Array(sel.length);
    // Hipparcos epoch J1991.25 → simulation epoch (linear proper motion; < 0.1″
    // error over a century for all but a handful of stars).
    const dt = tdbYearsSinceJ2000 + 8.75;
    const d2r = Math.PI / 180;
    sel.forEach((s, i) => {
      const dec = s.dec + (s.pmde * dt) / 3.6e6;
      const ra = s.ra + (s.pmra * dt) / 3.6e6 / Math.max(Math.cos(s.dec * d2r), 1e-6);
      const v = radecToVector(ra * d2r, dec * d2r).multiplyScalar(SKY_RADIUS);
      pos.set([v.x, v.y, v.z], i * 3);
      const c = starColor(s.bv);
      col.set([c.r, c.g, c.b], i * 3);
      irr[i] = irradianceFromMagnitude(s.v);
    });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
    geo.setAttribute("irradiance", new THREE.BufferAttribute(irr, 1));
    this.mat = new THREE.ShaderMaterial({
      uniforms: { pixelSolidAngle: { value: 1e-7 }, boost: { value: 1 }, size: { value: 3 }, preExposure: PRE_EXPOSURE },
      vertexShader: /* glsl */ `
        attribute float irradiance;
        attribute vec3 color;
        uniform float size;
        varying vec3 vColor;
        varying float vIrr;
        void main() {
          vColor = color;
          vIrr = irradiance;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = size;
        }`,
      fragmentShader: /* glsl */ `
        uniform float pixelSolidAngle, boost, size, preExposure;
        varying vec3 vColor;
        varying float vIrr;
        void main() {
          // Gaussian footprint normalized so it integrates to one over the sprite.
          vec2 d = (gl_PointCoord - 0.5) * size;
          float sigma = 0.6;
          float w = exp(-dot(d, d) / (2.0 * sigma * sigma)) / (6.2831853 * sigma * sigma);
          gl_FragColor = vec4(min(vColor * (3.14159265 * vIrr / pixelSolidAngle) * w * boost * preExposure, vec3(6e4)), 1.0);
        }`,
      blending: THREE.AdditiveBlending,
      depthTest: false,
      depthWrite: false,
      transparent: true,
    });
    this.points = new THREE.Points(geo, this.mat);
    this.points.frustumCulled = false;
  }

  update(radiansPerPixel: number, boost: number): void {
    this.mat.uniforms.pixelSolidAngle!.value = radiansPerPixel * radiansPerPixel;
    this.mat.uniforms.boost!.value = boost;
  }
}

/** Milky Way on an inside-out sphere. Mapping (verified against the Magellanic Clouds
 *  in tools/assets/prepare_textures.py): u = 0.5 − RA/360, v = (90° − Dec)/180° from the top. */
export class MilkyWay {
  readonly mesh: THREE.Mesh;
  private mat: THREE.ShaderMaterial;

  constructor(texture: THREE.Texture) {
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.generateMipmaps = true;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.anisotropy = 8;
    const nu = 256, nv = 128;
    const pos: number[] = [], uv: number[] = [], idx: number[] = [];
    for (let j = 0; j <= nv; j++) {
      const v = j / nv; // 0 at top (north)
      const dec = (Math.PI / 2) * (1 - 2 * v);
      for (let i = 0; i <= nu; i++) {
        const u = i / nu;
        const ra = (0.5 - u) * 2 * Math.PI;
        const p = radecToVector(ra, dec).multiplyScalar(SKY_RADIUS);
        pos.push(p.x, p.y, p.z);
        uv.push(u, 1 - v); // texture flipY: v=1 is the top row
      }
    }
    for (let j = 0; j < nv; j++) {
      for (let i = 0; i < nu; i++) {
        const a = j * (nu + 1) + i, b = a + nu + 1;
        idx.push(a, b, a + 1, b, b + 1, a + 1);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
    geo.setIndex(idx);
    this.mat = new THREE.ShaderMaterial({
      uniforms: { map: { value: texture }, scale: { value: MILKY_WAY_WHITE_U }, preExposure: PRE_EXPOSURE },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: /* glsl */ `
        uniform sampler2D map;
        uniform float scale, preExposure;
        varying vec2 vUv;
        void main() { gl_FragColor = vec4(texture2D(map, vUv).rgb * scale * preExposure, 1.0); }`,
      side: THREE.BackSide,
      depthTest: false,
      depthWrite: false,
    });
    this.mesh = new THREE.Mesh(geo, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -10;
  }

  setBoost(boost: number): void {
    this.mat.uniforms.scale!.value = MILKY_WAY_WHITE_U * boost;
  }
}

/** Planets and the Moon as point sources when smaller than a pixel. Irradiance at the
 *  observer: E = E☉(planet)·p·(R/d)²·Φ(α), with a Lambert phase function. */
export class PlanetPoints {
  readonly points: THREE.Points;
  private pos: Float32Array;
  private irr: Float32Array;
  private col: Float32Array;
  private mat: THREE.ShaderMaterial;
  readonly capacity: number;

  constructor(capacity: number) {
    this.capacity = capacity;
    this.pos = new Float32Array(capacity * 3);
    this.irr = new Float32Array(capacity);
    this.col = new Float32Array(capacity * 3).fill(1);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(this.pos, 3));
    geo.setAttribute("irradiance", new THREE.BufferAttribute(this.irr, 1));
    geo.setAttribute("color", new THREE.BufferAttribute(this.col, 3));
    // Same shader as the stars.
    const star = new StarField([], -99, 0);
    this.mat = (star.points.material as THREE.ShaderMaterial).clone();
    this.mat.uniforms.preExposure = PRE_EXPOSURE; // clone() copies values; share the live one
    this.points = new THREE.Points(geo, this.mat);
    this.points.frustumCulled = false;
  }

  set(i: number, dir: THREE.Vector3, irradiance: number, color: THREE.Color): void {
    this.pos.set([dir.x * SKY_RADIUS, dir.y * SKY_RADIUS, dir.z * SKY_RADIUS], i * 3);
    this.irr[i] = irradiance;
    this.col.set([color.r, color.g, color.b], i * 3);
  }

  commit(count: number, radiansPerPixel: number): void {
    const g = this.points.geometry;
    g.attributes.position!.needsUpdate = true;
    g.attributes.irradiance!.needsUpdate = true;
    g.attributes.color!.needsUpdate = true;
    g.setDrawRange(0, count);
    this.mat.uniforms.pixelSolidAngle!.value = radiansPerPixel * radiansPerPixel;
  }
}

/** Lambert-sphere phase function Φ(α) (normalized to 1 at full phase). */
export function lambertPhase(alpha: number): number {
  return (Math.sin(alpha) + (Math.PI - alpha) * Math.cos(alpha)) / Math.PI;
}
