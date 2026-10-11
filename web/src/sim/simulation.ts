// Simulation driver: owns the WASM Sim, the clock and time warp.
// All physics happens in Rust (crates/sim-core). This file only schedules it.

import { Sim } from "../wasm/sim_wasm.js";
import type { SimSettings } from "../settings";
import { RS1, type Telemetry, type VehicleSource } from "./vehicle";
import type { AutopilotJson, PlanJson } from "../render/mapView";

/** Warp levels, 1× to 10,000,000× (spec §2.2). */
export const WARP_LEVELS = [1, 5, 10, 50, 100, 1_000, 10_000, 100_000, 1_000_000, 10_000_000] as const;

/** Per-frame budget for propagation work. At warp levels that would exceed it, the
 *  clock advances only as far as the budget allows (shown as "warp limited"). */
const FRAME_BUDGET_MS = 8;

/** Highest warp with step-by-step (50 Hz) vehicle physics. Above it the vehicle
 *  coasts on rails, which needs every actuator idle. */
export const PHYSICS_WARP_MAX = 10;

/** Pilot inputs, sent to the core every frame. */
export interface FlightControls {
  /** Roll, pitch, yaw stick in [−1, 1] (body x, y, z). */
  rotation: [number, number, number];
  /** Translation in [−1, 1] (body x forward, y right, z down). */
  translation: [number, number, number];
  throttle: number;
  /** SAS mode index (see SAS_MODES). */
  sas: number;
  rcs: boolean;
  fine: boolean;
  /** 0 orbit, 1 surface, 2 target. */
  speedRef: number;
}

export const SAS_MODES = ["Off", "Hold", "Prograde", "Retrograde", "Normal", "Anti-normal", "Radial out", "Radial in", "Target", "Anti-target", "Maneuver"] as const;
export const SPEED_REFS = ["Orbit", "Surface", "Target"] as const;

export interface Scenario {
  id: string;
  name: string;
  description: string;
  epochUtc: string;
  center: number;
  altitudeM: number;
  inclinationDeg: number;
  raanDeg: number;
  massKg: number;
  /** Fly this vehicle (6-DOF); without it, a cannonball of `massKg`. */
  vehicle?: VehicleSource;
}

export const SCENARIOS: Scenario[] = [
  {
    id: "leo400",
    name: "Low Earth orbit, 400 km",
    description: "RS-1 Corvid in a circular 400 km orbit at 51.6° inclination, 1 November 2026. Full tanks: about 3.45 km/s of main-engine Δv, enough for a lunar flyby.",
    epochUtc: "2026-11-01T00:00:00Z",
    center: 399,
    altitudeM: 400e3,
    inclinationDeg: 51.6,
    // The spawn point is the ascending node; the Sun is near RA 216° on 1 Nov 2026,
    // so a node at 200° starts the mission in daylight.
    raanDeg: 200,
    massKg: 24_960,
    vehicle: RS1,
  },
];

/** Test-only scenario: low Saturn orbit for the floating-origin jitter test. */
export const SATURN_TEST: Scenario = {
  id: "saturn-test",
  name: "Saturn orbit (test)",
  description: "",
  epochUtc: "2026-11-01T00:00:00Z",
  center: 699,
  altitudeM: 60_000e3,
  inclinationDeg: 20,
  // Node toward the Sun (RA ≈ 192° seen from Saturn in Nov 2026): starts in daylight.
  raanDeg: 192,
  massKg: 15_000,
};

export class Simulation {
  readonly sim = new Sim();
  warpIndex = 0;
  paused = false;
  /** True when the last frame could not keep up with the requested warp. */
  warpLimited = false;
  scenario: Scenario | null = null;
  controls: FlightControls = { rotation: [0, 0, 0], translation: [0, 0, 0], throttle: 0, sas: 1, rcs: true, fine: false, speedRef: 0 };
  /** True when warp was capped because the vehicle needs step-by-step physics. */
  warpCapped = false;
  private telemetryCache: { frame: number; t: Telemetry | null } = { frame: -1, t: null };
  private planCache: { wall: number; plan: PlanJson | null; ap: AutopilotJson | null } = { wall: -1e9, plan: null, ap: null };
  /** Target body (NAIF id) or −1. */
  targetId = -1;
  private frame = 0;

  /** Load ephemeris for the decade of `epochUtc`, falling back to the CI subset. */
  async loadEphemeris(epochUtc: string, onProgress?: (msg: string) => void): Promise<void> {
    const year = Number(epochUtc.slice(0, 4));
    const decade = Math.floor(year / 10) * 10;
    const candidates = [`ephemeris/ephem-${decade}.rseph`, "ephemeris/ephem_2026q4.rseph"];
    for (const url of candidates) {
      onProgress?.(`Loading ephemeris ${url}…`);
      const res = await fetch(url);
      if (!res.ok) continue;
      const bytes = new Uint8Array(await res.arrayBuffer());
      // Dev servers answer missing files with index.html (200): check the magic.
      if (new TextDecoder().decode(bytes.subarray(0, 5)) !== "RSEPH") continue;
      this.sim.loadEphemeris(bytes);
      return;
    }
    throw new Error("No ephemeris files found. Run `cargo run --release -p ephem-build -- build`.");
  }

  applySettings(s: SimSettings): void {
    this.sim.setTolerance(s.rtol);
    this.sim.setSpaceWeather(s.f107, s.f107a, s.ap);
    this.sim.setForces(s.thirdBody, s.harmonics, s.earthDegree, s.drag, s.srp);
  }

  start(sc: Scenario, settings: SimSettings): void {
    this.scenario = sc;
    this.sim.setEpochUtc(sc.epochUtc);
    this.applySettings(settings);
    if (sc.vehicle) {
      this.sim.loadVehicle(sc.vehicle.text);
      this.sim.spawnVehicle(sc.center, sc.altitudeM, sc.inclinationDeg, sc.raanDeg);
      this.controls = { rotation: [0, 0, 0], translation: [0, 0, 0], throttle: 0, sas: 1, rcs: true, fine: false, speedRef: 0 };
    } else {
      this.sim.spawnCircular(sc.center, sc.altitudeM, sc.inclinationDeg, sc.raanDeg, sc.massKg);
    }
    this.warpIndex = 0;
    this.paused = false;
    this.targetId = -1;
  }

  get warp(): number {
    return WARP_LEVELS[this.warpIndex] ?? 1;
  }

  warpUp(): void {
    this.warpIndex = Math.min(this.warpIndex + 1, WARP_LEVELS.length - 1);
  }

  warpDown(): void {
    this.warpIndex = Math.max(this.warpIndex - 1, 0);
  }

  get hasVehicle(): boolean {
    return this.scenario?.vehicle !== undefined;
  }

  /** Telemetry for this frame (parsed once per frame). */
  telemetry(): Telemetry | null {
    if (!this.hasVehicle) return null;
    if (this.telemetryCache.frame !== this.frame) {
      const txt = this.sim.telemetry();
      this.telemetryCache = { frame: this.frame, t: txt ? (JSON.parse(txt) as Telemetry) : null };
    }
    return this.telemetryCache.t;
  }

  stage(): void {
    this.sim.stage();
  }

  setTarget(id: number): void {
    this.targetId = id;
    this.sim.setTarget(id);
  }

  /** The maneuver plan and autopilot state, re-read at most 4× per second. */
  planState(): { plan: PlanJson | null; ap: AutopilotJson | null } {
    const now = performance.now();
    if (this.hasVehicle && now - this.planCache.wall > 250) {
      this.planCache = { wall: now, plan: JSON.parse(this.sim.planJson()) as PlanJson, ap: JSON.parse(this.sim.autopilotJson()) as AutopilotJson | null };
    }
    return this.planCache;
  }

  /** Advance by `realDt` seconds of wall time × warp, within the frame budget. */
  tick(realDt: number): void {
    this.frame++;
    if (this.paused || !this.scenario) return;
    if (this.hasVehicle) {
      const c = this.controls;
      this.sim.setControls(c.rotation[0], c.rotation[1], c.rotation[2], c.translation[0], c.translation[1], c.translation[2], c.throttle, c.sas, c.rcs, c.fine, c.speedRef);
      // Warp above the physics limit only while nothing fires (as in KSP).
      this.warpCapped = this.sim.needsPhysics() && this.warp > PHYSICS_WARP_MAX;
      if (this.warpCapped) this.warpIndex = WARP_LEVELS.indexOf(PHYSICS_WARP_MAX);
      this.sim.setRailsAllowed(this.warp > PHYSICS_WARP_MAX);
    }
    const want = Math.min(realDt, 0.25) * this.warp;
    const t0 = performance.now();
    // Sub-chunks keep the budget check responsive. Chunking cannot change results:
    // trajectory extension is bit-identical however it is split.
    const chunk = Math.max(want / 8, 1);
    let done = 0;
    this.warpLimited = false;
    while (done < want) {
      const dt = Math.min(chunk, want - done);
      this.sim.advance(dt);
      done += dt;
      // The burn autopilot stopped on-rails warp before ignition: back to 1×.
      if (this.hasVehicle && this.sim.takeWarpStop()) {
        this.warpIndex = 0;
        break;
      }
      if (performance.now() - t0 > FRAME_BUDGET_MS && done < want) {
        this.warpLimited = true;
        break;
      }
    }
  }
}
