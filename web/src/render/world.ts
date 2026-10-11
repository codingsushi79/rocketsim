// Scene orchestration: reads the simulation state each frame (f64), builds the
// floating-origin render space (camera at the origin), and feeds the engine.

import * as THREE from "three";
import type { BodyRow } from "../core";
import type { Settings } from "../settings";
import type { Simulation } from "../sim/simulation";
import { BODY_TINT, EarthView, GEOMETRIC_ALBEDO, PlainBody, SunView } from "./bodies";
import { OrbitCamera } from "./camera";
import type { Engine } from "./engine";
import { MilkyWay, PlanetPoints, StarField, lambertPhase } from "./sky";
import { placeholderSpacecraft } from "./spacecraft";
import { PRE_EXPOSURE } from "./units";

const AU = 149_597_870_700;
const SUN = 10;
const EARTH = 399;
/** Focus value meaning "the spacecraft". */
export const FOCUS_SPACECRAFT = -1;

export interface WorldAssets {
  day: THREE.Texture;
  night: THREE.Texture;
  milkyWay: THREE.Texture;
  stars: Awaited<ReturnType<typeof import("./sky").loadStars>>;
}

interface BodyEntry {
  row: BodyRow;
  view: PlainBody | EarthView | SunView;
  /** Last render-space position (for picking/labels). */
  pos: THREE.Vector3;
  visible: boolean;
}

type V = [number, number, number];
const sub = (a: V, b: V): V => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: V, b: V): V => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const len = (a: V) => Math.hypot(a[0], a[1], a[2]);
const vec = (a: V) => new THREE.Vector3(a[0], a[1], a[2]);

export class World {
  readonly camera: OrbitCamera;
  focus: number = FOCUS_SPACECRAFT;
  private bodies = new Map<number, BodyEntry>();
  private spacecraft = placeholderSpacecraft();
  private sunLight = new THREE.DirectionalLight(0xffffff, 1);
  private earthshine = new THREE.DirectionalLight(0x9fb4d9, 0);
  private orbitLine: THREE.Line;
  private orbitPositions = new Float32Array(512 * 3);
  private stars: StarField;
  private milkyWay: MilkyWay;
  private planetPoints = new PlanetPoints(32);
  private settings: Settings;
  /** Center body of the spacecraft state (for the HUD). */
  centerId = EARTH;

  constructor(
    private engine: Engine,
    private sim: Simulation,
    bodies: BodyRow[],
    assets: WorldAssets,
    settings: Settings,
  ) {
    this.settings = settings;
    this.camera = new OrbitCamera(engine.renderer.domElement);
    const seg = settings.graphics.bodySegments;
    for (const row of bodies) {
      const [a, b, c] = row.radii;
      let view: BodyEntry["view"];
      if (row.id === SUN) view = new SunView(a);
      else if (row.id === EARTH) view = new EarthView(assets.day, assets.night, a, c, seg);
      else {
        const t = BODY_TINT[row.id] ?? [0.3, 0.3, 0.3];
        view = new PlainBody(a, b, c, new THREE.Color(t[0], t[1], t[2]), Math.max(32, seg / 2));
      }
      engine.scene.add(view.mesh);
      this.bodies.set(row.id, { row, view, pos: new THREE.Vector3(), visible: true });
    }
    engine.scene.add(this.spacecraft);
    engine.scene.add(this.sunLight, this.sunLight.target, this.earthshine, this.earthshine.target);

    const lineGeo = new THREE.BufferGeometry();
    lineGeo.setAttribute("position", new THREE.BufferAttribute(this.orbitPositions, 3));
    this.orbitLine = new THREE.Line(lineGeo, overlayLineMaterial(engine, new THREE.Color(0.25, 0.6, 1.0)));
    this.orbitLine.frustumCulled = false;
    engine.scene.add(this.orbitLine);

    this.milkyWay = new MilkyWay(assets.milkyWay);
    this.stars = new StarField(assets.stars, settings.graphics.starLimitMag, this.yearsSinceJ2000());
    engine.skyScene.add(this.milkyWay.mesh, this.stars.points, this.planetPoints.points);
  }

  private yearsSinceJ2000(): number {
    return this.sim.sim.epochTdb() / (365.25 * 86400);
  }

  applySettings(s: Settings, assets: WorldAssets): void {
    const starsChanged = s.graphics.starLimitMag !== this.settings.graphics.starLimitMag;
    this.settings = s;
    if (starsChanged) {
      this.engine.skyScene.remove(this.stars.points);
      this.stars = new StarField(assets.stars, s.graphics.starLimitMag, this.yearsSinceJ2000());
      this.engine.skyScene.add(this.stars.points);
    }
  }

  /** Focus targets in cycle order. */
  focusTargets(): number[] {
    return [FOCUS_SPACECRAFT, EARTH, 301, SUN, 499, 599, 699];
  }

  cycleFocus(dir: 1 | -1): void {
    const t = this.focusTargets();
    const i = t.indexOf(this.focus);
    this.focus = t[(i + dir + t.length) % t.length]!;
    const row = this.bodies.get(this.focus)?.row;
    this.camera.minDistance = row ? row.radii[0] * 1.05 : 1.5;
    this.camera.setDistance(row ? row.radii[0] * 3.5 : 30, true);
  }

  focusName(): string {
    return this.focus === FOCUS_SPACECRAFT ? "Spacecraft" : (this.bodies.get(this.focus)?.row.name ?? "?");
  }

  update(dt: number): THREE.Vector3 | null {
    const s = this.sim.sim;
    const sc = s.spacecraft();
    if (sc.length < 8) return null;
    const center = sc[0]!;
    this.centerId = center;
    const rsc: V = [sc[1]!, sc[2]!, sc[3]!];
    const vsc: V = [sc[4]!, sc[5]!, sc[6]!];

    // Every body relative to the spacecraft's center (core's common-ancestor path).
    const rel = new Map<number, V>();
    for (const id of this.bodies.keys()) {
      try {
        const r = s.relativeState(id, center);
        rel.set(id, [r[0]!, r[1]!, r[2]!]);
      } catch {
        // Outside the loaded ephemeris coverage: hide.
      }
    }
    const sunRel = rel.get(SUN) ?? [AU, 0, 0];

    // Focus and camera (f64, center frame).
    const focusPos: V = this.focus === FOCUS_SPACECRAFT ? rsc : (rel.get(this.focus) ?? rsc);
    let up = vec(focusPos);
    if (up.lengthSq() < 1) up = new THREE.Vector3(0, 0, 1);
    up.normalize();
    const fwdRef = this.focus === FOCUS_SPACECRAFT ? vec(vsc) : new THREE.Vector3(0, 0, 1).cross(up);
    if (fwdRef.lengthSq() < 1e-12) fwdRef.set(1, 0, 0);
    fwdRef.normalize();
    this.camera.update(dt);
    const { offset } = this.camera.offset(up, fwdRef);
    const cam = add(focusPos, offset);

    // Bodies.
    let nPoints = 0;
    const rpp = this.engine.radiansPerPixel;
    for (const [id, e] of this.bodies) {
      const r = rel.get(id);
      e.view.mesh.visible = r !== undefined;
      if (!r) continue;
      const p = sub(r, cam);
      e.pos.set(p[0], p[1], p[2]);
      e.view.mesh.position.copy(e.pos);
      const frame = s.bodyFrame(id);
      if (frame.length === 9) {
        // ICRF→body-fixed R (row-major); the mesh needs body-fixed→ICRF = Rᵀ.
        const m = new THREE.Matrix4().set(
          frame[0]!, frame[3]!, frame[6]!, 0,
          frame[1]!, frame[4]!, frame[7]!, 0,
          frame[2]!, frame[5]!, frame[8]!, 0,
          0, 0, 0, 1,
        );
        e.view.mesh.quaternion.setFromRotationMatrix(m);
      }
      if (id !== SUN && !(e.view instanceof SunView)) {
        const toSun = sub(sunRel, r);
        const dSun = len(toSun);
        const irr = (AU / dSun) ** 2;
        e.view.setSun(vec(toSun).normalize(), irr);
        // Point source when smaller than ~1.5 px.
        const dist = len(p);
        const radius = e.row.radii[0];
        if (radius / dist < 1.5 * rpp && nPoints < this.planetPoints.capacity) {
          const alpha = vec(toSun).angleTo(vec(sub(cam, r)));
          const albedo = GEOMETRIC_ALBEDO[id] ?? 0.2;
          const e2 = irr * albedo * (radius / dist) ** 2 * lambertPhase(alpha);
          const tint = BODY_TINT[id] ?? [1, 1, 1];
          const l = 0.2126 * tint[0] + 0.7152 * tint[1] + 0.0722 * tint[2];
          this.planetPoints.set(nPoints++, vec(p).normalize(), e2, new THREE.Color(tint[0] / l, tint[1] / l, tint[2] / l));
        }
      }
    }
    this.planetPoints.commit(nPoints, rpp);

    // Spacecraft: prograde attitude (body +x along velocity, +z along the orbit normal).
    const scPos = sub(rsc, cam);
    this.spacecraft.position.set(scPos[0], scPos[1], scPos[2]);
    const xb = vec(vsc).normalize();
    const zb = vec(rsc).cross(vec(vsc)).normalize();
    const yb = new THREE.Vector3().crossVectors(zb, xb);
    this.spacecraft.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(xb, yb, zb));

    // Lighting at the spacecraft: Sun (with eclipses) and earthshine from the center body.
    const toSun = sub(sunRel, rsc);
    const eSun = (AU / len(toSun)) ** 2;
    const sunDir = vec(toSun).normalize();
    this.sunLight.position.copy(this.spacecraft.position).add(sunDir);
    this.sunLight.target.position.copy(this.spacecraft.position);
    this.sunLight.intensity = Math.PI * eSun * s.sunVisibility() * PRE_EXPOSURE.value;
    const cRow = this.bodies.get(center)?.row;
    if (cRow && center !== SUN) {
      const toC = vec(rsc).negate();
      const d = toC.length();
      const alpha = vec(sunRel).angleTo(vec(rsc)); // Sun–center–spacecraft angle
      const bond = center === EARTH ? 0.306 : 0.12;
      // Earthshine approximation: Lambert-sphere phase × (R/r)² × Bond albedo.
      this.earthshine.intensity = Math.PI * eSun * bond * Math.min(1, (cRow.radii[0] / d) ** 2) * lambertPhase(alpha) * PRE_EXPOSURE.value;
      this.earthshine.position.copy(this.spacecraft.position).add(toC.normalize());
      this.earthshine.target.position.copy(this.spacecraft.position);
    }

    // Predicted orbit (one period, or the lookahead).
    this.orbitLine.visible = this.settings.ui.showOrbit;
    if (this.orbitLine.visible) {
      const info = s.orbitInfo();
      const period = Number.isFinite(info[8]) ? info[8]! : 6000;
      const path = s.predictedPath(512, Math.min(period, 6000));
      const n = Math.min(path.length / 3, 512);
      for (let i = 0; i < n; i++) {
        this.orbitPositions[i * 3] = path[i * 3]! - cam[0];
        this.orbitPositions[i * 3 + 1] = path[i * 3 + 1]! - cam[1];
        this.orbitPositions[i * 3 + 2] = path[i * 3 + 2]! - cam[2];
      }
      const g = this.orbitLine.geometry;
      g.attributes.position!.needsUpdate = true;
      g.setDrawRange(0, n);
    }

    // Camera at the origin looking at the focus.
    const c = this.engine.camera;
    c.position.set(0, 0, 0);
    c.up.copy(up);
    c.lookAt(focusPos[0] - cam[0], focusPos[1] - cam[1], focusPos[2] - cam[2]);
    c.near = 0.05;
    c.updateProjectionMatrix();
    c.updateMatrixWorld();

    this.stars.update(rpp, this.settings.ui.starBoost);
    this.milkyWay.setBoost(this.settings.ui.starBoost);

    // Earth atmosphere input.
    const earth = this.bodies.get(EARTH);
    if (earth && earth.view.mesh.visible) {
      const er = rel.get(EARTH)!;
      const toS = sub(sunRel, er);
      this.atmo = {
        center: earth.pos.clone(),
        groundRadius: 6_371_000,
        topRadius: 6_471_000,
        sunDir: vec(toS).normalize(),
        sunIrradiance: (AU / len(toS)) ** 2,
      };
    } else {
      this.atmo = null;
    }
    return sunDir;
  }

  atmo: import("./atmosphere").AtmosphereParams | null = null;
}

/** Line material for UI overlays drawn into the HDR scene (so geometry occludes them)
 *  at a fixed *display* brightness: the color is divided by the current exposure. */
export function overlayLineMaterial(engine: Engine, color: THREE.Color): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { color: { value: color }, exposureTex: engine.exposureUniform, preExposure: PRE_EXPOSURE },
    vertexShader: /* glsl */ `
      #include <common>
      #include <logdepthbuf_pars_vertex>
      void main() {
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        #include <logdepthbuf_vertex>
      }`,
    fragmentShader: /* glsl */ `
      #include <common>
      #include <logdepthbuf_pars_fragment>
      uniform vec3 color;
      uniform sampler2D exposureTex;
      uniform float preExposure;
      void main() {
        #include <logdepthbuf_fragment>
        // Display = buffer · exposure / preExposure, so write color · preExposure / exposure.
        float e = exp2(texture2D(exposureTex, vec2(0.5)).r);
        gl_FragColor = vec4(color * preExposure / max(e, 1e-12), 1.0);
      }`,
    depthWrite: false,
  });
}
