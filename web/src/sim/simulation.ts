// Simulation driver: owns the WASM Sim, the clock and time warp.
// All physics happens in Rust (crates/sim-core). This file only schedules it.

import { Sim } from "../wasm/sim_wasm.js";
import type { SimSettings } from "../settings";

/** Warp levels, 1× to 10,000,000× (spec §2.2). */
export const WARP_LEVELS = [1, 5, 10, 50, 100, 1_000, 10_000, 100_000, 1_000_000, 10_000_000] as const;

/** Per-frame budget for propagation work. At warp levels that would exceed it, the
 *  clock advances only as far as the budget allows (shown as "warp limited"). */
const FRAME_BUDGET_MS = 8;

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
}

export const SCENARIOS: Scenario[] = [
  {
    id: "leo400",
    name: "Low Earth orbit, 400 km",
    description: "Circular 400 km orbit at 51.6° inclination, 1 November 2026. The v1 spacecraft arrives in M5; a placeholder flies here for now.",
    epochUtc: "2026-11-01T00:00:00Z",
    center: 399,
    altitudeM: 400e3,
    inclinationDeg: 51.6,
    raanDeg: 0,
    massKg: 15_000,
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
    this.sim.spawnCircular(sc.center, sc.altitudeM, sc.inclinationDeg, sc.raanDeg, sc.massKg);
    this.warpIndex = 0;
    this.paused = false;
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

  /** Advance by `realDt` seconds of wall time × warp, within the frame budget. */
  tick(realDt: number): void {
    if (this.paused || !this.scenario) return;
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
      if (performance.now() - t0 > FRAME_BUDGET_MS && done < want) {
        this.warpLimited = true;
        break;
      }
    }
  }
}
