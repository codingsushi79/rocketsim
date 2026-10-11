// Loads the WASM physics core. All physics lives in Rust (crates/sim-core);
// this module only exposes the bindings with TypeScript types.
import init, * as wasm from "./wasm/sim_wasm.js";

export interface BodyRow {
  id: number;
  name: string;
  kind: string;
  parent: number | null;
  gm: number;
  radii: [number, number, number];
}

export interface Core {
  version: string;
  canary: string;
  utcToTdbSeconds(isoUtc: string): number;
  tdbToUtcIso(tdbSeconds: number): string;
  isProvisionalUtc(isoUtc: string): boolean;
  bodies: BodyRow[];
}

export async function loadCore(): Promise<Core> {
  await init();
  return {
    version: wasm.coreVersion(),
    canary: wasm.canary(),
    utcToTdbSeconds: wasm.utcToTdbSeconds,
    tdbToUtcIso: wasm.tdbToUtcIso,
    isProvisionalUtc: wasm.isProvisionalUtc,
    bodies: JSON.parse(wasm.bodiesJson()) as BodyRow[],
  };
}
