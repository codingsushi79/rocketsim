// Planet surfaces with terrain and streamed imagery (M8): the Moon, Mars, and any body
// with a NASA Trek imagery layer.
//
// - **Quadtree.** On the equirectangular grid: two 180° root tiles, children 2×2. This is
//   the NASA Solar System Treks WMTS "default028mm" tile matrix, so each node maps to
//   exactly one imagery tile (level, row, column).
// - **Mesh.** Each node is a 33×33 vertex grid, displaced by the body's height grid (the
//   same .rsdem the physics uses for ground contact), with skirts to hide cracks between
//   levels.
// - **Selection.** Nodes split by screen-space error: geometric size per vertex step,
//   projected, above ~2 px, with horizon and frustum culling.
// - **Placement.** Vertices are stored relative to the node centre (body-fixed), so f32
//   holds them exactly; an anchor rotates body-fixed → ICRF at the body's render-space
//   position (floating origin).
// - **Imagery.** Streamed from Trek per node. Until a node's tile arrives, the bundled
//   global texture shows. Lit as albedo (U, pre-exposed) with the terrain's own normals, so
//   relief is shaded by the real Sun.

import * as THREE from "three";
import { PRE_EXPOSURE } from "./units";

/** A body height grid (.rsdem): see tools/assets/prepare_dems.py. */
export class HeightGrid {
  constructor(
    readonly width: number,
    readonly height: number,
    readonly scale: number,
    private data: Int16Array,
  ) {}

  /** Decompressed bytes of a .rsdem file. */
  static parse(b: Uint8Array): HeightGrid {
    const magic = new TextDecoder().decode(b.subarray(0, 6));
    if (magic !== "RSDEM1") throw new Error("bad .rsdem");
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    const w = dv.getUint32(6, true), h = dv.getUint32(10, true), scale = dv.getFloat32(14, true);
    const data = new Int16Array(w * h);
    for (let i = 0; i < w * h; i++) data[i] = dv.getInt16(18 + 2 * i, true);
    return new HeightGrid(w, h, scale, data);
  }

  /** Height (m) at lat/lon (rad); bilinear between pixel centres (as the core). */
  sample(lat: number, lon: number): number {
    const w = this.width, h = this.height;
    const y = Math.min(h - 1, Math.max(0, ((90 - (lat * 180) / Math.PI) / 180) * h - 0.5));
    let x = (((lon * 180) / Math.PI + 180) / 360) * w - 0.5;
    x -= Math.floor(x / w) * w;
    const i0 = Math.floor(y), fy = y - i0, i1 = Math.min(i0 + 1, h - 1);
    const j0 = Math.floor(x) % w, fx = x - Math.floor(x), j1 = (j0 + 1) % w;
    const d = this.data;
    const top = d[i0 * w + j0]! * (1 - fx) + d[i0 * w + j1]! * fx;
    const bot = d[i1 * w + j0]! * (1 - fx) + d[i1 * w + j1]! * fx;
    return (top * (1 - fy) + bot * fy) * this.scale;
  }
}

/** Fetch and decompress a gzip'd .rsdem. */
export async function loadHeightGrid(url: string): Promise<{ grid: HeightGrid; bytes: Uint8Array }> {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`${url}: ${res.status}`);
  const stream = res.body.pipeThrough(new DecompressionStream("gzip"));
  const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  return { grid: HeightGrid.parse(bytes), bytes };
}

export interface ImageryLayer {
  /** Template with {z} {y} {x} (WMTS level, row, column). */
  url: string;
  maxLevel: number;
  /** Linear albedo per unit (linear) image value: calibrates stretched mosaics. */
  gain: number;
  attribution: string;
}

const GRID = 33;
/** Split when a vertex step projects larger than this many pixels. */
const SPLIT_PX = 2.5;
const MAX_NODES = 1200;
const MAX_LOADS = 8;
const MIN_LEVEL = 2;

interface Node {
  level: number;
  row: number;
  col: number;
  key: string;
  mesh: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial> | null;
  centerBF: THREE.Vector3;
  /** Bounding radius about centerBF, m. */
  radius: number;
  tex: THREE.Texture | null;
  loading: boolean;
  lastUsed: number;
}

const VS = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_vertex>
  attribute vec2 uvGlobal;
  varying vec2 vUv;
  varying vec2 vUvGlobal;
  varying vec3 vNormalW;
  void main() {
    vUv = uv;
    vUvGlobal = uvGlobal;
    vNormalW = normalize(mat3(modelMatrix) * normal);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    #include <logdepthbuf_vertex>
  }
`;

const FS = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_fragment>
  uniform sampler2D tileMap, baseMap;
  uniform bool hasTile;
  uniform vec3 sunDir;
  uniform float sunE, gain, preExposure;
  varying vec2 vUv;
  varying vec2 vUvGlobal;
  varying vec3 vNormalW;
  void main() {
    #include <logdepthbuf_fragment>
    vec3 albedo = (hasTile ? texture2D(tileMap, vUv).rgb : texture2D(baseMap, vUvGlobal).rgb) * gain;
    float ndl = max(dot(normalize(vNormalW), sunDir), 0.0);
    gl_FragColor = vec4(albedo * sunE * ndl * preExposure, 1.0);
  }
`;

export class PlanetSurface {
  readonly anchor = new THREE.Group();
  private nodes = new Map<string, Node>();
  private loads = 0;
  private frame = 0;
  private shared = { sunDir: { value: new THREE.Vector3(1, 0, 0) }, sunE: { value: 1 } };
  private loader = new THREE.ImageBitmapLoader();

  constructor(
    readonly radii: [number, number, number],
    private grid: HeightGrid | null,
    private imagery: ImageryLayer | null,
    private base: THREE.Texture,
    private rpp: () => number,
  ) {
    this.anchor.matrixAutoUpdate = false;
    base.colorSpace = THREE.SRGBColorSpace;
    base.anisotropy = 8;
    this.loader.setOptions({ imageOrientation: "flipY" });
  }

  get attribution(): string {
    return this.imagery?.attribution ?? "";
  }

  /** Surface point (body-fixed, m) at lat/lon (rad) on the reference ellipsoid + height. */
  private surface(lat: number, lon: number, out: THREE.Vector3): THREE.Vector3 {
    const [a, b, c] = this.radii;
    const cl = Math.cos(lat);
    const dx = cl * Math.cos(lon), dy = cl * Math.sin(lon), dz = Math.sin(lat);
    // Radius of the reference ellipsoid along this direction, then the grid height.
    const r = 1 / Math.sqrt((dx / a) ** 2 + (dy / b) ** 2 + (dz / c) ** 2) + (this.grid?.sample(lat, lon) ?? 0);
    return out.set(dx * r, dy * r, dz * r);
  }

  private bounds(level: number, row: number, col: number): [number, number, number, number] {
    const span = Math.PI / 2 ** level;
    const lat1 = Math.PI / 2 - row * span;
    const lon0 = -Math.PI + col * span;
    return [lat1 - span, lat1, lon0, lon0 + span];
  }

  private node(level: number, row: number, col: number): Node {
    const key = `${level}/${row}/${col}`;
    let n = this.nodes.get(key);
    if (!n) {
      const [la0, la1, lo0, lo1] = this.bounds(level, row, col);
      const c = this.surface((la0 + la1) / 2, (lo0 + lo1) / 2, new THREE.Vector3());
      const corner = this.surface(la1, lo0, new THREE.Vector3());
      const r = Math.max(c.distanceTo(corner), c.distanceTo(this.surface(la0, lo1, new THREE.Vector3()))) * 1.15 + 15_000;
      n = { level, row, col, key, mesh: null, centerBF: c, radius: r, tex: null, loading: false, lastUsed: 0 };
      this.nodes.set(key, n);
    }
    return n;
  }

  private buildMesh(n: Node): void {
    const [la0, la1, lo0, lo1] = this.bounds(n.level, n.row, n.col);
    const N = GRID;
    const verts = (N + 2) * (N + 2); // + skirt ring
    const pos = new Float32Array(verts * 3), nor = new Float32Array(verts * 3);
    const uv = new Float32Array(verts * 2), uvg = new Float32Array(verts * 2);
    const p = new THREE.Vector3();
    const grid: THREE.Vector3[] = [];
    for (let i = 0; i < N; i++) {
      for (let j = 0; j < N; j++) {
        const lat = la1 - ((la1 - la0) * i) / (N - 1);
        const lon = lo0 + ((lo1 - lo0) * j) / (N - 1);
        grid.push(this.surface(lat, lon, new THREE.Vector3()).sub(n.centerBF));
      }
    }
    const at = (i: number, j: number) => grid[Math.min(N - 1, Math.max(0, i)) * N + Math.min(N - 1, Math.max(0, j))]!;
    // Skirt depth: a fraction of the tile size, enough to cover level differences.
    const skirt = n.radius * 0.08;
    let k = 0;
    const put = (i: number, j: number, drop: boolean) => {
      const ci = Math.min(N - 1, Math.max(0, i)), cj = Math.min(N - 1, Math.max(0, j));
      p.copy(at(ci, cj));
      // Normal from neighbouring vertices (terrain relief).
      const dx = at(ci, cj + 1).clone().sub(at(ci, cj - 1));
      const dy = at(ci - 1, cj).clone().sub(at(ci + 1, cj));
      const nn = dx.cross(dy).normalize();
      const up = p.clone().add(n.centerBF).normalize();
      if (nn.dot(up) < 0) nn.negate();
      if (drop) p.addScaledVector(up, -skirt);
      pos.set([p.x, p.y, p.z], k * 3);
      nor.set([nn.x, nn.y, nn.z], k * 3);
      uv.set([cj / (N - 1), 1 - ci / (N - 1)], k * 2);
      const lon = lo0 + ((lo1 - lo0) * cj) / (N - 1), lat = la1 - ((la1 - la0) * ci) / (N - 1);
      uvg.set([(lon + Math.PI) / (2 * Math.PI), (lat + Math.PI / 2) / Math.PI], k * 2);
      k++;
    };
    // (N+2)×(N+2) lattice: the outer ring repeats the edge vertices, dropped (skirt).
    for (let i = -1; i <= N; i++) for (let j = -1; j <= N; j++) put(i, j, i < 0 || j < 0 || i >= N || j >= N);
    const M = N + 2;
    const idx: number[] = [];
    for (let i = 0; i < M - 1; i++)
      for (let j = 0; j < M - 1; j++) {
        const a = i * M + j, b = a + 1, c = a + M, d = c + 1;
        idx.push(a, c, b, b, c, d);
      }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    g.setAttribute("normal", new THREE.BufferAttribute(nor, 3));
    g.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
    g.setAttribute("uvGlobal", new THREE.BufferAttribute(uvg, 2));
    g.setIndex(idx);
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        tileMap: { value: null },
        baseMap: { value: this.base },
        hasTile: { value: false },
        sunDir: this.shared.sunDir,
        sunE: this.shared.sunE,
        gain: { value: this.imagery?.gain ?? 1 },
        preExposure: PRE_EXPOSURE,
      },
      vertexShader: VS,
      fragmentShader: FS,
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(g, mat);
    mesh.position.copy(n.centerBF);
    mesh.frustumCulled = false;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    n.mesh = mesh;
  }

  private requestTile(n: Node): void {
    const im = this.imagery;
    if (!im || n.tex || n.loading || this.loads >= MAX_LOADS || n.level > im.maxLevel) return;
    n.loading = true;
    this.loads++;
    const url = im.url.replace("{z}", String(n.level)).replace("{y}", String(n.row)).replace("{x}", String(n.col));
    this.loader.load(
      url,
      (bmp) => {
        this.loads--;
        n.loading = false;
        const t = new THREE.Texture(bmp as unknown as HTMLImageElement);
        t.colorSpace = THREE.SRGBColorSpace;
        t.anisotropy = 4;
        t.needsUpdate = true;
        n.tex = t;
        if (n.mesh) {
          n.mesh.material.uniforms.tileMap!.value = t;
          n.mesh.material.uniforms.hasTile!.value = true;
        }
      },
      undefined,
      () => {
        this.loads--;
        n.loading = false;
        n.tex = null;
        n.lastUsed = -1e9; // don't hammer a missing tile
      },
    );
  }

  /**
   * Per frame.
   * @param bodyPos body centre, render space (camera at the origin)
   * @param icrfToBf row-major ICRF → body-fixed
   */
  update(bodyPos: THREE.Vector3, icrfToBf: ArrayLike<number>, sunDir: THREE.Vector3, sunE: number, camera: THREE.PerspectiveCamera): void {
    this.frame++;
    const R = icrfToBf;
    this.anchor.matrix.set(R[0]!, R[3]!, R[6]!, bodyPos.x, R[1]!, R[4]!, R[7]!, bodyPos.y, R[2]!, R[5]!, R[8]!, bodyPos.z, 0, 0, 0, 1);
    this.anchor.updateMatrixWorld(true);
    this.shared.sunDir.value.copy(sunDir);
    this.shared.sunE.value = sunE;
    // Camera in body-fixed coordinates: −Rᵀ… the camera is at the render origin.
    const cam = new THREE.Vector3(
      -(R[0]! * bodyPos.x + R[1]! * bodyPos.y + R[2]! * bodyPos.z),
      -(R[3]! * bodyPos.x + R[4]! * bodyPos.y + R[5]! * bodyPos.z),
      -(R[6]! * bodyPos.x + R[7]! * bodyPos.y + R[8]! * bodyPos.z),
    );
    const camDist = cam.length();
    const rMean = this.radii[0];
    const rpp = this.rpp();
    const frustum = new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
    const toRender = (v: THREE.Vector3) => v.clone().applyMatrix4(this.anchor.matrixWorld);
    const visible: Node[] = [];
    const maxLevel = Math.min(this.imagery?.maxLevel ?? 6, 12);
    const visit = (n: Node) => {
      n.lastUsed = this.frame;
      // Horizon culling: the node is behind the limb (with its bounding radius as margin).
      const dirN = n.centerBF.clone().normalize();
      const cosHorizon = camDist > rMean ? rMean / camDist : -1;
      const cosAngle = dirN.dot(cam.clone().normalize());
      const angMargin = n.radius / rMean;
      if (cosAngle < cosHorizon - angMargin * 1.2 - 0.02 && n.level > 1) return;
      const sphere = new THREE.Sphere(toRender(n.centerBF), n.radius);
      if (!frustum.intersectsSphere(sphere) && n.level > 0) return;
      const d = Math.max(1, cam.distanceTo(n.centerBF) - n.radius);
      const step = (n.radius * 2) / (GRID - 1);
      const px = step / d / rpp;
      // Always at least level 2 (45° tiles): coarser tiles would facet the limb.
      if ((px > SPLIT_PX || n.level < MIN_LEVEL) && n.level < maxLevel && this.nodes.size < MAX_NODES) {
        for (let r = 0; r < 2; r++) for (let c = 0; c < 2; c++) visit(this.node(n.level + 1, n.row * 2 + r, n.col * 2 + c));
      } else {
        visible.push(n);
      }
    };
    visit(this.node(0, 0, 0));
    visit(this.node(0, 0, 1));
    // Show the selected nodes; build meshes and request imagery as needed.
    const keep = new Set(visible.map((n) => n.key));
    for (const n of visible) {
      if (!n.mesh) this.buildMesh(n);
      if (n.mesh!.parent !== this.anchor) this.anchor.add(n.mesh!);
      if (n.tex) {
        n.mesh!.material.uniforms.tileMap!.value = n.tex;
        n.mesh!.material.uniforms.hasTile!.value = true;
      } else {
        this.requestTile(n);
      }
    }
    for (const n of this.nodes.values()) {
      if (!keep.has(n.key) && n.mesh?.parent) this.anchor.remove(n.mesh);
    }
    // Evict long-unused nodes (keep the roots).
    if (this.nodes.size > MAX_NODES * 0.8) {
      for (const [k, n] of this.nodes) {
        if (n.level > 0 && this.frame - n.lastUsed > 240 && !keep.has(k)) {
          n.mesh?.geometry.dispose();
          n.mesh?.material.dispose();
          n.tex?.dispose();
          this.nodes.delete(k);
        }
      }
    }
  }
}
