// Flight input: keyboard, gamepad (standard mapping) and HOTAS (generic axes,
// mapped in Settings → Controls). Produces the per-frame FlightControls the core
// samples on its 50 Hz control ticks.
//
// Keyboard (KSP-like):
//   W/S pitch, A/D yaw, Q/E roll        H/N fore/aft, J/L left/right, I/K up/down
//   Shift/Ctrl throttle up/down, Z full, X cut
//   T SAS on/off, 1–0 SAS modes, R RCS, Caps Lock fine control, V speed reference
//   Space stage (hold 0.4 s), Y cycle target

import type { ControlSettings } from "../settings";
import type { FlightControls } from "../sim/simulation";

/** Throttle change per second while Shift/Ctrl (or a trigger) is held. */
const THROTTLE_RATE = 0.5;
/** Staging needs the key held this long (avoids accidental separation). */
const STAGE_HOLD_S = 0.4;
/** Keyboard stick rises to full deflection over this time (smoother than on/off). */
const KEY_RAMP_S = 0.15;

const SAS_KEYS: Record<string, number> = { Digit1: 1, Digit2: 2, Digit3: 3, Digit4: 4, Digit5: 5, Digit6: 6, Digit7: 7, Digit8: 8, Digit9: 9, Digit0: 10 };

export interface InputEvents {
  stage(): void;
  cycleTarget(): void;
}

export class FlightInput {
  private keys = new Set<string>();
  private ramp = { roll: 0, pitch: 0, yaw: 0 };
  private stageHeld = 0;
  private stageFired = false;
  private lastSas = 1;
  private padButtons: boolean[] = [];
  enabled = false;

  constructor(
    private controls: () => FlightControls,
    private settings: () => ControlSettings,
    private events: InputEvents,
  ) {
    window.addEventListener("keydown", (e) => this.onKey(e, true));
    window.addEventListener("keyup", (e) => this.onKey(e, false));
    window.addEventListener("blur", () => this.keys.clear());
  }

  private onKey(e: KeyboardEvent, down: boolean): void {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
    if (down) this.keys.add(e.code);
    else this.keys.delete(e.code);
    if (!this.enabled || !down || e.repeat) return;
    const c = this.controls();
    if (e.code in SAS_KEYS) {
      c.sas = SAS_KEYS[e.code]!;
      this.lastSas = c.sas;
    }
    switch (e.code) {
      case "KeyT":
        if (c.sas === 0) c.sas = this.lastSas || 1;
        else (this.lastSas = c.sas), (c.sas = 0);
        break;
      case "KeyR": c.rcs = !c.rcs; break;
      case "CapsLock": c.fine = !c.fine; break;
      case "KeyV": c.speedRef = (c.speedRef + 1) % 3; break;
      case "KeyZ": c.throttle = 1; break;
      case "KeyX": c.throttle = 0; break;
      case "KeyY": this.events.cycleTarget(); break;
      default: return;
    }
    e.preventDefault();
  }

  /** Update the controls for this frame (wall-clock dt). */
  update(dt: number): void {
    if (!this.enabled) return;
    const c = this.controls();
    const k = (code: string) => (this.keys.has(code) ? 1 : 0);
    const s = this.settings();
    const target = {
      pitch: k("KeyS") - k("KeyW"), // S pulls the nose up (+pitch about body Y)
      yaw: k("KeyD") - k("KeyA"),
      roll: k("KeyE") - k("KeyQ"),
    };
    for (const a of ["roll", "pitch", "yaw"] as const) {
      const t = target[a];
      const r = this.ramp[a];
      const step = dt / KEY_RAMP_S;
      this.ramp[a] = t === 0 ? 0 : Math.max(-1, Math.min(1, r + Math.sign(t - r) * Math.min(step, Math.abs(t - r))));
    }
    let roll = this.ramp.roll, pitch = this.ramp.pitch, yaw = this.ramp.yaw;
    let tx = k("KeyH") - k("KeyN");
    let ty = k("KeyL") - k("KeyJ");
    let tz = k("KeyK") - k("KeyI"); // body +Z is "down"
    let dThrottle = (k("ShiftLeft") || k("ShiftRight") ? 1 : 0) - (k("ControlLeft") || k("ControlRight") ? 1 : 0);
    let absThrottle: number | null = null;
    let stagePressed = k("Space") === 1;

    // Gamepads.
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    for (const pad of pads) {
      if (!pad || !pad.connected) continue;
      const dz = (v: number | undefined) => {
        const x = v ?? 0;
        return Math.abs(x) < s.deadzone ? 0 : (x - Math.sign(x) * s.deadzone) / (1 - s.deadzone);
      };
      const inv = s.invertPitch ? -1 : 1;
      const isHotas = s.hotas.enabled && pad.index === s.hotas.padIndex;
      if (isHotas) {
        const ax = (i: number) => (i >= 0 ? dz(pad.axes[i]) : 0);
        roll += ax(s.hotas.roll);
        pitch += inv * ax(s.hotas.pitch);
        yaw += ax(s.hotas.yaw);
        if (s.hotas.throttle >= 0) {
          const raw = pad.axes[s.hotas.throttle] ?? 0;
          const v = (s.hotas.invertThrottle ? -raw : raw) * 0.5 + 0.5;
          absThrottle = Math.max(0, Math.min(1, v));
        }
      } else if (pad.mapping === "standard") {
        // Left stick pitch/yaw, bumpers roll, right stick translation, triggers throttle.
        yaw += dz(pad.axes[0]);
        pitch += inv * dz(pad.axes[1]);
        roll += (pad.buttons[5]?.value ?? 0) - (pad.buttons[4]?.value ?? 0);
        ty += dz(pad.axes[2]);
        tz += dz(pad.axes[3]);
        tx += (pad.buttons[12]?.pressed ? 1 : 0) - (pad.buttons[13]?.pressed ? 1 : 0);
        dThrottle += (pad.buttons[7]?.value ?? 0) - (pad.buttons[6]?.value ?? 0);
        const pressed = (i: number) => pad.buttons[i]?.pressed === true;
        const edge = (i: number) => pressed(i) && !this.padButtons[i];
        if (edge(1)) {
          if (c.sas === 0) c.sas = this.lastSas || 1;
          else (this.lastSas = c.sas), (c.sas = 0);
        }
        if (edge(2)) c.rcs = !c.rcs;
        if (edge(3)) c.speedRef = (c.speedRef + 1) % 3;
        stagePressed ||= pressed(0);
        this.padButtons = pad.buttons.map((b) => b.pressed);
      }
    }

    const clamp = (x: number) => Math.max(-1, Math.min(1, x));
    c.rotation = [clamp(roll), clamp(pitch), clamp(yaw)];
    c.translation = [clamp(tx), clamp(ty), clamp(tz)];
    if (absThrottle !== null) c.throttle = absThrottle;
    c.throttle = Math.max(0, Math.min(1, c.throttle + dThrottle * THROTTLE_RATE * dt));

    // Staging: hold.
    if (stagePressed) {
      this.stageHeld += dt;
      if (this.stageHeld >= STAGE_HOLD_S && !this.stageFired) {
        this.stageFired = true;
        this.events.stage();
      }
    } else {
      this.stageHeld = 0;
      this.stageFired = false;
    }
  }

  /** Staging progress 0–1 while the key is held (for the HUD). */
  get stageProgress(): number {
    return this.stageFired ? 0 : Math.min(1, this.stageHeld / STAGE_HOLD_S);
  }
}
