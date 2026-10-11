// Player settings: graphics presets up to "max" (decision D10: RTX 4070-class at
// 1440p), simulation options, audio and interface. Persisted per viewer in
// localStorage, and always works without it.

export type Preset = "low" | "medium" | "high" | "max" | "custom";
export type DepthMode = "auto" | "reversed" | "log";

export interface GraphicsSettings {
  preset: Preset;
  /** Multiplier on devicePixelRatio. */
  renderScale: number;
  /** MSAA samples on the HDR target (0 = off). */
  msaa: 0 | 2 | 4 | 8;
  bloom: boolean;
  /** Primary ray-march samples for atmospheric scattering. */
  atmosphereSteps: number;
  /** Faintest catalog star drawn (V magnitude). */
  starLimitMag: number;
  textureQuality: "standard" | "high";
  depthMode: DepthMode;
  /** Sphere segments for bodies (detail). */
  bodySegments: number;
}

export interface SimSettings {
  /** Integrator relative tolerance. */
  rtol: number;
  earthDegree: number;
  thirdBody: boolean;
  harmonics: boolean;
  drag: boolean;
  srp: boolean;
  f107: number;
  f107a: number;
  ap: number;
}

export interface AudioSettings {
  master: number;
  music: number;
  effects: number;
}

export interface InterfaceSettings {
  hudScale: number;
  showFps: boolean;
  /** Artistic boost of star and Milky Way brightness (1 = physical). */
  starBoost: number;
  showOrbit: boolean;
}

export interface Settings {
  version: 1;
  graphics: GraphicsSettings;
  sim: SimSettings;
  audio: AudioSettings;
  ui: InterfaceSettings;
}

export const GRAPHICS_PRESETS: Record<Exclude<Preset, "custom">, Omit<GraphicsSettings, "preset" | "depthMode">> = {
  low: { renderScale: 0.75, msaa: 0, bloom: false, atmosphereSteps: 8, starLimitMag: 6.0, textureQuality: "standard", bodySegments: 64 },
  medium: { renderScale: 1.0, msaa: 0, bloom: true, atmosphereSteps: 16, starLimitMag: 7.0, textureQuality: "standard", bodySegments: 128 },
  high: { renderScale: 1.0, msaa: 4, bloom: true, atmosphereSteps: 32, starLimitMag: 8.0, textureQuality: "high", bodySegments: 192 },
  max: { renderScale: 1.0, msaa: 8, bloom: true, atmosphereSteps: 64, starLimitMag: 8.0, textureQuality: "high", bodySegments: 256 },
};

export function defaultSettings(): Settings {
  return {
    version: 1,
    graphics: { preset: "high", depthMode: "auto", ...GRAPHICS_PRESETS.high },
    sim: { rtol: 1e-12, earthDegree: 8, thirdBody: true, harmonics: true, drag: true, srp: true, f107: 150, f107a: 150, ap: 4 },
    audio: { master: 0.8, music: 0.6, effects: 0.8 },
    ui: { hudScale: 1, showFps: false, starBoost: 1, showOrbit: true },
  };
}

const KEY = "rocketsim.settings.v1";

type Listener = (s: Settings) => void;

export class SettingsStore {
  private value: Settings;
  private listeners: Listener[] = [];

  constructor() {
    this.value = SettingsStore.load();
  }

  get(): Settings {
    return this.value;
  }

  update(mutate: (s: Settings) => void): void {
    const next = structuredClone(this.value);
    mutate(next);
    this.value = next;
    try {
      localStorage.setItem(KEY, JSON.stringify(next));
    } catch {
      // Storage unavailable (private mode, blocked): settings last for this session only.
    }
    for (const l of this.listeners) l(next);
  }

  applyPreset(p: Exclude<Preset, "custom">): void {
    this.update((s) => {
      Object.assign(s.graphics, GRAPHICS_PRESETS[p]);
      s.graphics.preset = p;
    });
  }

  reset(): void {
    this.update((s) => Object.assign(s, defaultSettings()));
  }

  subscribe(l: Listener): () => void {
    this.listeners.push(l);
    return () => {
      this.listeners = this.listeners.filter((x) => x !== l);
    };
  }

  private static load(): Settings {
    const d = defaultSettings();
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return d;
      const parsed = JSON.parse(raw) as Partial<Settings>;
      if (parsed.version !== 1) return d;
      // Merge so that settings added later get their defaults.
      return {
        version: 1,
        graphics: { ...d.graphics, ...parsed.graphics },
        sim: { ...d.sim, ...parsed.sim },
        audio: { ...d.audio, ...parsed.audio },
        ui: { ...d.ui, ...parsed.ui },
      };
    } catch {
      return d;
    }
  }
}
