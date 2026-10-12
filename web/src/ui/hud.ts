// In-flight HUD: clocks, time warp, orbit readout, focus, debug overlay, and for a
// flown vehicle the navball, speed modes, SAS, engine, Δv, propellant and wheels.

import type { CabinData } from "../render/interior";
import type { Simulation } from "../sim/simulation";
import { PHYSICS_WARP_MAX, SAS_MODES, SPEED_REFS, WARP_LEVELS } from "../sim/simulation";
import type { VehicleDef } from "../sim/vehicle";
import { clear, fmtDuration, fmtLength, fmtWarp, h } from "./dom";
import { Navball } from "./navball";

/** Bodies the target cycle (Y) steps through; −1 = none. */
export const TARGET_CYCLE = [-1, 301, 399, 10, 499];

export class Hud {
  readonly root = h("div", { class: "hud hidden", id: "hud" });
  private els: Record<string, HTMLElement> = {};
  private fpsAcc = { frames: 0, time: 0, fps: 0, ms: 0 };
  debug = false;
  private flight = h("div", { class: "hud-flight hidden" });
  private navball = new Navball();
  private def: VehicleDef | null = null;
  private bodyNames = new Map<number, string>();
  /** Staging progress 0–1 while the key is held. */
  stageProgress = 0;

  constructor(private sim: Simulation, onWarp: (dir: 1 | -1) => void, onPause: () => void) {
    const el = (id: string, cls = "") => (this.els[id] = h("span", { class: cls, id: `hud-${id}` }));
    this.root.append(
      h(
        "div",
        { class: "hud-top" },
        h("div", { class: "clock" }, h("div", {}, h("span", { class: "lbl" }, "UTC "), el("utc", "mono")), h("div", { class: "small" }, h("span", { class: "lbl" }, "TDB "), el("tdb", "mono"))),
        h(
          "div",
          { class: "warp" },
          h("button", { title: "Warp down (,)", onclick: () => onWarp(-1) }, "◀"),
          el("warp", "mono warp-value"),
          h("button", { title: "Warp up (.)", onclick: () => onWarp(1) }, "▶"),
          h("button", { title: "Pause (P)", onclick: () => onPause() }, "❚❚"),
          h("div", { class: "warp-pips" }, ...WARP_LEVELS.map((_, i) => h("span", { class: "pip", "data-i": i }))),
          el("warpnote", "warp-note"),
        ),
        h("div", { class: "focus" }, h("span", { class: "lbl" }, "Focus "), el("focus"), h("span", { class: "hint" }, "  [ ]")),
      ),
      h(
        "div",
        { class: "hud-orbit" },
        h("div", { class: "panel-title" }, "ORBIT ", el("center")),
        ...(
          [
            ["alt", "Altitude"],
            ["geo", "Height (WGS84)"],
            ["spd", "Speed"],
            ["ap", "Apoapsis"],
            ["pe", "Periapsis"],
            ["inc", "Inclination"],
            ["ecc", "Eccentricity"],
            ["per", "Period"],
          ] as const
        ).map(([id, label]) => h("div", { class: "row" }, h("span", { class: "lbl" }, label), el(id, "mono"))),
      ),
      el("status", "hud-status"),
      el("debug", "hud-debug hidden mono"),
      this.flight,
      this.outcomeEl,
    );
  }

  private outcomeEl = h("div", { class: "outcome hidden", id: "outcome" });
  private outcomeShown = "";
  /** Called by the outcome overlay's buttons. */
  onRestart: () => void = () => {};
  onMainMenu: () => void = () => {};

  /** Crash/landing overlay. */
  private updateOutcome(): void {
    const o = this.sim.hasVehicle ? this.sim.sim.outcome() : "flying";
    if (o === this.outcomeShown) return;
    this.outcomeShown = o;
    clear(this.outcomeEl);
    this.outcomeEl.classList.toggle("hidden", o === "flying");
    if (o === "flying") return;
    const bad = o !== "landed";
    const titles: Record<string, string> = { landed: "Touchdown", crashed: "Vehicle destroyed", brokeup: "Vehicle broke up", burnedup: "Vehicle burned up" };
    const title = titles[o] ?? o;
    this.outcomeEl.classList.toggle("bad", bad);
    this.outcomeEl.append(
      h("div", { class: "outcome-title" }, title),
      h("div", { class: "outcome-detail" }, this.sim.sim.status()),
      h("div", { class: "menu-footer" }, h("button", { class: "primary", id: "btn-restart", onclick: () => this.onRestart() }, "Restart mission"), h("button", { onclick: () => this.onMainMenu() }, "Main menu")),
    );
  }

  /** In map view the navball and vehicle panels give way to the map panels. */
  setMap(on: boolean): void {
    this.root.classList.toggle("map-mode", on);
  }

  setBodyNames(names: Map<number, string>): void {
    this.bodyNames = names;
  }

  /** Build the vehicle panels for `def` (or hide them). */
  setVehicle(def: VehicleDef | null): void {
    this.def = def;
    clear(this.flight);
    this.flight.classList.toggle("hidden", !def);
    if (!def) return;
    const el = (id: string, cls = "") => (this.els[id] = h("span", { class: cls, id: `hud-${id}` }));
    const sasButtons = SAS_MODES.map((name, i) =>
      h("button", { class: "sas-btn", "data-i": i, title: `${name} (${i === 0 ? "T" : i === 10 ? "0" : i})`, onclick: () => (this.sim.controls.sas = i) }, name),
    );
    const tanks = def.tanks.map((t, i) =>
      h(
        "div",
        { class: "gauge", "data-stage": t.stage },
        h("span", { class: "gauge-label" }, `${t.id.replace(/_/g, " ").toUpperCase()}`),
        h("span", { class: "gauge-bar" }, h("span", { class: `gauge-fill prop-${t.propellant.toLowerCase()}`, id: `hud-tank-${i}` })),
        h("span", { class: "gauge-value mono", id: `hud-tankv-${i}` }),
      ),
    );
    this.flight.append(
      h("div", { class: "hud-sas" }, ...sasButtons, h("span", { class: "sas-flags" }, el("rcsflag", "flag"), el("fineflag", "flag"), el("sasflag", "flag"))),
      h(
        "div",
        { class: "hud-navball" },
        h("div", { class: "speed" }, h("button", { class: "speed-mode", onclick: () => (this.sim.controls.speedRef = (this.sim.controls.speedRef + 1) % 3) }, el("speedmode")), el("speed", "mono speed-value")),
        this.navball.canvas,
        h("div", { class: "nav-readout mono" }, el("navread")),
        h("div", { class: "target-line" }, h("span", { class: "lbl" }, "Target "), el("target"), h("span", { class: "hint" }, "  Y")),
      ),
      h(
        "div",
        { class: "hud-prop" },
        h("div", { class: "panel-title" }, def.name.toUpperCase()),
        h("div", { class: "row" }, h("span", { class: "lbl" }, "Throttle"), h("span", { class: "gauge-bar wide" }, h("span", { class: "gauge-fill throttle", id: "hud-throttle" })), el("throttlev", "mono")),
        h("div", { class: "row" }, h("span", { class: "lbl" }, "Engine"), el("engine", "mono")),
        h("div", { class: "row" }, h("span", { class: "lbl" }, "Δv left"), el("dv", "mono")),
        h("div", { class: "row" }, h("span", { class: "lbl" }, "Burn time"), el("burn", "mono")),
        h("div", { class: "row" }, h("span", { class: "lbl" }, "Mass"), el("mass", "mono")),
        h("div", { class: "row" }, h("span", { class: "lbl" }, "Rates"), el("rates", "mono")),
        h("div", { class: "row" }, h("span", { class: "lbl" }, "Wheels"), el("wheels", "mono")),
        h("div", { class: "panel-title sub" }, "PROPELLANT"),
        ...tanks,
        h("div", { class: "row" }, h("span", { class: "lbl" }, "Stage"), el("stage", "mono")),
      ),
      el("warn", "hud-warn"),
    );
  }

  /** Burn direction of the next node (or the autopilot's), for the navball marker. */
  private maneuverVector(): [number, number, number] | null {
    const { plan } = this.sim.planState();
    const d = plan?.nodes[0]?.direction;
    return d ?? null;
  }

  private updateFlight(): void {
    const def = this.def;
    const t = this.sim.telemetry();
    if (!def || !t) return;
    const s = this.sim.sim;
    const c = this.sim.controls;
    const E = this.els;
    this.flight.querySelectorAll<HTMLElement>(".sas-btn").forEach((b) => b.classList.toggle("on", Number(b.dataset.i) === c.sas));
    E.rcsflag!.textContent = c.rcs ? "RCS" : "rcs off";
    E.rcsflag!.classList.toggle("on", c.rcs);
    E.fineflag!.textContent = c.fine ? "FINE" : "";
    E.fineflag!.classList.toggle("on", c.fine);
    E.sasflag!.textContent = t.desat ? "DESAT" : "";
    E.sasflag!.classList.toggle("on", t.desat);

    // Speed in the selected reference.
    E.speedmode!.textContent = SPEED_REFS[c.speedRef]!.toUpperCase();
    const v = t.speeds[c.speedRef] ?? NaN;
    E.speed!.textContent = Number.isFinite(v) ? (v >= 1000 ? `${(v / 1000).toFixed(3)} km/s` : `${v.toFixed(1)} m/s`) : "—";

    // Navball.
    const q = s.attitude();
    const sc = s.spacecraft();
    const nav = s.navVectors();
    if (q.length === 4 && sc.length >= 8 && nav.length === 12) {
      const r: [number, number, number] = [sc[1]!, sc[2]!, sc[3]!];
      const rn = Math.hypot(...r);
      const up: [number, number, number] = [r[0] / rn, r[1] / rn, r[2] / rn];
      const f = s.bodyFrame(sc[0]!);
      const pole: [number, number, number] = f.length === 9 ? [f[6]!, f[7]!, f[8]!] : [0, 0, 1];
      const v3 = (i: number): [number, number, number] => [nav[i]!, nav[i + 1]!, nav[i + 2]!];
      const tgt = v3(9);
      this.navball.draw(Array.from(q), up, pole, {
        prograde: v3(0),
        normal: v3(3),
        radial: v3(6),
        target: tgt[0] === 0 && tgt[1] === 0 && tgt[2] === 0 ? null : tgt,
        maneuver: this.maneuverVector(),
      });
      const nb = this.navball;
      E.navread!.textContent = `HDG ${nb.heading.toFixed(1).padStart(5)}°  PIT ${nb.pitch.toFixed(1).padStart(5)}°  ROL ${nb.roll.toFixed(1).padStart(6)}°`;
    }

    // Propulsion.
    const e = t.engines[0];
    (document.getElementById("hud-throttle") as HTMLElement).style.width = `${(c.throttle * 100).toFixed(1)}%`;
    E.throttlev!.textContent = `${Math.round(c.throttle * 100)}%`;
    if (e) {
      const state = e.running ? `${(e.thrust / 1000).toFixed(1)} kN` : e.flameout ? "FLAMEOUT" : e.ignitions === 0 ? "NO IGNITIONS" : "off";
      const gim = Math.acos(Math.max(-1, Math.min(1, e.direction[0]))) * 57.29578;
      E.engine!.textContent = `${state} · gimbal ${gim.toFixed(1)}° · ${e.ignitions} ign`;
    } else {
      E.engine!.textContent = "none";
    }
    E.dv!.textContent = `${t.dv.toFixed(0)} m/s`;
    E.burn!.textContent = t.burnTime > 0 ? fmtDuration(t.burnTime) : "—";
    E.mass!.textContent = `${(t.mass / 1000).toFixed(3)} t`;
    const w = t.omega.map((x) => x * 57.29578);
    E.rates!.textContent = `${w[0]!.toFixed(2)} ${w[1]!.toFixed(2)} ${w[2]!.toFixed(2)} °/s`;
    E.wheels!.textContent = t.wheels.map((x) => `${Math.round(x * 100)}%`).join(" ");
    const attached = s.attachedStages();
    def.tanks.forEach((tk, i) => {
      const m = t.tanks[i] ?? 0;
      const si = def.stages.findIndex((st) => st.id === tk.stage);
      const gone = (attached[si] ?? 1) === 0;
      const fill = document.getElementById(`hud-tank-${i}`);
      if (fill) fill.style.width = `${gone ? 0 : (100 * m) / tk.capacity}%`;
      const val = document.getElementById(`hud-tankv-${i}`);
      if (val) val.textContent = gone ? "jettisoned" : `${m.toFixed(m < 100 ? 1 : 0)} kg`;
    });
    const next = def.stages.findIndex((_, i) => (attached[i] ?? 1) !== 0);
    const remaining = def.stages.filter((_, i) => (attached[i] ?? 1) !== 0).length;
    E.stage!.textContent =
      remaining > 1 ? `${this.stageProgress > 0 ? `${"■".repeat(Math.round(this.stageProgress * 8)).padEnd(8, "□")} ` : ""}Space: separate ${def.stages[next]!.name}` : "final stage";

    // Target and warnings.
    const tgt = this.sim.targetId;
    E.target!.textContent = tgt < 0 ? "none" : (this.bodyNames.get(tgt) ?? String(tgt));
    const warns: string[] = [];
    const n = this.sim.notice;
    if (n && performance.now() < n.until) warns.push(n.text);
    if (this.sim.warpCapped) warns.push(`Warp limited to ${PHYSICS_WARP_MAX}× (vehicle under control or in the atmosphere)`);
    if (t.q > 500) warns.push(`Dynamic pressure ${(t.q / 1000).toFixed(1)} kPa`);
    if (t.heat > 5000) warns.push(`Heat flux ${(t.heat / 1000).toFixed(0)} kW/m²`);
    if (e?.flameout) warns.push("Engine flameout");
    const { plan, ap } = this.sim.planState();
    const nextNode = plan?.nodes[0];
    if (ap && ap.phase === "aligning") warns.push(`Autopilot: ignition T−${fmtDuration(Math.max(0, ap.toStart))} · ${ap.dv.toFixed(1)} m/s`);
    else if (ap && ap.phase === "burning") warns.push(`Autopilot burning ${ap.delivered.toFixed(1)} / ${ap.dv.toFixed(1)} m/s`);
    else if (nextNode && nextNode.start !== null) warns.push(`Next node: burn T−${fmtDuration(Math.max(0, nextNode.start))} · ${nextNode.dv.toFixed(1)} m/s · ${nextNode.duration !== null && Number.isFinite(nextNode.duration) ? nextNode.duration.toFixed(0) : "—"} s`);
    E.warn!.textContent = warns.join(" · ");
  }


  show(on: boolean): void {
    this.root.classList.toggle("hidden", !on);
  }

  setScale(s: number): void {
    this.root.style.setProperty("--hud-scale", String(s));
  }

  /** Values for the cockpit displays (the same sources as the HUD). */
  cabinData(): CabinData | null {
    const s = this.sim.sim;
    const o = s.orbitInfo();
    const t = this.sim.telemetry();
    if (o.length < 11 || !t) return null;
    const def = this.sim.scenario?.vehicle?.def;
    const prop = (def?.tanks ?? []).map((k, i) => ({ label: k.id.toUpperCase().replace(/_/g, " ").slice(0, 8), frac: (t.tanks[i] ?? 0) / Math.max(k.capacity, 1e-9) }));
    return {
      pitch: this.navball.pitch,
      roll: this.navball.roll,
      heading: this.navball.heading,
      altitude: o[9]!,
      speed: o[10]!,
      apoapsis: o[7]!,
      periapsis: o[6]!,
      inclination: (o[2]! * 180) / Math.PI,
      dv: t.dv,
      mass: t.mass,
      heat: t.heat,
      q: t.q,
      prop,
      met: s.utcIso().slice(11, 19) + " UTC",
    };
  }

  update(dt: number, focusName: string, centerName: string, extra: { showFps: boolean; exposure?: string; depth: string }): void {
    const s = this.sim.sim;
    this.els.utc!.textContent = s.utcIso().replace("T", " ").replace("Z", "") + (s.isProvisional() ? " *" : "");
    this.els.tdb!.textContent = `${s.epochTdb().toFixed(1)} s`;
    this.els.warp!.textContent = this.sim.paused ? "PAUSED" : fmtWarp(this.sim.warp);
    this.els.warpnote!.textContent = this.sim.warpLimited ? "warp limited by CPU" : "";
    this.root.querySelectorAll<HTMLElement>(".pip").forEach((p) => p.classList.toggle("on", Number(p.dataset.i) <= this.sim.warpIndex));
    this.els.focus!.textContent = focusName;
    this.els.center!.textContent = centerName.toUpperCase();
    const o = s.orbitInfo();
    if (o.length >= 11) {
      // Altitude, apoapsis and periapsis share one reference: the body's mean
      // equatorial radius. Height is above the WGS84 ellipsoid (Earth only).
      const geo = s.geodeticAltitude();
      this.els.alt!.textContent = fmtLength(o[9]!);
      this.els.geo!.textContent = Number.isFinite(geo) ? fmtLength(geo) : "—";
      this.els.spd!.textContent = `${(o[10]! / 1000).toFixed(4)} km/s`;
      this.els.ap!.textContent = fmtLength(o[7]!);
      this.els.pe!.textContent = fmtLength(o[6]!);
      this.els.inc!.textContent = `${((o[2]! * 180) / Math.PI).toFixed(3)}°`;
      this.els.ecc!.textContent = o[1]!.toFixed(6);
      this.els.per!.textContent = fmtDuration(o[8]!);
    }
    this.updateFlight();
    this.updateOutcome();
    const status = s.status();
    this.els.status!.textContent = status ? `⚠ ${status}` : "";

    // FPS / debug.
    const a = this.fpsAcc;
    a.frames++;
    a.time += dt;
    if (a.time >= 0.5) {
      a.fps = a.frames / a.time;
      a.ms = (a.time / a.frames) * 1000;
      a.frames = 0;
      a.time = 0;
    }
    const dbg = this.els.debug!;
    dbg.classList.toggle("hidden", !(this.debug || extra.showFps));
    dbg.textContent = this.debug
      ? `${a.fps.toFixed(0)} fps · ${a.ms.toFixed(2)} ms/frame\nintegrator steps kept: ${s.stepCount()}\ndepth: ${extra.depth}`
      : `${a.fps.toFixed(0)} fps`;
  }
}
