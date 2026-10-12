// Vehicle definitions (data/vehicles/*.json) as the UI sees them. The physics core
// parses and validates the same text; this module only reads what drawing and the
// HUD need. Body frame: +X forward along the stack, metres.

import rs1Text from "../../../data/vehicles/rs1_corvid.json?raw";

export type Vec3 = [number, number, number];

export interface VehicleDef {
  name: string;
  description: string;
  model: string;
  stages: { id: string; name: string }[];
  parts: { id: string; kind: string; stage: string; position: Vec3; shape: Record<string, Record<string, number | number[]>> | "point" }[];
  tanks: { id: string; stage: string; propellant: string; capacity: number }[];
  engines: { id: string; stage: string; position: Vec3; direction: Vec3; thrust_vac: number; isp_vac: number; ignitions: number }[];
  rcs: { id: string; stage: string; thrust_vac: number; thrusters: { position: Vec3; direction: Vec3 }[] }[];
  wheels: { id: string; stage: string; max_momentum: number }[];
  /** Renderer-only cockpit layout. */
  cabin?: import("../render/interior").CabinDef;
}

export interface VehicleSource {
  text: string;
  def: VehicleDef;
}

export function vehicleSource(text: string): VehicleSource {
  return { text, def: JSON.parse(text) as VehicleDef };
}

export const RS1 = vehicleSource(rs1Text);

/** Flight telemetry (JSON from `Sim.telemetry`), SI units. */
export interface Telemetry {
  mass: number;
  com: Vec3;
  omega: Vec3;
  tanks: number[];
  wheels: number[];
  engines: { running: boolean; throttle: number; thrust: number; ignitions: number; flameout: boolean; direction: Vec3 }[];
  rcs: number[][];
  q: number;
  heat: number;
  pAmb: number;
  dv: number;
  burnTime: number;
  desat: boolean;
  captured: boolean;
  dvExpended: number;
  /** Orbit, surface, target. */
  speeds: number[];
  /** Air-relative velocity, ICRF (m/s). */
  vAir: Vec3;
}
