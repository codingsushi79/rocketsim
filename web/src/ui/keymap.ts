// Rebindable keys (M10): flight and game actions → KeyboardEvent.code. Defaults are the
// KSP-like layout; Settings → Controls rebinds them.

export const ACTIONS = {
  pitchDown: ["Pitch down", "KeyW"],
  pitchUp: ["Pitch up", "KeyS"],
  yawLeft: ["Yaw left", "KeyA"],
  yawRight: ["Yaw right", "KeyD"],
  rollLeft: ["Roll left", "KeyQ"],
  rollRight: ["Roll right", "KeyE"],
  transFwd: ["Translate forward (RCS)", "KeyH"],
  transBack: ["Translate back", "KeyN"],
  transLeft: ["Translate left", "KeyJ"],
  transRight: ["Translate right", "KeyL"],
  transUp: ["Translate up", "KeyI"],
  transDown: ["Translate down", "KeyK"],
  throttleUp: ["Throttle up", "ShiftLeft"],
  throttleDown: ["Throttle down", "ControlLeft"],
  throttleFull: ["Full throttle", "KeyZ"],
  throttleCut: ["Cut throttle", "KeyX"],
  stage: ["Stage (hold)", "Space"],
  sas: ["SAS on / off", "KeyT"],
  rcs: ["RCS on / off", "KeyR"],
  fine: ["Fine control", "CapsLock"],
  speedRef: ["Speed reference", "KeyV"],
  target: ["Cycle target", "KeyY"],
  map: ["Map view", "KeyM"],
  camera: ["Camera mode", "KeyC"],
  warpUp: ["Time warp up", "Period"],
  warpDown: ["Time warp down", "Comma"],
  quicksave: ["Quicksave", "F5"],
  quickload: ["Quickload", "F9"],
} as const;

export type Action = keyof typeof ACTIONS;
export type Bindings = Partial<Record<Action, string>>;

export function defaultBindings(): Record<Action, string> {
  return Object.fromEntries(Object.entries(ACTIONS).map(([a, [, code]]) => [a, code])) as Record<Action, string>;
}

/** Effective code for an action (user binding over the default). */
export function codeOf(b: Bindings, a: Action): string {
  return b[a] ?? ACTIONS[a][1];
}

/** "KeyW" → "W", "ShiftLeft" → "Left Shift", … */
export function keyLabel(code: string): string {
  if (code.startsWith("Key")) return code.slice(3);
  if (code.startsWith("Digit")) return code.slice(5);
  const m: Record<string, string> = { ShiftLeft: "Left Shift", ShiftRight: "Right Shift", ControlLeft: "Left Ctrl", ControlRight: "Right Ctrl", AltLeft: "Left Alt", Space: "Space", CapsLock: "Caps Lock", Period: ".", Comma: ",", Slash: "/", Minus: "−", Equal: "=" };
  return m[code] ?? code;
}
