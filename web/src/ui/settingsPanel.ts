// Settings screen: Graphics, Simulation, Controls, Audio, Interface.

import { GRAPHICS_PRESETS, type Preset, type SettingsStore } from "../settings";
import { clear, h } from "./dom";

type Tab = "graphics" | "simulation" | "controls" | "audio" | "interface";

export const KEYBINDINGS: [string, string][] = [
  [", / .", "Time warp down / up"],
  ["/", "Reset warp to 1×"],
  ["P", "Pause / resume time"],
  ["[ / ]", "Previous / next camera focus"],
  ["Mouse drag", "Orbit camera"],
  ["Wheel", "Zoom (1 m to interplanetary)"],
  ["O", "Toggle predicted orbit"],
  ["F3", "Debug overlay (FPS, integrator)"],
  ["Esc", "Pause menu"],
  ["W / S", "Pitch down / up"],
  ["A / D", "Yaw left / right"],
  ["Q / E", "Roll left / right"],
  ["H / N", "Translate forward / back (RCS)"],
  ["J / L", "Translate left / right"],
  ["I / K", "Translate up / down"],
  ["Shift / Ctrl", "Throttle up / down"],
  ["Z / X", "Full throttle / cut (throttle > 0 ignites)"],
  ["Space (hold)", "Stage: separate the service module"],
  ["T", "SAS on / off"],
  ["1 … 0", "SAS: hold, prograde, retrograde, normal, anti-normal, radial out, radial in, target, anti-target, maneuver"],
  ["R", "RCS on / off"],
  ["Caps Lock", "Fine control (25 %)"],
  ["V", "Speed reference: orbit / surface / target"],
  ["Y", "Cycle target body"],
];

export class SettingsPanel {
  readonly root = h("div", { class: "menu-panel settings", id: "settings" });
  private tab: Tab = "graphics";

  constructor(private store: SettingsStore, private onClose: () => void, private capabilities: () => string) {}

  render(): HTMLElement {
    this.draw();
    return this.root;
  }

  private draw(): void {
    clear(this.root);
    const tabs: Tab[] = ["graphics", "simulation", "controls", "audio", "interface"];
    this.root.append(
      h("h2", {}, "Settings"),
      h(
        "div",
        { class: "tabs" },
        ...tabs.map((t) => h("button", { class: t === this.tab ? "tab active" : "tab", onclick: () => ((this.tab = t), this.draw()) }, t[0]!.toUpperCase() + t.slice(1))),
      ),
      h("div", { class: "tab-body" }, this.body()),
      h(
        "div",
        { class: "menu-footer" },
        h("button", { onclick: () => (this.store.reset(), this.draw()) }, "Reset to defaults"),
        h("button", { class: "primary", id: "btn-settings-back", onclick: () => this.onClose() }, "Back"),
      ),
    );
  }

  private row(label: string, control: HTMLElement, hint?: string): HTMLElement {
    return h("label", { class: "setting" }, h("span", { class: "setting-label" }, label), control, hint ? h("span", { class: "setting-hint" }, hint) : null);
  }

  private select<T extends string | number>(value: T, options: [T, string][], set: (v: T) => void): HTMLSelectElement {
    const el = h("select", {}, ...options.map(([v, l]) => h("option", { value: String(v), selected: v === value }, l)));
    el.addEventListener("change", () => {
      const raw = el.value;
      const opt = options.find(([v]) => String(v) === raw);
      if (opt) set(opt[0]);
      this.draw();
    });
    return el;
  }

  private toggle(value: boolean, set: (v: boolean) => void): HTMLInputElement {
    const el = h("input", { type: "checkbox", checked: value });
    el.addEventListener("change", () => (set(el.checked), this.draw()));
    return el;
  }

  private slider(value: number, min: number, max: number, step: number, set: (v: number) => void, fmt = (v: number) => v.toFixed(2)): HTMLElement {
    const out = h("span", { class: "slider-value" }, fmt(value));
    const el = h("input", { type: "range", min, max, step, value });
    el.addEventListener("input", () => (out.textContent = fmt(Number(el.value))));
    el.addEventListener("change", () => set(Number(el.value)));
    return h("span", { class: "slider" }, el, out);
  }

  private body(): HTMLElement {
    const s = this.store.get();
    const up = (f: (s: ReturnType<SettingsStore["get"]>) => void, custom = false) =>
      this.store.update((x) => {
        f(x);
        if (custom) x.graphics.preset = "custom";
      });
    switch (this.tab) {
      case "graphics": {
        const g = s.graphics;
        return h(
          "div",
          {},
          this.row(
            "Quality preset",
            this.select<Preset>(g.preset, [["low", "Low"], ["medium", "Medium"], ["high", "High"], ["max", "Max (RTX 4070-class)"], ["custom", "Custom"]], (p) => {
              if (p !== "custom") this.store.applyPreset(p as Exclude<Preset, "custom">);
            }),
          ),
          this.row("Resolution scale", this.slider(g.renderScale, 0.5, 1.5, 0.05, (v) => up((x) => (x.graphics.renderScale = v), true), (v) => `${Math.round(v * 100)}%`)),
          this.row("Anti-aliasing (MSAA)", this.select(g.msaa, [[0, "Off"], [2, "2×"], [4, "4×"], [8, "8×"]], (v) => up((x) => (x.graphics.msaa = v as 0 | 2 | 4 | 8), true))),
          this.row("Bloom", this.toggle(g.bloom, (v) => up((x) => (x.graphics.bloom = v), true))),
          this.row("Atmosphere quality", this.select(g.atmosphereSteps, [[8, "Low (8)"], [16, "Medium (16)"], [32, "High (32)"], [64, "Max (64)"]], (v) => up((x) => (x.graphics.atmosphereSteps = v), true)), "Ray-march samples per pixel"),
          this.row("Star catalog limit", this.select(g.starLimitMag, [[6, "V ≤ 6 (≈5k stars)"], [7, "V ≤ 7 (≈15k)"], [8, "V ≤ 8 (≈41k)"]], (v) => up((x) => (x.graphics.starLimitMag = v), true))),
          this.row("Texture quality", this.select(g.textureQuality, [["standard", "Standard (2k)"], ["high", "High (5–8k)"]], (v) => up((x) => (x.graphics.textureQuality = v), true)), "Applies on next mission start"),
          this.row("Depth buffer", this.select(g.depthMode, [["auto", "Auto"], ["reversed", "Reversed-Z float"], ["log", "Logarithmic"]], (v) => up((x) => (x.graphics.depthMode = v))), `Active: ${this.capabilities()} · applies after reload`),
          this.row("Planet mesh detail", this.select(g.bodySegments, [[64, "Low"], [128, "Medium"], [192, "High"], [256, "Max"]], (v) => up((x) => (x.graphics.bodySegments = v), true)), "Applies on next mission start"),
          h("p", { class: "note" }, "Preset values: " + Object.entries(GRAPHICS_PRESETS).map(([k, v]) => `${k} ${Math.round(v.renderScale * 100)}%/${v.msaa}×MSAA/${v.atmosphereSteps} steps`).join(" · ")),
        );
      }
      case "simulation": {
        const m = s.sim;
        return h(
          "div",
          {},
          this.row("Integrator tolerance", this.select(m.rtol, [[1e-10, "1e-10 (fast)"], [1e-11, "1e-11"], [1e-12, "1e-12 (default)"], [1e-13, "1e-13 (precise)"]], (v) => up((x) => (x.sim.rtol = v))), "DOP853 relative tolerance"),
          this.row("Earth gravity field", this.select(m.earthDegree, [[2, "2×2 (J2)"], [8, "8×8"], [20, "20×20"], [70, "70×70 (EGM2008)"]], (v) => up((x) => (x.sim.earthDegree = v)))),
          this.row("Third-body gravity", this.toggle(m.thirdBody, (v) => up((x) => (x.sim.thirdBody = v)))),
          this.row("Gravity harmonics", this.toggle(m.harmonics, (v) => up((x) => (x.sim.harmonics = v)))),
          this.row("Atmospheric drag", this.toggle(m.drag, (v) => up((x) => (x.sim.drag = v))), "US76 + NRLMSISE-00"),
          this.row("Solar radiation pressure", this.toggle(m.srp, (v) => up((x) => (x.sim.srp = v)))),
          this.row("Solar flux F10.7", this.slider(m.f107, 65, 300, 1, (v) => up((x) => ((x.sim.f107 = v), (x.sim.f107a = v))), (v) => `${v.toFixed(0)} sfu`)),
          this.row("Geomagnetic Ap", this.slider(m.ap, 0, 400, 1, (v) => up((x) => (x.sim.ap = v)), (v) => v.toFixed(0))),
        );
      }
      case "controls": {
        const c = s.controls;
        const pads = (navigator.getGamepads ? Array.from(navigator.getGamepads()) : []).filter((p): p is Gamepad => !!p);
        const axisOpts: [number, string][] = [[-1, "—"], ...Array.from({ length: 8 }, (_, i): [number, string] => [i, `Axis ${i}`])];
        return h(
          "div",
          {},
          this.row("Stick deadzone", this.slider(c.deadzone, 0, 0.3, 0.01, (v) => up((x) => (x.controls.deadzone = v)), (v) => `${Math.round(v * 100)}%`)),
          this.row("Invert pitch", this.toggle(c.invertPitch, (v) => up((x) => (x.controls.invertPitch = v)))),
          h("p", { class: "note" }, pads.length ? `Detected: ${pads.map((p) => `#${p.index} ${p.id} (${p.mapping || "generic"})`).join(" · ")}` : "No gamepad detected: press a button on it, then reopen this tab. Standard gamepads work without setup: left stick pitch/yaw, bumpers roll, right stick and d-pad translate, triggers throttle, A stage (hold), B SAS, X RCS, Y speed reference."),
          this.row("HOTAS / joystick", this.toggle(c.hotas.enabled, (v) => (up((x) => (x.controls.hotas.enabled = v)), this.draw())), "Map a non-standard device's axes"),
          ...(c.hotas.enabled
            ? [
                this.row("Device", this.select(c.hotas.padIndex, pads.length ? pads.map((p): [number, string] => [p.index, `#${p.index} ${p.id.slice(0, 40)}`]) : [[c.hotas.padIndex, `#${c.hotas.padIndex}`]], (v) => up((x) => (x.controls.hotas.padIndex = v)))),
                this.row("Roll axis", this.select(c.hotas.roll, axisOpts, (v) => up((x) => (x.controls.hotas.roll = v)))),
                this.row("Pitch axis", this.select(c.hotas.pitch, axisOpts, (v) => up((x) => (x.controls.hotas.pitch = v)))),
                this.row("Yaw axis", this.select(c.hotas.yaw, axisOpts, (v) => up((x) => (x.controls.hotas.yaw = v)))),
                this.row("Throttle axis", this.select(c.hotas.throttle, axisOpts, (v) => up((x) => (x.controls.hotas.throttle = v)))),
                this.row("Invert throttle", this.toggle(c.hotas.invertThrottle, (v) => up((x) => (x.controls.hotas.invertThrottle = v)))),
              ]
            : []),
          h("table", { class: "keys" }, ...KEYBINDINGS.map(([k, d]) => h("tr", {}, h("td", { class: "key" }, k), h("td", {}, d)))),
        );
      }
      case "audio":
        return h(
          "div",
          {},
          this.row("Master volume", this.slider(s.audio.master, 0, 1, 0.01, (v) => up((x) => (x.audio.master = v)), (v) => `${Math.round(v * 100)}%`)),
          this.row("Music", this.slider(s.audio.music, 0, 1, 0.01, (v) => up((x) => (x.audio.music = v)), (v) => `${Math.round(v * 100)}%`)),
          this.row("Effects", this.slider(s.audio.effects, 0, 1, 0.01, (v) => up((x) => (x.audio.effects = v)), (v) => `${Math.round(v * 100)}%`)),
          h("p", { class: "note" }, "Audio arrives in M10; volumes are stored now."),
        );
      case "interface":
        return h(
          "div",
          {},
          this.row("HUD scale", this.slider(s.ui.hudScale, 0.75, 1.5, 0.05, (v) => up((x) => (x.ui.hudScale = v)), (v) => `${Math.round(v * 100)}%`)),
          this.row("Show FPS", this.toggle(s.ui.showFps, (v) => up((x) => (x.ui.showFps = v)))),
          this.row("Show predicted orbit", this.toggle(s.ui.showOrbit, (v) => up((x) => (x.ui.showOrbit = v)))),
          this.row(
            "Star visibility",
            this.select(s.ui.starBoost, [[1, "Physical"], [1000, "Enhanced (×1,000)"], [100000, "Planetarium (×100,000)"]], (v) => up((x) => (x.ui.starBoost = v))),
            "Physical: stars vanish in sunlit views, as for a real camera",
          ),
        );
    }
  }
}
