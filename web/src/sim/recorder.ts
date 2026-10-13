// Flight recorder (M10): spacecraft state and attitude sampled along the flight, for
// replays. A sample is [t (TDB s), center, rx, ry, rz, vx, vy, vz, qw, qx, qy, qz]. The
// spacing is 1 s of simulation time, longer under time warp (warp/10 s); past MAX
// samples, every other old sample is dropped (the oldest part gets coarser).

import type { Simulation } from "./simulation";

const STRIDE = 12;
const MAX = 20_000;

export class FlightRecorder {
  private data: number[] = [];
  private last = -Infinity;

  clear(): void {
    this.data = [];
    this.last = -Infinity;
  }

  get count(): number {
    return this.data.length / STRIDE;
  }

  get start(): number {
    return this.data[0] ?? 0;
  }

  get end(): number {
    return this.data[this.data.length - STRIDE] ?? 0;
  }

  sample(sim: Simulation): void {
    const s = sim.sim;
    if (s.outcome() !== "flying") return;
    const t = s.epochTdb();
    if (t - this.last < Math.max(1, sim.warp / 10)) return;
    const sc = s.spacecraft();
    const q = s.attitude();
    if (sc.length < 7 || q.length < 4) return;
    this.last = t;
    this.data.push(t, sc[0]!, sc[1]!, sc[2]!, sc[3]!, sc[4]!, sc[5]!, sc[6]!, q[0]!, q[1]!, q[2]!, q[3]!);
    if (this.count > MAX) {
      // Drop every other sample in the older half.
      const half = Math.floor(this.count / 2);
      const keep: number[] = [];
      for (let i = 0; i < this.count; i++) {
        if (i < half && i % 2 === 1) continue;
        keep.push(...this.data.slice(i * STRIDE, (i + 1) * STRIDE));
      }
      this.data = keep;
    }
  }

  /** Interpolated sample at `t` (linear in position/velocity, slerp in attitude). */
  at(t: number): number[] | null {
    const n = this.count;
    if (n === 0) return null;
    const d = this.data;
    if (t <= d[0]!) return d.slice(0, STRIDE);
    if (t >= this.end) return d.slice((n - 1) * STRIDE, n * STRIDE);
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) {
      const m = (lo + hi) >> 1;
      if (d[m * STRIDE]! <= t) lo = m;
      else hi = m;
    }
    const a = lo * STRIDE, b = hi * STRIDE;
    // Across a change of centre body, hold the earlier sample (frames differ).
    if (d[a + 1] !== d[b + 1]) return d.slice(a, a + STRIDE);
    const f = (t - d[a]!) / (d[b]! - d[a]!);
    const out = [t, d[a + 1]!];
    for (let k = 2; k < 8; k++) out.push(d[a + k]! + (d[b + k]! - d[a + k]!) * f);
    // Quaternion slerp (shortest arc).
    let dot = 0;
    for (let k = 8; k < 12; k++) dot += d[a + k]! * d[b + k]!;
    const sgn = dot < 0 ? -1 : 1;
    dot = Math.min(1, Math.abs(dot));
    const th = Math.acos(dot);
    const w0 = th < 1e-6 ? 1 - f : Math.sin((1 - f) * th) / Math.sin(th);
    const w1 = th < 1e-6 ? f : Math.sin(f * th) / Math.sin(th);
    for (let k = 8; k < 12; k++) out.push(w0 * d[a + k]! + w1 * sgn * d[b + k]!);
    return out;
  }

  export(): number[] {
    return this.data.slice();
  }

  import(v: number[]): void {
    this.data = v.length % STRIDE === 0 ? v.slice() : [];
    this.last = this.count > 0 ? this.end : -Infinity;
  }
}
