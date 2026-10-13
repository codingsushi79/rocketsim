// Save games (M10): named slots in local storage (persists in the desktop app), plus
// export/import as JSON files. The physics part is the core's `saveState` body; this
// wraps it with the mission, controls, warp and camera.

import type { FlightControls } from "./simulation";

export interface SaveGame {
  version: 1;
  id: string;
  name: string;
  /** Wall-clock creation time (ISO), for sorting; never used by the physics. */
  created: string;
  missionId: string;
  /** Simulation time, UTC ISO (display only). */
  utc: string;
  /** Core save body (JSON text). */
  sim: string;
  controls: FlightControls;
  warpIndex: number;
  cameraMode: string;
  targetId: number;
  /** Flight recorder samples (replay), optional. */
  recording?: number[];
}

const KEY = "rocketsim.saves.v1";
const MAX = 20;

export function listSaves(): SaveGame[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "[]") as SaveGame[];
    return Array.isArray(v) ? v.sort((a, b) => b.created.localeCompare(a.created)) : [];
  } catch {
    return [];
  }
}

export function storeSave(s: SaveGame): { ok: boolean; error?: string } {
  try {
    const all = listSaves().filter((x) => x.id !== s.id && !(s.name.startsWith("Quicksave") && x.name === s.name));
    all.unshift(s);
    localStorage.setItem(KEY, JSON.stringify(all.slice(0, MAX)));
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export function deleteSave(id: string): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(listSaves().filter((x) => x.id !== id)));
  } catch {
    // Storage unavailable: nothing to delete.
  }
}

/** Download a save as a .json file. */
export function exportSave(s: SaveGame): void {
  const blob = new Blob([JSON.stringify(s, null, 1)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${s.name.replace(/[^\w.-]+/g, "_")}.rocketsim.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/** Pick a .json save file and parse it. */
export function importSave(): Promise<SaveGame | null> {
  return new Promise((resolve) => {
    const inp = document.createElement("input");
    inp.type = "file";
    inp.accept = ".json,application/json";
    inp.onchange = async () => {
      const f = inp.files?.[0];
      if (!f) return resolve(null);
      try {
        const s = JSON.parse(await f.text()) as SaveGame;
        resolve(s.version === 1 && typeof s.sim === "string" && typeof s.missionId === "string" ? s : null);
      } catch {
        resolve(null);
      }
    };
    inp.click();
  });
}
