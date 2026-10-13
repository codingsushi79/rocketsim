// Procedural audio (M10), Web Audio only: no sample files, so nothing to license.
//
// Physics first: sound needs a medium. Outside the vehicle, engine, RCS and entry sound
// scale with the ambient pressure (silent in vacuum) unless "vacuum sound" is enabled.
// In the cockpit, the crew hears structure-borne sound through the hull: a low-passed
// engine rumble (below ~200 Hz), RCS thumps, the cabin fans, and the entry roar through the
// heat shield. Levels are perceptual, not calibrated SPL.

export interface AudioMix {
  master: number;
  effects: number;
  ambience: number;
  ui: number;
  vacuumSound: boolean;
}

export interface AudioFrame {
  /** Main-engine thrust as a fraction of full (0–1). */
  thrust: number;
  /** Sum of RCS duty cycles (0–n). */
  rcs: number;
  /** Dynamic pressure (Pa) and ambient pressure (Pa). */
  q: number;
  pAmb: number;
  cockpit: boolean;
  /** Number of attached stages (a drop is a separation). */
  stages: number;
  outcome: string;
  caution: boolean;
  /** Paused or warping fast: effects fade out. */
  silent: boolean;
}

function noiseBuffer(ctx: AudioContext, seconds: number, brown: boolean): AudioBuffer {
  const n = Math.floor(ctx.sampleRate * seconds);
  const b = ctx.createBuffer(1, n, ctx.sampleRate);
  const d = b.getChannelData(0);
  let last = 0;
  let seed = 12345;
  for (let i = 0; i < n; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    const w = (seed / 0x7fffffff) * 2 - 1;
    if (brown) {
      last = (last + 0.02 * w) / 1.02;
      d[i] = last * 3.5;
    } else d[i] = w;
  }
  return b;
}

export class GameAudio {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private fx!: GainNode;
  private amb!: GainNode;
  private uiBus!: GainNode;
  private engineGain!: GainNode;
  private engineLp!: BiquadFilterNode;
  private rcsGain!: GainNode;
  private entryGain!: GainNode;
  private entryLp!: BiquadFilterNode;
  private fanGain!: GainNode;
  private white!: AudioBuffer;
  private lastStages = -1;
  private lastOutcome = "flying";
  private cautionUntil = 0;
  private mix: AudioMix = { master: 0.8, effects: 0.8, ambience: 0.6, ui: 0.6, vacuumSound: false };

  /** Browsers start audio only after a user gesture: call from one. */
  resume(): void {
    if (!this.ctx) this.build();
    void this.ctx?.resume();
  }

  setMix(m: AudioMix): void {
    this.mix = m;
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.master.gain.setTargetAtTime(m.master, t, 0.05);
    this.fx.gain.setTargetAtTime(m.effects, t, 0.05);
    this.amb.gain.setTargetAtTime(m.ambience, t, 0.05);
    this.uiBus.gain.setTargetAtTime(m.ui, t, 0.05);
  }

  private loop(buf: AudioBuffer, out: AudioNode): AudioBufferSourceNode {
    const s = this.ctx!.createBufferSource();
    s.buffer = buf;
    s.loop = true;
    s.connect(out);
    s.start();
    return s;
  }

  private build(): void {
    const ctx = new AudioContext();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.connect(ctx.destination);
    const bus = () => {
      const g = ctx.createGain();
      g.connect(this.master);
      return g;
    };
    this.fx = bus();
    this.amb = bus();
    this.uiBus = bus();
    const brown = noiseBuffer(ctx, 4, true);
    this.white = noiseBuffer(ctx, 2, false);
    // Engine: brown noise, low-passed (structure-borne in the cabin, brighter in air).
    this.engineLp = ctx.createBiquadFilter();
    this.engineLp.type = "lowpass";
    this.engineGain = ctx.createGain();
    this.engineGain.gain.value = 0;
    this.engineLp.connect(this.engineGain).connect(this.fx);
    this.loop(brown, this.engineLp);
    // RCS: band-passed white noise, gated by the duty cycle.
    const rcsBp = ctx.createBiquadFilter();
    rcsBp.type = "bandpass";
    rcsBp.frequency.value = 900;
    rcsBp.Q.value = 0.8;
    this.rcsGain = ctx.createGain();
    this.rcsGain.gain.value = 0;
    rcsBp.connect(this.rcsGain).connect(this.fx);
    this.loop(this.white, rcsBp);
    // Entry: low roar rising with dynamic pressure.
    this.entryLp = ctx.createBiquadFilter();
    this.entryLp.type = "lowpass";
    this.entryGain = ctx.createGain();
    this.entryGain.gain.value = 0;
    this.entryLp.connect(this.entryGain).connect(this.fx);
    this.loop(brown, this.entryLp);
    // Cabin fans: soft pink-ish noise plus a faint 120 Hz hum.
    const fanLp = ctx.createBiquadFilter();
    fanLp.type = "lowpass";
    fanLp.frequency.value = 700;
    this.fanGain = ctx.createGain();
    this.fanGain.gain.value = 0;
    fanLp.connect(this.fanGain).connect(this.amb);
    this.loop(this.white, fanLp);
    const hum = ctx.createOscillator();
    hum.frequency.value = 120;
    const humG = ctx.createGain();
    humG.gain.value = 0.015;
    hum.connect(humG).connect(this.fanGain);
    hum.start();
    this.setMix(this.mix);
  }

  /** A short one-shot: noise burst (thump, boom) or a tone (click, chime). */
  private burst(dur: number, freq: number, gain: number, out: AudioNode, kind: "noise" | "tone" = "noise"): void {
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + 0.005);
    g.gain.exponentialRampToValueAtTime(1e-4, t + dur);
    g.connect(out);
    if (kind === "noise") {
      const s = ctx.createBufferSource();
      s.buffer = this.white;
      const f = ctx.createBiquadFilter();
      f.type = "lowpass";
      f.frequency.value = freq;
      s.connect(f).connect(g);
      s.start(t);
      s.stop(t + dur);
    } else {
      const o = ctx.createOscillator();
      o.frequency.value = freq;
      o.connect(g);
      o.start(t);
      o.stop(t + dur);
    }
  }

  click(): void {
    if (this.ctx) this.burst(0.04, 2400, 0.12, this.uiBus, "tone");
  }

  update(f: AudioFrame): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    // How much sound reaches the listener: through the hull in the cockpit; through air
    // outside, ∝ √(p/p₀), silent in vacuum unless the vacuum-sound option is on.
    const air = Math.min(1, Math.sqrt(Math.max(f.pAmb, 0) / 101_325));
    const outside = this.mix.vacuumSound ? Math.max(air, 0.6) : air;
    const path = f.cockpit ? 1 : outside;
    const on = f.silent ? 0 : 1;
    this.engineLp.frequency.setTargetAtTime(f.cockpit ? 160 : 300 + 1700 * air, t, 0.1);
    this.engineGain.gain.setTargetAtTime(on * path * 0.9 * f.thrust, t, 0.08);
    this.rcsGain.gain.setTargetAtTime(on * path * 0.25 * Math.min(1, f.rcs), t, 0.02);
    // Entry: the shock layer is outside; inside, through the shield and structure.
    const qn = Math.min(1, Math.sqrt(Math.max(f.q, 0) / 40_000));
    this.entryLp.frequency.setTargetAtTime(f.cockpit ? 220 : 400 + 1200 * qn, t, 0.2);
    this.entryGain.gain.setTargetAtTime(on * qn * (f.cockpit ? 0.9 : Math.max(air, this.mix.vacuumSound ? 0.6 : 0)), t, 0.2);
    this.fanGain.gain.setTargetAtTime(f.cockpit && !f.silent ? 0.05 : 0, t, 0.3);
    // Events.
    if (this.lastStages >= 0 && f.stages < this.lastStages && !f.silent) this.burst(0.6, 180, 0.9 * Math.max(path, 0.5), this.fx);
    this.lastStages = f.stages;
    if (f.outcome !== this.lastOutcome && (f.outcome === "crashed" || f.outcome === "burnedup" || f.outcome === "brokeup")) {
      this.burst(3.5, 300, 1.2, this.fx);
      this.burst(2.0, 60, 1.0, this.fx, "tone");
    }
    this.lastOutcome = f.outcome;
    // Master caution: a two-tone chime when a caution appears (at most every 6 s).
    if (f.caution && performance.now() > this.cautionUntil) {
      this.cautionUntil = performance.now() + 6000;
      this.burst(0.25, 880, 0.25, this.uiBus, "tone");
      setTimeout(() => this.ctx && this.burst(0.35, 660, 0.25, this.uiBus, "tone"), 260);
    }
  }
}
