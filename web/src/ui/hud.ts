// In-flight HUD (M4 scope): clocks, time warp, orbit readout, focus, debug overlay.
// The full spacecraft HUD (navball, propellant, flight modes) arrives in M5.

import type { Simulation } from "../sim/simulation";
import { WARP_LEVELS } from "../sim/simulation";
import { fmtDuration, fmtLength, fmtWarp, h } from "./dom";

export class Hud {
  readonly root = h("div", { class: "hud hidden", id: "hud" });
  private els: Record<string, HTMLElement> = {};
  private fpsAcc = { frames: 0, time: 0, fps: 0, ms: 0 };
  debug = false;

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
    );
  }

  show(on: boolean): void {
    this.root.classList.toggle("hidden", !on);
  }

  setScale(s: number): void {
    this.root.style.setProperty("--hud-scale", String(s));
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
