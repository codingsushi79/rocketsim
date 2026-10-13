// Transfer planner (M9): pick a target, compute a porkchop of departure date × time of
// flight (Lambert arcs in the core), click a cell, and plan: the core builds the departure
// burn and a midcourse correction and corrects them on the n-body propagator.

import type { BodyRow } from "../core";
import type { Simulation } from "../sim/simulation";
import { clear, h } from "./dom";

const DAY = 86_400;

interface Grid {
  nDep: number;
  nTof: number;
  dep: Float64Array;
  tof: Float64Array;
  dv: Float64Array;
  vinf: Float64Array;
  min: number;
  minAt: number;
}

/** Colour ramp for Δv (0 = best, 1 = worst shown): dark blue → cyan → yellow → red. */
function ramp(t: number): [number, number, number] {
  const stops: [number, number, number, number][] = [
    [0, 20, 30, 70],
    [0.25, 30, 150, 200],
    [0.55, 230, 220, 90],
    [1, 220, 70, 50],
  ];
  const x = Math.min(1, Math.max(0, t));
  for (let i = 1; i < stops.length; i++) {
    const a = stops[i - 1]!, b = stops[i]!;
    if (x <= b[0]) {
      const f = (x - a[0]) / (b[0] - a[0]);
      return [a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f, a[3] + (b[3] - a[3]) * f];
    }
  }
  return [220, 70, 50];
}

export class TransferPlanner {
  readonly root = h("div", { class: "transfer-panel hidden" });
  private canvas = h("canvas", { width: 360, height: 220, class: "porkchop" }) as HTMLCanvasElement;
  private targetSel = h("select", {}) as HTMLSelectElement;
  private periInput = h("input", { type: "number", step: "10", value: "200" }) as HTMLInputElement;
  private info = h("div", { class: "transfer-info mono" });
  private status = h("div", { class: "note" });
  private grid: Grid | null = null;
  private sel = -1;

  constructor(
    private sim: Simulation,
    private bodies: BodyRow[],
  ) {
    this.canvas.addEventListener("click", (e) => this.pick(e));
    this.targetSel.addEventListener("change", () => {
      this.grid = null;
      this.periInput.value = String(this.defaultPeriapsisKm(Number(this.targetSel.value)));
      this.draw();
    });
    this.root.append(
      h("div", { class: "panel-title" }, "TRANSFER PLANNER"),
      h("label", { class: "dv-row" }, h("span", { class: "lbl" }, "Target"), this.targetSel, h("span", {})),
      h("label", { class: "dv-row" }, h("span", { class: "lbl" }, "Periapsis"), this.periInput, h("span", { class: "lbl" }, "km")),
      h("div", { class: "menu-footer" }, h("button", { id: "btn-porkchop", onclick: () => this.compute() }, "Find window")),
      this.canvas,
      this.info,
      h(
        "div",
        { class: "menu-footer" },
        h("button", { id: "btn-correct-course", title: "Retarget the midcourse burn from where you actually are", onclick: () => this.correct() }, "Correct course"),
        h("button", { id: "btn-plan-transfer", class: "primary", onclick: () => this.plan() }, "Plan transfer"),
      ),
      this.status,
    );
  }

  setActive(on: boolean): void {
    this.root.classList.toggle("hidden", !on);
    if (on) this.refreshTargets();
  }

  private name(id: number): string {
    return this.bodies.find((b) => b.id === id)?.name ?? String(id);
  }

  private defaultPeriapsisKm(id: number): number {
    return id === 301 ? 200 : id === 499 ? 300 : 500;
  }

  /** Targets the core can plan: satellites of the current centre, or its siblings. */
  private refreshTargets(): void {
    const sc = this.sim.sim.spacecraft();
    if (sc.length < 1) return;
    const center = sc[0]!;
    const parent = this.bodies.find((b) => b.id === center)?.parent ?? null;
    const opts = this.bodies.filter((b) => b.id !== center && b.kind !== "barycenter" && (b.parent === center || (parent !== null && b.parent === parent && b.kind === "planet")));
    const cur = Number(this.targetSel.value || this.sim.targetId);
    clear(this.targetSel);
    for (const b of opts) this.targetSel.append(h("option", { value: String(b.id) }, b.name));
    if (opts.length === 0) this.targetSel.append(h("option", { value: "", disabled: true, selected: true }, "No transfer targets from here"));
    const want = opts.some((b) => b.id === cur) ? cur : opts.some((b) => b.id === this.sim.targetId) ? this.sim.targetId : opts[0]?.id;
    if (want !== undefined) {
      this.targetSel.value = String(want);
      if (!this.periInput.dataset.touched) this.periInput.value = String(this.defaultPeriapsisKm(want));
    }
  }

  /** Search ranges from the Hohmann transfer time (and the synodic period for planets). */
  private ranges(target: number): { t0: number; t1: number; tofMin: number; tofMax: number; nDep: number; nTof: number } | null {
    const s = this.sim.sim;
    const sc = s.spacecraft();
    if (sc.length < 7) return null;
    const center = sc[0]!;
    const now = s.epochTdb();
    const crow = this.bodies.find((b) => b.id === center);
    const trow = this.bodies.find((b) => b.id === target);
    if (!crow || !trow) return null;
    const rsc = Math.hypot(sc[1]!, sc[2]!, sc[3]!);
    const vsc = Math.hypot(sc[4]!, sc[5]!, sc[6]!);
    const hohmann = (mu: number, r1: number, r2: number) => Math.PI * Math.sqrt(((r1 + r2) / 2) ** 3 / mu);
    if (trow.parent === center) {
      const rt = s.relativeState(target, center);
      const d = Math.hypot(rt[0]!, rt[1]!, rt[2]!);
      const tH = hohmann(crow.gm, rsc, d);
      const period = (2 * Math.PI * rsc) / vsc;
      return { t0: now + 600, t1: now + 600 + period, tofMin: 0.6 * tH, tofMax: 1.4 * tH, nDep: 48, nTof: 24 };
    }
    const parent = crow.parent!;
    const prow = this.bodies.find((b) => b.id === parent)!;
    const a = s.relativeState(center, parent);
    const b = s.relativeState(target, parent);
    const r1 = Math.hypot(a[0]!, a[1]!, a[2]!), r2 = Math.hypot(b[0]!, b[1]!, b[2]!);
    const T = (r: number) => 2 * Math.PI * Math.sqrt(r ** 3 / prow.gm);
    const syn = 1 / Math.abs(1 / T(r1) - 1 / T(r2));
    const tH = hohmann(prow.gm, r1, r2);
    return { t0: now + 3600, t1: now + Math.min(syn, 800 * DAY), tofMin: 0.55 * tH, tofMax: 1.35 * tH, nDep: 60, nTof: 30 };
  }

  private compute(): void {
    const target = Number(this.targetSel.value);
    const r = this.ranges(target);
    if (!r) return;
    this.status.textContent = "Computing porkchop…";
    // Let the status paint first.
    setTimeout(() => {
      const t = performance.now();
      const v = this.sim.sim.transferPorkchop(target, r.t0, r.t1, r.nDep, r.tofMin, r.tofMax, r.nTof);
      if (v.length < 2) {
        this.status.textContent = "No flight state.";
        return;
      }
      const nDep = v[0]!, nTof = v[1]!, n = nDep * nTof;
      let o = 2;
      const dep = v.slice(o, (o += nDep)), tof = v.slice(o, (o += nTof)), dv = v.slice(o, (o += n)), vinf = v.slice(o, (o += n));
      let min = Infinity, minAt = -1;
      dv.forEach((x, i) => {
        if (Number.isFinite(x) && x < min) (min = x), (minAt = i);
      });
      this.grid = { nDep, nTof, dep, tof, dv, vinf, min, minAt };
      this.sel = minAt;
      this.status.textContent = `${n} Lambert arcs in ${(performance.now() - t).toFixed(0)} ms. Best Δv marked; click to choose.`;
      this.draw();
    }, 20);
  }

  private pick(e: MouseEvent): void {
    const g = this.grid;
    if (!g) return;
    const r = this.canvas.getBoundingClientRect();
    const fx = (e.clientX - r.left) / r.width, fy = (e.clientY - r.top) / r.height;
    const pad = this.pad();
    const W = this.canvas.width, H = this.canvas.height;
    const x = (fx * W - pad.l) / (W - pad.l - pad.r), y = 1 - (fy * H - pad.t) / (H - pad.t - pad.b);
    if (x < 0 || x > 1 || y < 0 || y > 1) return;
    const i = Math.min(g.nDep - 1, Math.floor(x * g.nDep)), j = Math.min(g.nTof - 1, Math.floor(y * g.nTof));
    this.sel = i * g.nTof + j;
    this.draw();
  }

  private pad() {
    return { l: 36, r: 8, t: 8, b: 26 };
  }

  private draw(): void {
    const ctx = this.canvas.getContext("2d")!;
    const W = this.canvas.width, H = this.canvas.height;
    ctx.fillStyle = "#05070a";
    ctx.fillRect(0, 0, W, H);
    const g = this.grid;
    clear(this.info);
    if (!g) return;
    const p = this.pad();
    const pw = W - p.l - p.r, ph = H - p.t - p.b;
    const cw = pw / g.nDep, ch = ph / g.nTof;
    // Colour range: best Δv to +60 % (clipped).
    const span = Math.max(g.min * 0.6, 200);
    for (let i = 0; i < g.nDep; i++) {
      for (let j = 0; j < g.nTof; j++) {
        const v = g.dv[i * g.nTof + j]!;
        if (!Number.isFinite(v)) continue;
        const [r, gg, b] = ramp((v - g.min) / span);
        ctx.fillStyle = `rgb(${r | 0},${gg | 0},${b | 0})`;
        ctx.fillRect(p.l + i * cw, p.t + ph - (j + 1) * ch, Math.ceil(cw), Math.ceil(ch));
      }
    }
    // Axes.
    ctx.fillStyle = "#8a949e";
    ctx.font = "10px Plex Mono, ui-monospace, monospace";
    const now = this.sim.sim.epochTdb();
    const isLocal = g.dep[g.nDep - 1]! - g.dep[0]! < 2 * DAY;
    for (let k = 0; k <= 4; k++) {
      const i = Math.round((k / 4) * (g.nDep - 1));
      const t = g.dep[i]! - now;
      ctx.fillText(isLocal ? `+${(t / 60).toFixed(0)}m` : `+${(t / DAY).toFixed(0)}d`, p.l + (i + 0.5) * cw - 12, H - 12);
    }
    for (let k = 0; k <= 3; k++) {
      const j = Math.round((k / 3) * (g.nTof - 1));
      ctx.fillText(`${(g.tof[j]! / DAY).toFixed(isLocal ? 1 : 0)}d`, 2, p.t + ph - (j + 0.5) * ch + 3);
    }
    ctx.fillText(isLocal ? "departure (min from now) →" : "departure (days from now) →", p.l + pw / 2 - 70, H - 1);
    // Markers: best (white ring) and selection (crosshair).
    const mark = (idx: number, color: string, cross: boolean) => {
      const i = Math.floor(idx / g.nTof), j = idx % g.nTof;
      const x = p.l + (i + 0.5) * cw, y = p.t + ph - (j + 0.5) * ch;
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      if (cross) {
        ctx.moveTo(x - 8, y);
        ctx.lineTo(x + 8, y);
        ctx.moveTo(x, y - 8);
        ctx.lineTo(x, y + 8);
      } else ctx.arc(x, y, 5, 0, Math.PI * 2);
      ctx.stroke();
    };
    if (g.minAt >= 0) mark(g.minAt, "#ffffff", false);
    if (this.sel >= 0) mark(this.sel, "#ffb547", true);
    if (this.sel >= 0) {
      const i = Math.floor(this.sel / g.nTof), j = this.sel % g.nTof;
      const row = (k: string, v: string) => h("div", { class: "row" }, h("span", { class: "lbl" }, k), h("span", {}, v));
      const dt = g.dep[i]! - now;
      this.info.append(
        row("Departure", isLocal ? `T+${(dt / 60).toFixed(0)} min` : `T+${(dt / DAY).toFixed(1)} d`),
        row("Flight time", `${(g.tof[j]! / DAY).toFixed(2)} d`),
        row("Departure Δv", `${g.dv[this.sel]!.toFixed(0)} m/s`),
        row(`v∞ at ${this.name(Number(this.targetSel.value))}`, `${(g.vinf[this.sel]! / 1000).toFixed(2)} km/s`),
      );
    }
  }

  private correct(): void {
    if (!this.sim.guidance) {
      const target = Number(this.targetSel.value);
      this.sim.guidance = { target, periapsisAltM: Number(this.periInput.value) * 1000 };
    }
    this.status.textContent = "Correcting on the n-body propagator…";
    setTimeout(() => (this.status.textContent = this.sim.correctCourse()), 20);
  }

  private plan(): void {
    const g = this.grid;
    if (!g || this.sel < 0) {
      this.status.textContent = "Find a window first.";
      return;
    }
    const i = Math.floor(this.sel / g.nTof), j = this.sel % g.nTof;
    const target = Number(this.targetSel.value);
    const peri = Number(this.periInput.value) * 1000;
    this.status.textContent = "Correcting on the n-body propagator…";
    setTimeout(() => {
      const t = performance.now();
      const res = JSON.parse(this.sim.sim.transferPlan(target, g.dep[i]!, g.tof[j]!, peri)) as { ok: boolean; error?: string; nodes?: { dv: number }[]; miss?: number };
      if (res.ok) {
        this.sim.setTarget(target);
        this.sim.guidance = { target, periapsisAltM: peri };
        const dvs = res.nodes!.map((n) => `${n.dv.toFixed(1)}`).join(" + ");
        this.status.textContent = `Planned in ${((performance.now() - t) / 1000).toFixed(1)} s: departure + midcourse = ${dvs} m/s; periapsis within ${(Math.abs(res.miss!) / 1000).toFixed(1)} km. Execute them from the plan panel (Execute all flies both and corrects the course after each burn).`;
      } else this.status.textContent = `Could not plan: ${res.error}`;
    }, 20);
  }
}
