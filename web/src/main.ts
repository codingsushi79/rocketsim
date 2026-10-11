import "./style.css";
import * as THREE from "three";
import { loadCore } from "./core";

function el(id: string): HTMLElement {
  const e = document.getElementById(id);
  if (!e) throw new Error(`missing #${id}`);
  return e;
}

// Minimal three.js scene that proves the rendering stack. The real renderer
// (floating origin, log depth, atmosphere) arrives in M4.
function startScene(canvas: HTMLCanvasElement): void {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 100);
  camera.position.set(0, 0, 4);
  const globe = new THREE.Mesh(
    new THREE.IcosahedronGeometry(1, 3),
    new THREE.MeshBasicMaterial({ color: 0x3d7bd9, wireframe: true }),
  );
  scene.add(globe);
  const resize = () => {
    const { innerWidth: w, innerHeight: h } = window;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  window.addEventListener("resize", resize);
  resize();
  renderer.setAnimationLoop((t) => {
    globe.rotation.y = t * 1e-4;
    renderer.render(scene, camera);
  });
}

async function main(): Promise<void> {
  startScene(el("view") as HTMLCanvasElement);
  const core = await loadCore();
  el("version").textContent = `sim-core ${core.version} (WASM)`;
  el("canary").textContent = core.canary;

  const tbody = el("bodies").querySelector("tbody")!;
  for (const b of core.bodies) {
    const tr = document.createElement("tr");
    for (const v of [b.id, b.name, b.gm.toExponential(6), ((b.radii[0] + b.radii[1]) / 2000).toFixed(1)]) {
      const td = document.createElement("td");
      td.textContent = String(v);
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  el("body-count").textContent = String(core.bodies.length);

  const tick = () => {
    // The browser clock ignores leap seconds; that only matters while one is
    // being inserted, and this is a display clock.
    const utc = new Date().toISOString();
    const tdb = core.utcToTdbSeconds(utc);
    el("utc").textContent = utc + (core.isProvisionalUtc(utc) ? " (provisional)" : "");
    el("tdb").textContent = `${tdb.toFixed(3)} s past J2000 TDB`;
  };
  tick();
  setInterval(tick, 100);
}

main().catch((e: unknown) => {
  el("version").textContent = `failed to load core: ${String(e)}`;
  console.error(e);
});
