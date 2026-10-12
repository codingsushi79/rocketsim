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
import { CesiumIonAuthPlugin, CesiumIonOverlay, GoogleCloudAuthPlugin, ImageOverlayPlugin } from "3d-tiles-renderer/plugins";
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

/** Where the near-surface Earth comes from. */
export type SurfaceSource =
  /** Cesium World Terrain (ion asset 1) with Bing Maps aerial imagery (ion asset 2). */
  | { kind: "ion-terrain"; token: string }
  /** Google Photorealistic 3D Tiles through Cesium ion (asset 2275207). */
  | { kind: "ion-google"; token: string }
  /** Google Photorealistic 3D Tiles with a Map Tiles API key. */
  | { kind: "google"; key: string };

/** Cesium ion asset ids (Cesium ion Asset Depot). */
const ION_WORLD_TERRAIN = 1;
const ION_BING_AERIAL = 2;
const ION_GOOGLE_3D = 2275207;

/** Bing Maps imagery attributions (Bing Maps terms, also required through Cesium ion):
 *  the Bing logo and the imagery providers whose coverage areas contain the view at the
 *  current zoom, from Bing's imagery metadata (as CesiumJS's BingMapsImageryProvider). */
class BingCredits {
  logo = "";
  private providers: { attribution: string; areas: { zoomMin: number; zoomMax: number; bbox: [number, number, number, number] }[] }[] = [];

  async load(token: string): Promise<void> {
    const ep = await fetch(`https://api.cesium.com/v1/assets/${ION_BING_AERIAL}/endpoint`, { headers: { Authorization: `Bearer ${token}` } }).then((r) => r.json());
    const { url, mapStyle, key } = ep.options as { url: string; mapStyle: string; key: string };
    const meta = await fetch(`${url}/REST/v1/Imagery/Metadata/${mapStyle}?incl=ImageryProviders&key=${key}&uriScheme=https`).then((r) => r.json());
    this.logo = meta.brandLogoUri ?? "";
    const res = meta.resourceSets?.[0]?.resources?.[0];
    this.providers = (res?.imageryProviders ?? []).map((p: { attribution: string; coverageAreas: { zoomMin: number; zoomMax: number; bbox: [number, number, number, number] }[] }) => ({ attribution: p.attribution, areas: p.coverageAreas }));
  }

  /** Providers credited for a view centred at (lat, lon) degrees at Bing zoom `z`. */
  credits(lat: number, lon: number, z: number): string[] {
    const out: string[] = [];
    for (const p of this.providers) {
      // bbox = [south, west, north, east]
      if (p.areas.some((a) => z >= a.zoomMin && z <= a.zoomMax && lat >= a.bbox[0] && lat <= a.bbox[2] && lon >= a.bbox[1] && lon <= a.bbox[3])) out.push(p.attribution);
    }
    return out;
  }
}

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

  /** Whether the data is Google's (the Google Maps logo is then required). */
  readonly google: boolean;
  private bing: BingCredits | null = null;
  /** Camera sub-point (deg) and altitude (m), for per-area imagery credits. */
  private view = { lat: 0, lon: 0, alt: 1e7 };

  constructor(
    private engine: Engine,
    readonly source: SurfaceSource,
    errorTarget: number,
  ) {
    this.anchor.matrixAutoUpdate = false;
    this.tiles = new TilesRenderer();
    this.google = source.kind !== "ion-terrain";
    switch (source.kind) {
      case "google":
        this.tiles.registerPlugin(new GoogleCloudAuthPlugin({ apiToken: source.key, autoRefreshToken: true }));
        break;
      case "ion-google":
        this.tiles.registerPlugin(new CesiumIonAuthPlugin({ apiToken: source.token, assetId: String(ION_GOOGLE_3D), autoRefreshToken: true }));
        break;
      case "ion-terrain":
        this.bing = new BingCredits();
        this.bing.load(source.token).catch((e) => console.warn("Bing metadata:", String(e)));
        // Quantized-mesh terrain (registered by the ion plugin) with draped aerial imagery.
        this.tiles.registerPlugin(new CesiumIonAuthPlugin({ apiToken: source.token, assetId: String(ION_WORLD_TERRAIN), autoRefreshToken: true }));
        this.tiles.registerPlugin(
          new ImageOverlayPlugin({
            renderer: engine.renderer,
            overlays: [new CesiumIonOverlay({ apiToken: source.token, assetId: String(ION_BING_AERIAL), autoRefreshToken: true })],
          }),
        );
        break;
    }
    this.tiles.errorTarget = errorTarget;
    this.tiles.addEventListener("load-model", (e: { scene: THREE.Object3D }) => {
      if (this.source.kind === "ion-terrain") this.prepareTerrain(e.scene);
      else this.relight(e.scene);
    });
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

  /** Terrain meshes keep their (overlay-wrapped) standard materials, lit by the scene's
   *  Sun light, which is set up in U with pre-exposure. Fully rough, no metal. */
  private prepareTerrain(scene: THREE.Object3D): void {
    scene.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const m = mesh.material as THREE.MeshStandardMaterial;
      if ("roughness" in m) {
        m.roughness = 1;
        m.metalness = 0;
      }
      this.terrainMaterials.add(m);
    });
  }
  private terrainMaterials = new Set<THREE.Material>();

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
    // Camera position in body-fixed axes (camera at the render origin): −R·earth.
    const bx = -(R[0]! * earth.x + R[1]! * earth.y + R[2]! * earth.z);
    const by = -(R[3]! * earth.x + R[4]! * earth.y + R[5]! * earth.z);
    const bz = -(R[6]! * earth.x + R[7]! * earth.y + R[8]! * earth.z);
    this.view = { lat: (Math.atan2(bz, Math.hypot(bx, by)) * 180) / Math.PI, lon: (Math.atan2(by, bx) * 180) / Math.PI, alt: altitude };
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
    for (const m of this.terrainMaterials) {
      m.transparent = a < 1;
      m.opacity = a;
    }
    const size = this.engine.pixelSize;
    this.tiles.setResolution(this.engine.camera, size.x, size.y);
    this.engine.camera.updateMatrixWorld();
    this.tiles.update();
  }

  set errorTarget(v: number) {
    this.tiles.errorTarget = v;
  }

  /** Aggregated data attributions of the displayed tiles: plain text and (sanitised
   *  by the caller) HTML snippets from Cesium ion. Empty when nothing is shown. */
  attributions(): { text: string; html: string[] } {
    if (this.alpha <= 0 || this.tiles.visibleTiles.size === 0) return { text: "", html: [] };
    const out: { type: string; value: string }[] = [];
    this.tiles.getAttributions(out);
    const html = [...new Set(out.filter((a) => a.type === "html").map((a) => a.value))];
    let text = out
      .filter((a) => a.type === "string")
      .map((a) => a.value)
      .join(" ")
      .trim();
    if (this.bing) {
      // Bing zoom from the view: ~156 km/px at zoom 0 for 256 px tiles; one screen ≈ altitude.
      const z = Math.max(1, Math.min(21, Math.round(Math.log2(40_075_016 / Math.max(this.view.alt, 50)))));
      const credits = this.bing.credits(this.view.lat, this.view.lon, z);
      if (this.bing.logo) html.push(`<img src="${this.bing.logo}" alt="Microsoft Bing">`);
      // Bing's provider list carries "© Microsoft Corporation" itself.
      text = [...credits, text].filter(Boolean).join(" · ");
    }
    return { text, html };
  }

  dispose(): void {
    this.anchor.removeFromParent();
    this.tiles.dispose();
  }
}
