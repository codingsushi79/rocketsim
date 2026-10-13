// Replay player (M10): scrub and play back the flight recorder. The simulation is
// paused; the core's replay view answers the renderer's queries at the replay epoch.

import type { FlightRecorder } from "../sim/recorder";
import type { Simulation } from "../sim/simulation";
import { h } from "./dom";

const SPEEDS = [1, 10, 100, 1000, 10000];

export class ReplayPlayer {
  readonly root = h("div", { class: "replay-bar hidden" });
  active = false;
  private t = 0;
  private playing = true;
  private speed = 1;
  private scrub = h("input", { type: "range", min: "0", max: "1000", value: "0", class: "replay-scrub" }) as HTMLInputElement;
  private time = h("span", { class: "mono replay-time" });
  private playBtn = h("button", {}, "Pause");
  private speedBtn = h("button", {}, "1×");
  private wasPaused = false;
  onExit: (() => void) | null = null;

  constructor(
    private sim: Simulation,
    private rec: FlightRecorder,
  ) {
    this.playBtn.onclick = () => {
      this.playing = !this.playing;
      this.playBtn.textContent = this.playing ? "Pause" : "Play";
    };
    this.speedBtn.onclick = () => {
      this.speed = SPEEDS[(SPEEDS.indexOf(this.speed) + 1) % SPEEDS.length]!;
      this.speedBtn.textContent = `${this.speed}×`;
    };
    this.scrub.addEventListener("input", () => {
      this.t = this.rec.start + (Number(this.scrub.value) / 1000) * (this.rec.end - this.rec.start);
    });
    this.root.append(
      h("span", { class: "lbl" }, "Replay"),
      this.playBtn,
      this.speedBtn,
      this.scrub,
      this.time,
      h("button", { onclick: () => this.exit() }, "Exit replay"),
    );
  }

  start(): boolean {
    if (this.rec.count < 2) return false;
    this.active = true;
    this.wasPaused = this.sim.paused;
    this.sim.paused = true;
    this.t = this.rec.start;
    this.playing = true;
    this.playBtn.textContent = "Pause";
    this.root.classList.remove("hidden");
    return true;
  }

  exit(): void {
    this.active = false;
    this.sim.sim.clearReplayView();
    this.sim.paused = this.wasPaused;
    this.root.classList.add("hidden");
    this.onExit?.();
  }

  update(dt: number): void {
    if (!this.active) return;
    if (this.playing) this.t = Math.min(this.rec.end, this.t + dt * this.speed);
    const s = this.rec.at(this.t);
    if (!s) return;
    this.sim.sim.setReplayView(s[0]!, s[1]!, s[2]!, s[3]!, s[4]!, s[5]!, s[6]!, s[7]!, s[8]!, s[9]!, s[10]!, s[11]!);
    const f = (this.t - this.rec.start) / Math.max(1e-9, this.rec.end - this.rec.start);
    if (document.activeElement !== this.scrub) this.scrub.value = String(Math.round(f * 1000));
    const el = this.t - this.rec.start;
    const hh = Math.floor(el / 3600), mm = Math.floor((el % 3600) / 60), ss = Math.floor(el % 60);
    this.time.textContent = `T+${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
  }
}
