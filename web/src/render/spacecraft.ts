// The flown vehicle: glTF model (generated from the vehicle JSON by
// tools/models/build_vehicle_glb.mjs), gimballing engine, plume and RCS puffs driven
// by the core's telemetry, and jettisoned stages.
//
// Frames: the model is in the vehicle body frame (+X forward, metres, origin fixed
// to the structure). `root` sits at the vehicle's centre of mass with the body →
// ICRF attitude, and the model inside it is offset by −CoM.

import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import type { Telemetry, VehicleDef, Vec3 } from "../sim/vehicle";
import { PRE_EXPOSURE } from "./units";
import { markEmissive } from "./emissive";
import { ReentryFx, addIncandescence } from "./reentry";

/** Exhaust core radiances, U (a sunlit white hull is ≈ 0.8 U). */
const PLUME_RADIANCE_U = 0.6;
const PUFF_RADIANCE_U = 0.5;
/** Fireball core radiance, U (brighter than a sunlit hull, like burning propellant). */
const FIREBALL_RADIANCE_U = 3.0;

/** Rotation taking +X onto unit vector `d`. */
function quatFromX(d: Vec3): THREE.Quaternion {
  return new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(1, 0, 0), new THREE.Vector3(d[0], d[1], d[2]).normalize());
}

/** Exhaust glow with a fixed radiance of `radianceU` (units of U, see units.ts) at
 *  the core. A hypergolic vacuum plume is physically much fainter: this is a
 *  deliberate visual aid at about the brightness of a sunlit hull, not a radiometric
 *  model. It must stay a fixed radiance: dividing by the exposure (as overlays do)
 *  makes a feedback loop with the auto-exposure, which meters the plume. */
function exhaustMaterial(color: THREE.Color, radianceU: number): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      color: { value: color },
      intensity: { value: 0 },
      radiance: { value: radianceU },
      preExposure: PRE_EXPOSURE,
      time: { value: 0 },
    },
    vertexShader: /* glsl */ `
      #include <common>
      #include <logdepthbuf_pars_vertex>
      varying float vAlong;
      varying float vFacing;
      void main() {
        vAlong = clamp(-position.x, 0.0, 1.0);
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vec3 n = normalize(normalMatrix * normal);
        vFacing = abs(dot(n, normalize(-mv.xyz)));
        gl_Position = projectionMatrix * mv;
        #include <logdepthbuf_vertex>
      }`,
    fragmentShader: /* glsl */ `
      #include <common>
      #include <logdepthbuf_pars_fragment>
      uniform vec3 color;
      uniform float intensity;
      uniform float radiance;
      uniform float preExposure;
      uniform float time;
      varying float vAlong;
      varying float vFacing;
      void main() {
        #include <logdepthbuf_fragment>
        // Clamp first: with MSAA, varyings are evaluated at sample points slightly
        // outside the triangle, and pow() of a negative number is NaN (which bloom
        // then spreads over the whole frame).
        float along = clamp(vAlong, 0.0, 1.0);
        float facing = clamp(vFacing, 0.0, 1.0);
        float flicker = 0.92 + 0.08 * sin(time * 97.0 + along * 23.0);
        float a = intensity * pow(1.0 - along, 1.6) * pow(facing, 1.5) * flicker;
        // Hotter, whiter core near the nozzle.
        vec3 c = mix(color, vec3(1.0, 0.95, 0.9), pow(1.0 - along, 6.0));
        gl_FragColor = vec4(c * (a * radiance * preExposure), 1.0);
      }`,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
}

/** Unit plume: opens from radius 1 at the nozzle exit (x = 0) to `spread` at x = −1. */
function plumeGeometry(spread: number): THREE.BufferGeometry {
  const pts: THREE.Vector2[] = [];
  for (let i = 0; i <= 16; i++) {
    const t = i / 16;
    pts.push(new THREE.Vector2(1 + (spread - 1) * Math.sqrt(t), -t));
  }
  const g = new THREE.LatheGeometry(pts, 32);
  g.rotateZ(-Math.PI / 2); // lathe axis +Y → +X; the plume extends along −X
  return g;
}

interface EngineView {
  node: THREE.Object3D;
  plume: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
  exitRadius: number;
  thrustVac: number;
}

export class VehicleView {
  readonly root = new THREE.Group();
  private model = new THREE.Group();
  private stageNodes = new Map<string, THREE.Object3D>();
  private engines: EngineView[] = [];
  private puffs: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>[][] = [];
  private time = 0;
  /** Explosion state: fireball and flying fragments (visual only). */
  private boom: { t: number; fire: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>; parts: { o: THREE.Object3D; v: THREE.Vector3; w: THREE.Vector3 }[] } | null = null;
  /** Entry heating effects (incandescence, sheath, plasma light, buffeting). */
  readonly entry = new ReentryFx(2);
  private attachedKey = "";
  get cabin(): VehicleDef["cabin"] {
    return this.def.cabin;
  }
  get exploded(): boolean {
    return this.boom !== null;
  }

  private constructor(private def: VehicleDef) {
    this.root.add(this.model);
    this.root.add(this.entry.root);
  }

  static async load(def: VehicleDef): Promise<VehicleView> {
    const v = new VehicleView(def);
    const gltf = await new GLTFLoader().loadAsync(def.model);
    v.model.add(gltf.scene);
    gltf.scene.traverse((o) => {
      if (o.name.startsWith("stage_")) v.stageNodes.set(o.name.slice(6), o);
      if ((o as THREE.Mesh).isMesh) {
        o.frustumCulled = false;
        const m = (o as THREE.Mesh).material;
        for (const mm of Array.isArray(m) ? m : [m]) addIncandescence(mm);
      }
    });
    // Plasma envelope layers on every hull mesh (before plumes/puffs are added).
    const hull: THREE.Mesh[] = [];
    gltf.scene.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) hull.push(o as THREE.Mesh);
    });
    v.entry.attach(hull);
    for (const e of def.engines) {
      const node = gltf.scene.getObjectByName(`engine_${e.id}`) ?? new THREE.Group();
      const part = def.parts.find((p) => p.kind === "engine" && p.stage === e.stage);
      const shape = part && part.shape !== "point" ? part.shape.cone_shell : undefined;
      const exitR = typeof shape?.base_radius === "number" ? shape.base_radius : 0.5;
      const len = part ? Math.abs(part.position[0] - e.position[0]) : 2;
      const plume = new THREE.Mesh(plumeGeometry(1), exhaustMaterial(new THREE.Color(1.0, 0.55, 0.35), PLUME_RADIANCE_U));
      plume.position.set(-len, 0, 0);
      plume.renderOrder = 10;
      markEmissive(plume);
      node.add(plume);
      v.engines.push({ node, plume, exitRadius: exitR, thrustVac: e.thrust_vac });
    }
    const puffGeo = plumeGeometry(4);
    for (const g of def.rcs) {
      const list: VehicleView["puffs"][number] = [];
      for (const t of g.thrusters) {
        const m = new THREE.Mesh(puffGeo, exhaustMaterial(new THREE.Color(0.85, 0.85, 0.95), PUFF_RADIANCE_U));
        // Exhaust leaves opposite the force direction.
        const ex: Vec3 = [-t.direction[0], -t.direction[1], -t.direction[2]];
        m.quaternion.copy(quatFromX([-ex[0], -ex[1], -ex[2]]));
        m.position.set(t.position[0] + ex[0] * 0.25, t.position[1] + ex[1] * 0.25, t.position[2] + ex[2] * 0.25);
        m.scale.set(0.9, 0.05, 0.05);
        m.renderOrder = 10;
        m.visible = false;
        markEmissive(m);
        v.model.add(m);
        list.push(m);
      }
      v.puffs.push(list);
    }
    return v;
  }

  /** Destroy the vehicle: a fireball, and the model's meshes flung apart. */
  explode(): void {
    if (this.boom) return;
    const fire = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 16), exhaustMaterial(new THREE.Color(1.0, 0.5, 0.18), FIREBALL_RADIANCE_U));
    fire.renderOrder = 11;
    markEmissive(fire);
    this.root.add(fire);
    const parts: { o: THREE.Object3D; v: THREE.Vector3; w: THREE.Vector3 }[] = [];
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
    this.model.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh || m.material instanceof THREE.ShaderMaterial) return;
      const c = m.clone();
      m.getWorldPosition(c.position);
      this.root.worldToLocal(c.position);
      c.quaternion.copy(m.getWorldQuaternion(new THREE.Quaternion())).premultiply(this.root.quaternion.clone().invert());
      this.root.add(c);
      const v = new THREE.Vector3(rnd(), rnd(), rnd()).normalize().multiplyScalar(8 + 25 * Math.abs(rnd()));
      parts.push({ o: c, v, w: new THREE.Vector3(rnd(), rnd(), rnd()).multiplyScalar(3) });
    });
    this.model.visible = false;
    this.boom = { t: 0, fire, parts };
  }

  /** Undo `explode` (mission restart). */
  reset(): void {
    if (!this.boom) return;
    this.root.remove(this.boom.fire, ...this.boom.parts.map((p) => p.o));
    this.boom.fire.geometry.dispose();
    this.boom = null;
    this.model.visible = true;
  }

  /** Per-frame update from telemetry. `attached[i]` for `def.stages[i]`. */
  update(dt: number, t: Telemetry | null, attached: ArrayLike<number>): void {
    this.time += dt;
    if (this.boom) {
      // Wall-clock animation: the sim clock stops at impact.
      const b = this.boom;
      b.t += dt;
      const r = 4 + 36 * (1 - Math.exp(-b.t * 2.2));
      b.fire.scale.setScalar(r);
      // Flash, then a slowly dimming fireball (~4 s).
      b.fire.material.uniforms.intensity!.value = 3.0 * Math.exp(-b.t * 0.55) + 4.0 * Math.exp(-b.t * 6);
      b.fire.material.uniforms.time!.value = this.time;
      b.fire.visible = b.t < 10;
      for (const p of b.parts) {
        p.o.position.addScaledVector(p.v, dt);
        p.v.multiplyScalar(Math.exp(-dt * 0.4));
        p.o.rotation.x += p.w.x * dt;
        p.o.rotation.y += p.w.y * dt;
        p.o.rotation.z += p.w.z * dt;
      }
      return;
    }
    if (!t) return;
    this.model.position.set(-t.com[0], -t.com[1], -t.com[2]);
    this.def.stages.forEach((s, i) => {
      const n = this.stageNodes.get(s.id);
      if (n) n.visible = (attached[i] ?? 1) !== 0;
    });
    // Sheath size from what is still attached (the capsule alone after separation).
    const key = Array.from(attached).join(",");
    if (key !== this.attachedKey) {
      this.attachedKey = key;
      const box = new THREE.Box3();
      for (const [, n] of this.stageNodes) if (n.visible) box.expandByObject(n);
      if (!box.isEmpty()) {
        const sz = box.getSize(new THREE.Vector3());
        this.entry.setRadius(0.5 * Math.max(sz.y, sz.z, 0.5 * sz.x));
      }
    }
    this.engines.forEach((ev, i) => {
      const e = t.engines[i];
      if (!e) return;
      ev.node.quaternion.copy(quatFromX(e.direction));
      const k = e.thrust / ev.thrustVac;
      // Under-expanded in vacuum: the plume fans out; ambient pressure pinches it.
      const spread = 1 + 5 / (1 + t.pAmb / 2000);
      const len = ev.exitRadius * (6 + 10 * k) * (t.pAmb > 0 ? 1.4 : 1);
      ev.plume.visible = e.running && e.thrust > 0;
      ev.plume.scale.set(len, ev.exitRadius * (0.95 + 0.05 * spread), ev.exitRadius * (0.95 + 0.05 * spread));
      if ((ev.plume.userData.spread ?? 0) !== Math.round(spread)) {
        ev.plume.geometry.dispose();
        ev.plume.geometry = plumeGeometry(Math.round(spread));
        ev.plume.userData.spread = Math.round(spread);
      }
      ev.plume.material.uniforms.intensity!.value = 0.35 + 0.65 * k;
      ev.plume.material.uniforms.time!.value = this.time;
    });
    this.puffs.forEach((list, gi) => {
      list.forEach((m, ti) => {
        const d = t.rcs[gi]?.[ti] ?? 0;
        m.visible = d > 0.01;
        if (m.visible) {
          m.material.uniforms.intensity!.value = 0.25 + 0.75 * Math.min(1, d * 1.5);
          m.material.uniforms.time!.value = this.time + ti;
        }
      });
    });
  }

  /** Entry effects for this frame: telemetry plus the camera orientation (world → view). */
  updateEntry(dt: number, t: Telemetry | null, camera: THREE.Camera): void {
    if (!t || this.boom) {
      this.entry.update(dt, 0, 0, new THREE.Vector3(), new THREE.Quaternion());
      return;
    }
    const toBody = this.root.quaternion.clone().invert();
    const flow = new THREE.Vector3(t.vAir[0], t.vAir[1], t.vAir[2]).applyQuaternion(toBody);
    const viewFromBody = camera.quaternion.clone().invert().multiply(this.root.quaternion);
    this.entry.update(dt, t.heat, t.q, flow, viewFromBody, this.root.quaternion);
  }

  /** A copy of one stage's model, origin at that stage's CoM (for debris). */
  stageModel(stageIndex: number, comBody: Vec3): THREE.Object3D {
    const g = new THREE.Group();
    const s = this.def.stages[stageIndex];
    const n = s ? this.stageNodes.get(s.id) : undefined;
    if (n) {
      const c = n.clone(true);
      c.visible = true;
      // Plumes and puffs belong to the live vehicle.
      c.traverse((o) => {
        if ((o as THREE.Mesh).material instanceof THREE.ShaderMaterial) o.visible = false;
      });
      c.position.set(-comBody[0], -comBody[1], -comBody[2]);
      g.add(c);
    }
    return g;
  }
}
