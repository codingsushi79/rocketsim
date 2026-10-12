// Google Photorealistic 3D Tiles near the Earth's surface (brief §3; policy summary in
// docs/plans/M7-earth-photorealism.md).
//
// - **Streaming.** The tiles come through `3d-tiles-renderer` with its GoogleCloudAuthPlugin,
//   which handles the session (refreshed after the ~3 h limit) and collects each displayed
//   tile's `asset.copyright`. Nothing is pre-fetched or stored by us: requests go through
//   the browser's HTTP cache, which honours Cache-Control and ETags.
// - **Frame.** Tiles are in ECEF metres, i.e. the IERS body-fixed frame the physics uses.
//   They hang under an anchor placed at the Earth's centre (render space) and rotated
//   body-fixed → ICRF, so they stay inside the floating origin.
// - **Lighting.** The same Sun as everything else: the imagery is treated as albedo,
//   lit by cos(sun) over the local ellipsoid normal, in U with pre-exposure. The atmosphere
//   and cloud passes apply on top.
// - **Altitude blend.** Fully shown below 600 km camera altitude, faded out by 1,200 km.
//   Above that the renderer isn't updated at all, so no requests are made.
// - **No geometry is read back.** Physics never touches the tiles (D7).

import * as THREE from "three";
import { TilesRenderer } from "3d-tiles-renderer";
import { GoogleCloudAuthPlugin } from "3d-tiles-renderer/plugins";
import type { Engine } from "./engine";
import { PRE_EXPOSURE } from "./units";

/** Camera altitudes (m) over which the tiles fade out. */
export const TILES_FULL_ALT = 600e3;
export const TILES_NONE_ALT = 1_200e3;

const VS = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_vertex>
  varying vec2 vUv;
  varying vec3 vWorld;
  void main() {
    vUv = uv;
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorld = wp.xyz;
    gl_Position = projectionMatrix * viewMatrix * wp;
    #include <logdepthbuf_vertex>
  }
`;

const FS = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_fragment>
  uniform sampler2D map;
  uniform bool hasMap;
  uniform vec3 color;
  uniform vec3 earthCenter;
  uniform vec3 sunDir;
  uniform float sunE, preExposure, opacity;
  varying vec2 vUv;
  varying vec3 vWorld;
  void main() {
    #include <logdepthbuf_fragment>
    vec3 albedo = hasMap ? texture2D(map, vUv).rgb : color;
    // Photogrammetry has baked shading; light by the local vertical, not mesh normals.
    vec3 up = normalize(vWorld - earthCenter);
    float ndl = max(dot(up, sunDir), 0.0);
    gl_FragColor = vec4(albedo * sunE * ndl * preExposure, opacity);
  }
`;

export class EarthTiles {
  /** Earth-centred, body-fixed anchor (matrix set every frame). */
  readonly anchor = new THREE.Group();
  private tiles: TilesRenderer;
  private shared = {
    earthCenter: { value: new THREE.Vector3() },
    sunDir: { value: new THREE.Vector3(1, 0, 0) },
    sunE: { value: 1 },
    opacity: { value: 1 },
  };
  private materials = new Set<THREE.ShaderMaterial>();
  /** Current blend weight (0 = hidden, no requests). */
  alpha = 0;

  constructor(
    private engine: Engine,
    apiKey: string,
    errorTarget: number,
  ) {
    this.anchor.matrixAutoUpdate = false;
    this.tiles = new TilesRenderer();
    this.tiles.registerPlugin(new GoogleCloudAuthPlugin({ apiToken: apiKey, autoRefreshToken: true }));
    this.tiles.errorTarget = errorTarget;
    this.tiles.addEventListener("load-model", (e: { scene: THREE.Object3D }) => this.relight(e.scene));
    this.tiles.addEventListener("dispose-model", (e: { scene: THREE.Object3D }) => {
      e.scene.traverse((o) => {
        const m = (o as THREE.Mesh).material;
        if (m instanceof THREE.ShaderMaterial) {
          this.materials.delete(m);
          m.dispose();
        }
      });
    });
    this.anchor.add(this.tiles.group);
    this.tiles.setCamera(engine.camera);
  }

  /** Replace the tile's materials with ours (same texture, our lighting and units). */
  private relight(scene: THREE.Object3D): void {
    scene.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const old = mesh.material as THREE.MeshBasicMaterial | THREE.MeshStandardMaterial;
      const map = old.map ?? null;
      const mat = new THREE.ShaderMaterial({
        uniforms: {
          map: { value: map },
          hasMap: { value: map !== null },
          color: { value: old.color?.clone() ?? new THREE.Color(0.3, 0.3, 0.3) },
          earthCenter: this.shared.earthCenter,
          sunDir: this.shared.sunDir,
          sunE: this.shared.sunE,
          opacity: this.shared.opacity,
          preExposure: PRE_EXPOSURE,
        },
        vertexShader: VS,
        fragmentShader: FS,
      });
      old.dispose();
      mesh.material = mat;
      this.materials.add(mat);
    });
  }

  /**
   * Per frame, before rendering.
   * @param earth Earth's centre in render space.
   * @param icrfToBf Row-major ICRF → body-fixed rotation from the core.
   * @param altitude Camera altitude above the surface, m.
   */
  update(earth: THREE.Vector3, icrfToBf: ArrayLike<number>, altitude: number, sunDir: THREE.Vector3, sunE: number): void {
    const a = 1 - THREE.MathUtils.smoothstep(altitude, TILES_FULL_ALT, TILES_NONE_ALT);
    this.alpha = a;
    this.anchor.visible = a > 0;
    if (a <= 0) return;
    const R = icrfToBf;
    // Body-fixed → ICRF is the transpose of the core's ICRF → body-fixed matrix.
    this.anchor.matrix.set(
      R[0]!, R[3]!, R[6]!, earth.x,
      R[1]!, R[4]!, R[7]!, earth.y,
      R[2]!, R[5]!, R[8]!, earth.z,
      0, 0, 0, 1,
    );
    this.anchor.updateMatrixWorld(true);
    this.shared.earthCenter.value.copy(earth);
    this.shared.sunDir.value.copy(sunDir);
    this.shared.sunE.value = sunE;
    this.shared.opacity.value = a;
    for (const m of this.materials) {
      m.transparent = a < 1;
    }
    const size = this.engine.pixelSize;
    this.tiles.setResolution(this.engine.camera, size.x, size.y);
    this.engine.camera.updateMatrixWorld();
    this.tiles.update();
  }

  set errorTarget(v: number) {
    this.tiles.errorTarget = v;
  }

  /** Aggregated data attributions of the displayed tiles (empty when none shown). */
  attribution(): string {
    if (this.alpha <= 0) return "";
    const out: { type: string; value: string }[] = [];
    this.tiles.getAttributions(out);
    return out
      .filter((a) => a.type === "string")
      .map((a) => a.value)
      .join(" ")
      .trim();
  }

  dispose(): void {
    this.anchor.removeFromParent();
    this.tiles.dispose();
  }
}
