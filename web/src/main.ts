import "./style.css";
import * as THREE from "three";
import { loadCore, type BodyRow } from "./core";
import { SettingsStore, type DepthMode } from "./settings";
import { SATURN_TEST, SCENARIOS, Simulation, type Scenario } from "./sim/simulation";
import { Engine } from "./render/engine";
import { World, type WorldAssets } from "./render/world";
import { loadStars } from "./render/sky";
import { Menus } from "./ui/menus";
import { SettingsPanel } from "./ui/settingsPanel";
import { Hud, TARGET_CYCLE } from "./ui/hud";
import { FlightInput } from "./ui/input";
import { VehicleView } from "./render/spacecraft";
import { MapView } from "./render/mapView";
import { CloudPass } from "./render/clouds";
import { loadHeightGrid, type HeightGrid } from "./render/planetSurface";
import type { SurfaceDef } from "./render/world";
import { EarthTiles } from "./render/earthTiles";
import { SurfaceAttribution } from "./ui/attribution";
import { surfaceSource } from "./settings";
import { toggleFullscreen } from "./desktop";
import { h } from "./ui/dom";

const params = new URLSearchParams(location.search);
const testScene = params.get("scene"); // "depth-test" | "saturn-jitter"
const forcedDepth = params.get("depth") as DepthMode | "standard" | null;
const testMode = params.has("test") || testScene !== null;

/** Test hooks (only with ?test or ?scene=…). */
interface TestHooks {
  ready: boolean;
  depth: string;
  frame(n?: number): Promise<void>;
  /** One synchronous simulation + render step (for timing). */
  stepNow(dt: number): void;
  readPixels(x: number, y: number, w: number, hgt: number): number[];
  regions?: { label: string; x: number; y: number; w: number; h: number }[];
  hudText?(): string;
  /** The simulation driver (flight tests set controls and read telemetry). */
  sim?: Simulation;
  /** World camera (tests frame the vehicle). */
  camera?: { setDistance(d: number, immediate?: boolean): void; setAngles(y: number, p: number, immediate?: boolean): void };
  /** World focus (tests look at bodies). */
  world?: { focus: number; focusTargets(): number[]; cycleFocus(dir: 1 | -1): void };
}
declare global {
  interface Window {
    __rocketsim?: TestHooks;
  }
}

function el(id: string): HTMLElement {
  const e = document.getElementById(id);
  if (!e) throw new Error(`missing #${id}`);
  return e;
}

async function loadTexture(url: string): Promise<THREE.Texture> {
  return new THREE.TextureLoader().loadAsync(url);
}

async function loadAssets(quality: "standard" | "high", status: (s: string) => void): Promise<WorldAssets> {
  const hi = quality === "high";
  const pick = async (high: string, std: string) => {
    if (hi) {
      try {
        return await loadTexture(high);
      } catch {
        // High-resolution assets are optional (scripts/fetch-assets.sh).
      }
    }
    return loadTexture(std);
  };
  status("Loading textures…");
  status("Loading terrain…");
  const terrain = new Map<number, HeightGrid>();
  const terrainBytes = new Map<number, Uint8Array>();
  await Promise.all(
    ([[399, "earth"], [301, "moon"], [499, "mars"]] as const).map(async ([id, name]) => {
      try {
        const { grid, bytes } = await loadHeightGrid(`terrain/${name}.rsdem`);
        terrain.set(id, grid);
        terrainBytes.set(id, bytes);
      } catch (e) {
        console.warn(`terrain ${name}: ${String(e)}`);
      }
    }),
  );
  status("Loading planet maps…");
  const surfaceDefs = (await fetch("assets/surfaces.json").then((r) => r.json())) as Record<string, SurfaceDef>;
  const surfaces = new Map<number, { def: SurfaceDef; base: THREE.Texture }>();
  await Promise.all(
    Object.entries(surfaceDefs).map(async ([id, def]) => {
      try {
        surfaces.set(Number(id), { def, base: await loadTexture(def.base) });
      } catch (e) {
        console.warn(`surface ${def.name}: ${String(e)}`);
      }
    }),
  );
  const [day, night, milkyWay, water, clouds] = await Promise.all([
    pick("assets/earth_day_5400.jpg", "assets/earth_day_2048.jpg"),
    pick("assets/earth_night_8192.jpg", "assets/earth_night_2048.jpg"),
    pick("assets/milkyway_4096.jpg", "assets/milkyway_2048.jpg"),
    pick("assets/earth_water_4096.png", "assets/earth_water_2048.png"),
    pick("assets/earth_clouds_8192.jpg", "assets/earth_clouds_2048.jpg"),
  ]);
  status("Loading star catalog…");
  const stars = await loadStars("assets/stars_hip_v8.bin");
  return { day, night, milkyWay, water, clouds, surfaces, terrain, terrainBytes, stars };
}

function makeTestHooks(engine: Engine, step: (dt: number) => void): TestHooks {
  const gl = engine.renderer.getContext();
  return {
    ready: false,
    depth: engine.depth,
    frame: (n = 1) =>
      new Promise((resolve) => {
        let left = n;
        const tick = () => {
          step(1 / 60);
          if (--left <= 0) resolve();
          else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }),
    stepNow: step,
    readPixels(x, y, w, hgt) {
      const buf = new Uint8Array(w * hgt * 4);
      // GL origin is bottom-left; callers pass top-left coordinates.
      const H = engine.renderer.domElement.height;
      gl.readPixels(x, H - y - hgt, w, hgt, gl.RGBA, gl.UNSIGNED_BYTE, buf);
      return Array.from(buf);
    },
  };
}

/** Depth-precision test scene (spec §1/§6): for each distance from 2 m to 6e11 m (Jupiter),
 *  a green quad sits in front of a red one with a relative gap of 1e-3. Any z-fighting
 *  shows up as red pixels in the green region. */
function runDepthTest(engine: Engine): void {
  engine.forceExposure(1);
  const distances = [2, 1e3, 1e6, 1e9, 6e11];
  const regions: TestHooks["regions"] = [];
  engine.resize();
  const cam = engine.camera;
  cam.position.set(0, 0, 0);
  cam.lookAt(0, 0, -1);
  cam.near = 0.05;
  cam.updateProjectionMatrix();
  const W = engine.pixelSize.x, H = engine.pixelSize.y;
  const halfH = Math.tan(((cam.fov / 2) * Math.PI) / 180);
  distances.forEach((d, i) => {
    const xNdc = -0.8 + (1.6 * i) / (distances.length - 1);
    const xView = xNdc * halfH * cam.aspect;
    const size = 0.12 * d * halfH;
    for (const [color, dist] of [[0x00ff00, d], [0xff0000, d * (1 + 1e-3)]] as const) {
      const m = new THREE.Mesh(
        new THREE.PlaneGeometry(size * (dist / d), size * (dist / d)),
        new THREE.ShaderMaterial({
          uniforms: { c: { value: new THREE.Color(color) } },
          vertexShader: `#include <common>\n#include <logdepthbuf_pars_vertex>\nvoid main(){ gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0);\n#include <logdepthbuf_vertex>\n}`,
          fragmentShader: `#include <common>\n#include <logdepthbuf_pars_fragment>\nuniform vec3 c; void main(){\n#include <logdepthbuf_fragment>\ngl_FragColor = vec4(c, 1.0); }`,
        }),
      );
      m.position.set(xView * dist, 0, -dist);
      engine.scene.add(m);
    }
    const px = ((xNdc + 1) / 2) * W, py = H / 2;
    const half = Math.floor(0.04 * H);
    regions.push({ label: `${d} m`, x: Math.round(px - half), y: Math.round(py - half), w: 2 * half, h: 2 * half });
  });
  const hooks = makeTestHooks(engine, (dt) => engine.render(dt, null));
  hooks.regions = regions;
  window.__rocketsim = hooks;
  const loop = () => {
    engine.render(1 / 60, null);
    hooks.ready = true;
    requestAnimationFrame(loop);
  };
  loop();
}

/** Sky check (?scene=sky&ra=deg&dec=deg&fov=deg): stars and Milky Way only, camera
 *  pointed at a celestial direction, for verifying catalog positions (e.g. Orion). */
async function runSkyView(engine: Engine): Promise<void> {
  const { MilkyWay, StarField, radecToVector } = await import("./render/sky");
  const ra = (Number(params.get("ra") ?? 83.8) * Math.PI) / 180;
  const dec = (Number(params.get("dec") ?? -1) * Math.PI) / 180;
  engine.camera.fov = Number(params.get("fov") ?? 40);
  const assets = await loadAssets("standard", () => {});
  const stars = new StarField(assets.stars, 8, 26.8);
  const mw = new MilkyWay(assets.milkyWay);
  const boost = Number(params.get("boost") ?? 1);
  engine.skyScene.add(mw.mesh, stars.points);
  const dir = radecToVector(ra, dec);
  engine.camera.up.set(0, 0, 1);
  engine.camera.lookAt(dir);
  engine.camera.updateMatrixWorld();
  const loop = () => {
    engine.resize();
    stars.update(engine.radiansPerPixel, boost);
    mw.setBoost(boost);
    engine.render(1 / 60, null);
    requestAnimationFrame(loop);
  };
  loop();
}

async function main(): Promise<void> {
  const canvas = el("view") as HTMLCanvasElement;
  const status = el("boot-status");
  const store = new SettingsStore();
  const settings = store.get();
  const engine = new Engine(canvas, settings.graphics, forcedDepth ?? undefined, testMode);
  window.addEventListener("resize", () => engine.resize());

  if (testScene === "depth-test") {
    el("boot").classList.add("hidden");
    runDepthTest(engine);
    return;
  }
  if (testScene === "sky") {
    el("boot").classList.add("hidden");
    await runSkyView(engine);
    return;
  }

  status.textContent = "Loading physics core…";
  const core = await loadCore();
  const bodies: BodyRow[] = core.bodies;
  const sim = new Simulation();
  const scenario: Scenario = testScene === "saturn-jitter" ? SATURN_TEST : SCENARIOS[0]!;
  await sim.loadEphemeris(scenario.epochUtc, (m) => (status.textContent = m));
  const assets = await loadAssets(settings.graphics.textureQuality, (m) => (status.textContent = m));
  // The same height grids drive ground contact in the physics core.
  for (const [id, bytes] of assets.terrainBytes) sim.sim.loadTerrain(id, bytes);
  sim.start(scenario, settings.sim);
  const world = new World(engine, sim, bodies, assets, settings);
  engine.clouds = new CloudPass(assets.clouds);
  // Google 3D tiles: only with a key and the setting on (otherwise nothing is requested).
  const attribution = new SurfaceAttribution();
  const syncTiles = (s: ReturnType<typeof store.get>) => {
    const src = surfaceSource(s);
    const same = (a: typeof src, b: typeof src) => JSON.stringify(a) === JSON.stringify(b);
    if (world.tiles && !same(world.tiles.source, src)) {
      world.tiles.dispose();
      world.tiles = null;
    }
    if (src && !world.tiles) {
      world.tiles = new EarthTiles(engine, src, s.earth.tileError);
      engine.scene.add(world.tiles.anchor);
    } else if (world.tiles) {
      world.tiles.errorTarget = s.earth.tileError;
    }
  };
  syncTiles(settings);
  // Vehicle models, loaded once per definition.
  const vehicleViews = new Map<string, VehicleView>();
  const useVehicle = async (sc: Scenario) => {
    if (!sc.vehicle) return world.setVehicle(null);
    let v = vehicleViews.get(sc.vehicle.def.model);
    if (!v) {
      status.textContent = `Loading ${sc.vehicle.def.name}…`;
      v = await VehicleView.load(sc.vehicle.def);
      vehicleViews.set(sc.vehicle.def.model, v);
    }
    world.setVehicle(v);
  };
  await useVehicle(scenario);
  if (params.has("debug")) Object.assign(window, { rs: { sim, world, engine, THREE } });

  // UI.
  const ui = el("ui");
  let inGame = false;
  let settingsOpen = false;
  const hud = new Hud(sim, (d) => (d > 0 ? sim.warpUp() : sim.warpDown()), () => (sim.paused = !sim.paused));
  hud.setBodyNames(new Map(bodies.map((b) => [b.id, b.name])));
  hud.setVehicle(scenario.vehicle?.def ?? null);
  const input = new FlightInput(
    () => sim.controls,
    () => store.get().controls,
    {
      stage: () => sim.stage(),
      cycleTarget: () => {
        const i = TARGET_CYCLE.indexOf(sim.targetId);
        sim.setTarget(TARGET_CYCLE[(i + 1) % TARGET_CYCLE.length]!);
      },
    },
  );
  const settingsPanel = new SettingsPanel(store, () => closeSettings(), () => engine.depth);
  let closeSettingsTo: () => void = () => {};
  const closeSettings = () => {
    settingsOpen = false;
    settingsPanel.root.remove();
    closeSettingsTo();
  };
  const menus: Menus = new Menus(
    {
      async startMission(s) {
        sim.start(s, store.get().sim);
        await useVehicle(s);
        hud.setVehicle(s.vehicle?.def ?? null);
        mapView.setActive(false);
        engine.resetAdaptation();
        world.focus = -1;
        world.camera.minDistance = 1.5;
        world.camera.setDistance(35, true);
        inGame = true;
        input.enabled = true;
        menus.hide();
        hud.show(true);
      },
      openSettings(back) {
        settingsOpen = true;
        closeSettingsTo = back;
        menus.hide();
        ui.append(settingsPanel.render());
      },
      resume() {
        sim.paused = false;
        menus.hide();
        hud.show(true);
      },
      toMainMenu() {
        inGame = false;
        input.enabled = false;
        mapView.setActive(false);
        hud.show(false);
        menus.main();
      },
    },
    core.version,
  );
  hud.onRestart = () => {
    if (sim.scenario) void menus.actions.startMission(sim.scenario);
  };
  hud.onMainMenu = () => menus.actions.toMainMenu();
  const mapView = new MapView(engine, world, sim, bodies);
  ui.append(mapView.overlay, mapView.panel, mapView.track, menus.root, hud.root, attribution.root);
  const syncCamera = (s: ReturnType<typeof store.get>) => {
    world.camera.invertX = s.controls.invertCameraX;
    world.camera.invertY = s.controls.invertCameraY;
  };
  syncCamera(settings);
  store.subscribe((s) => {
    syncCamera(s);
    syncTiles(s);
    engine.applySettings(s.graphics);
    world.applySettings(s, assets);
    sim.applySettings(s.sim);
    hud.setScale(s.ui.hudScale);
  });
  hud.setScale(settings.ui.hudScale);

  const camKeys = new Set<string>();
  const CAMERA_KEYS = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Equal", "Minus", "NumpadAdd", "NumpadSubtract", "PageUp", "PageDown"];
  window.addEventListener("keyup", (e) => camKeys.delete(e.code));
  window.addEventListener("blur", () => camKeys.clear());
  window.addEventListener("keydown", (e) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
    if (CAMERA_KEYS.includes(e.code)) {
      camKeys.add(e.code);
      e.preventDefault();
    }
    if (e.key === "F11") {
      e.preventDefault();
      void toggleFullscreen();
      return;
    }
    if (e.key === "Escape") {
      if (settingsOpen) closeSettings();
      else if (inGame) {
        if (menus.root.classList.contains("hidden")) {
          sim.paused = true;
          hud.show(false);
          menus.pause();
        } else menus.hide(), hud.show(true), (sim.paused = false);
      }
      return;
    }
    if (!inGame) return;
    switch (e.key) {
      case ".": sim.warpUp(); break;
      case ",": sim.warpDown(); break;
      case "/": sim.warpIndex = 0; break;
      case "p": case "P": sim.paused = !sim.paused; break;
      case "]": world.cycleFocus(1); break;
      case "[": world.cycleFocus(-1); break;
      case "o": case "O": store.update((s) => (s.ui.showOrbit = !s.ui.showOrbit)); break;
      case "m": case "M": if (sim.hasVehicle) mapView.setActive(!mapView.active), hud.setMap(mapView.active); break;
      case "g": case "G": mapView.toggleTrack(); break;
      case "Delete": case "Backspace": if (mapView.active) mapView.deleteSelected(); break;
      case "F3": hud.debug = !hud.debug; e.preventDefault(); break;
    }
  });

  el("boot").classList.add("hidden");

  // Menu background: the scenario seen from afar, slowly turning.
  world.camera.setDistance(2.2e7, true);
  world.camera.minDistance = 1.5;

  const centerNames = new Map(bodies.map((b) => [b.id, b.name]));
  let last = performance.now();
  const step = (dt: number) => {
    input.update(dt);
    // Keyboard camera: arrows orbit, = / − (or PageUp / PageDown) zoom.
    if (inGame && !settingsOpen) {
      const k = (c: string) => (camKeys.has(c) ? 1 : 0);
      const rot = 1.2 * dt;
      const yaw = (k("ArrowRight") - k("ArrowLeft")) * rot;
      const pitch = (k("ArrowDown") - k("ArrowUp")) * rot;
      const zin = k("Equal") + k("NumpadAdd") + k("PageUp");
      const zout = k("Minus") + k("NumpadSubtract") + k("PageDown");
      const zoom = Math.exp((zout - zin) * 1.8 * dt);
      if (yaw || pitch || zoom !== 1) world.camera.nudge(yaw, pitch, zoom);
    }
    hud.stageProgress = input.stageProgress;
    if (inGame || testScene) sim.tick(dt);
    else world.camera.spin(dt * 0.02);
    world.update(dt);
    mapView.keysFine = sim.controls.fine;
    mapView.update(dt);
    attribution.update(world.tiles ? { ...world.tiles.attributions(), google: world.tiles.google } : null, hud.root);
    engine.render(dt, world.atmo);
    hud.update(dt, world.focusName(), centerNames.get(world.centerId) ?? "?", { showFps: store.get().ui.showFps, depth: engine.depth });
  };

  if (testScene === "saturn-jitter") {
    // Fixed exposure and a camera 2 m from the hull, so frames can be compared exactly.
    engine.forceExposure(50);
    // 6 m from the center: ~2 m from the 2 m-radius hull.
    world.camera.minDistance = 1;
    world.camera.setDistance(6, true);
    world.camera.setAngles(2.2, 0.1, true);
    const hooks = makeTestHooks(engine, step);
    hooks.hudText = () => hud.root.textContent ?? "";
    window.__rocketsim = hooks;
    step(1 / 60);
    hooks.ready = true;
    return; // the test drives frames explicitly
  }

  menus.main();
  if (testMode) {
    const hooks = makeTestHooks(engine, step);
    hooks.hudText = () => hud.root.textContent ?? "";
    hooks.sim = sim;
    hooks.camera = world.camera;
    hooks.world = world;
    window.__rocketsim = hooks;
  }
  const loop = (now: number) => {
    const dt = Math.min((now - last) / 1000, 0.1);
    last = now;
    step(dt);
    if (window.__rocketsim) window.__rocketsim.ready = true;
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}

main().catch((e: unknown) => {
  console.error(e);
  const s = document.getElementById("boot-status");
  if (s) s.textContent = `Failed to start: ${String(e)}`;
  document.body.append(h("div", { class: "fatal" }, String(e)));
});
