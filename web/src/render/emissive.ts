// Self-luminous, transparent effects (engine plumes, RCS puffs, fireballs, re-entry
// plasma). They write no depth, so the cloud and atmosphere passes, which read the scene
// depth, would treat them as lying on whatever is behind them and paint clouds over a
// plume. They live on their own layer and are drawn after those passes (Engine), still
// depth-tested against the opaque scene.

import type * as THREE from "three";

export const EMISSIVE_LAYER = 1;

/** Registered objects → whether they have been seen in the scene (to drop discarded ones). */
const objects = new Map<THREE.Object3D, boolean>();

/** Move `o` (not its children) to the emissive layer. */
export function markEmissive(o: THREE.Object3D): void {
  o.layers.set(EMISSIVE_LAYER);
  objects.set(o, false);
}

export function forgetEmissive(o: THREE.Object3D): void {
  objects.delete(o);
}

/** Is any emissive object visible (itself and all its ancestors) and in a scene? */
export function anyEmissiveShown(scene: THREE.Object3D): boolean {
  let any = false;
  for (const [o, seen] of objects) {
    let p: THREE.Object3D | null = o;
    let shown = true;
    while (p && p !== scene) {
      shown &&= p.visible;
      p = p.parent;
    }
    if (p === scene) {
      if (!seen) objects.set(o, true);
      any ||= shown;
    } else if (seen) objects.delete(o); // removed from the scene for good (old vehicle)
  }
  return any;
}
