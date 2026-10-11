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
import type { Engine } from "./engine";
import { PRE_EXPOSURE } from "./units";

/** Rotation taking +X onto unit vector `d`. */
function quatFromX(d: Vec3): THREE.Quaternion {
  return new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(1, 0, 0), new THREE.Vector3(d[0], d[1], d[2]).normalize());
}

/** Exhaust glow drawn at a fixed display brightness (divided by the current
 *  exposure), so plumes read the same in sunlight and in shadow. A hypergolic vacuum
 *  plume is physically faint; this is a deliberate visual aid, not a radiometric model. */
function exhaustMaterial(engine: Engine, color: THREE.Color): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      color: { value: color },
      intensity: { value: 0 },
      exposureTex: engine.exposureUniform,
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
      uniform sampler2D exposureTex;
      uniform float preExposure;
      uniform float time;
      varying float vAlong;
      varying float vFacing;
      void main() {
        #include <logdepthbuf_fragment>
        float flicker = 0.92 + 0.08 * sin(time * 97.0 + vAlong * 23.0);
        float a = intensity * pow(1.0 - vAlong, 1.6) * pow(vFacing, 1.5) * flicker;
        float e = exp2(texture2D(exposureTex, vec2(0.5)).r);
        // Hotter, whiter core near the nozzle.
        vec3 c = mix(color, vec3(1.0, 0.95, 0.9), pow(1.0 - vAlong, 6.0));
        gl_FragColor = vec4(c * a * preExposure / max(e, 1e-12), 1.0);
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

  private constructor(private def: VehicleDef) {
    this.root.add(this.model);
  }

  static async load(def: VehicleDef, engine: Engine): Promise<VehicleView> {
    const v = new VehicleView(def);
    const gltf = await new GLTFLoader().loadAsync(def.model);
    v.model.add(gltf.scene);
    gltf.scene.traverse((o) => {
      if (o.name.startsWith("stage_")) v.stageNodes.set(o.name.slice(6), o);
      if ((o as THREE.Mesh).isMesh) o.frustumCulled = false;
    });
    for (const e of def.engines) {
      const node = gltf.scene.getObjectByName(`engine_${e.id}`) ?? new THREE.Group();
      const part = def.parts.find((p) => p.kind === "engine" && p.stage === e.stage);
      const shape = part && part.shape !== "point" ? part.shape.cone_shell : undefined;
      const exitR = typeof shape?.base_radius === "number" ? shape.base_radius : 0.5;
      const len = part ? Math.abs(part.position[0] - e.position[0]) : 2;
      const plume = new THREE.Mesh(plumeGeometry(1), exhaustMaterial(engine, new THREE.Color(1.0, 0.55, 0.35)));
      plume.position.set(-len, 0, 0);
      plume.renderOrder = 10;
      node.add(plume);
      v.engines.push({ node, plume, exitRadius: exitR, thrustVac: e.thrust_vac });
    }
    const puffGeo = plumeGeometry(4);
    for (const g of def.rcs) {
      const list: VehicleView["puffs"][number] = [];
      for (const t of g.thrusters) {
        const m = new THREE.Mesh(puffGeo, exhaustMaterial(engine, new THREE.Color(0.85, 0.85, 0.95)));
        // Exhaust leaves opposite the force direction.
        const ex: Vec3 = [-t.direction[0], -t.direction[1], -t.direction[2]];
        m.quaternion.copy(quatFromX([-ex[0], -ex[1], -ex[2]]));
        m.position.set(t.position[0] + ex[0] * 0.25, t.position[1] + ex[1] * 0.25, t.position[2] + ex[2] * 0.25);
        m.scale.set(0.9, 0.05, 0.05);
        m.renderOrder = 10;
        m.visible = false;
        v.model.add(m);
        list.push(m);
      }
      v.puffs.push(list);
    }
    return v;
  }

  /** Per-frame update from telemetry. `attached[i]` for `def.stages[i]`. */
  update(dt: number, t: Telemetry | null, attached: ArrayLike<number>): void {
    this.time += dt;
    if (!t) return;
    this.model.position.set(-t.com[0], -t.com[1], -t.com[2]);
    this.def.stages.forEach((s, i) => {
      const n = this.stageNodes.get(s.id);
      if (n) n.visible = (attached[i] ?? 1) !== 0;
    });
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
