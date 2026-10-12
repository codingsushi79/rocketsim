// Free-orbit camera around a focus, with logarithmic zoom from ~1 m to interplanetary
// distances. Everything is f64 (JS numbers) in a frame centered on the focus. The
// engine places the camera at the render origin (floating origin).

import * as THREE from "three";

export class OrbitCamera {
  yaw = 0.6;
  pitch = 0.25;
  /** Distance to the focus, m. */
  distance = 30;
  minDistance = 1.5;
  maxDistance = 5e12;
  private targetYaw = this.yaw;
  private targetPitch = this.pitch;
  private targetDistance = this.distance;
  private dragging = false;
  private last = { x: 0, y: 0 };

  constructor(el: HTMLElement) {
    el.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 && e.button !== 2) return;
      this.dragging = true;
      this.last = { x: e.clientX, y: e.clientY };
      el.setPointerCapture(e.pointerId);
    });
    el.addEventListener("pointermove", (e) => {
      if (!this.dragging) return;
      const dx = e.clientX - this.last.x;
      const dy = e.clientY - this.last.y;
      this.last = { x: e.clientX, y: e.clientY };
      this.targetYaw -= dx * 0.005;
      this.targetPitch = Math.max(-1.55, Math.min(1.55, this.targetPitch + dy * 0.005));
    });
    const end = (e: PointerEvent) => {
      this.dragging = false;
      if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
    };
    el.addEventListener("pointerup", end);
    el.addEventListener("pointercancel", end);
    el.addEventListener("contextmenu", (e) => e.preventDefault());
    el.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        const k = Math.exp(e.deltaY * 0.0015);
        this.targetDistance = Math.max(this.minDistance, Math.min(this.maxDistance, this.targetDistance * k));
      },
      { passive: false },
    );
  }

  /** Set the view angles, optionally without smoothing. */
  setAngles(yaw: number, pitch: number, immediate = false): void {
    this.targetYaw = yaw;
    this.targetPitch = Math.max(-1.55, Math.min(1.55, pitch));
    if (immediate) {
      this.yaw = this.targetYaw;
      this.pitch = this.targetPitch;
    }
  }

  /** Keyboard/gamepad camera: rotate by (dYaw, dPitch) rad and zoom by a factor. */
  nudge(dYaw: number, dPitch: number, zoom: number): void {
    this.targetYaw += dYaw;
    this.targetPitch = Math.max(-1.55, Math.min(1.55, this.targetPitch + dPitch));
    this.targetDistance = Math.max(this.minDistance, Math.min(this.maxDistance, this.targetDistance * zoom));
  }

  /** Rotate around the focus (e.g. the menu's idle spin). */
  spin(dYaw: number): void {
    this.targetYaw += dYaw;
  }

  setDistance(d: number, immediate = false): void {
    this.targetDistance = Math.max(this.minDistance, Math.min(this.maxDistance, d));
    if (immediate) this.distance = this.targetDistance;
  }

  update(dt: number): void {
    const k = 1 - Math.exp(-dt * 10);
    this.yaw += (this.targetYaw - this.yaw) * k;
    this.pitch += (this.targetPitch - this.pitch) * k;
    this.distance = Math.exp(Math.log(this.distance) + (Math.log(this.targetDistance) - Math.log(this.distance)) * k);
  }

  /** Camera offset from the focus (f64, ICRF axes) given a local frame whose `up` is
   *  the radial direction and `fwd` a reference direction perpendicular to it. */
  offset(up: THREE.Vector3, fwd: THREE.Vector3): { offset: [number, number, number]; up: THREE.Vector3 } {
    const right = new THREE.Vector3().crossVectors(fwd, up).normalize();
    const f = new THREE.Vector3().crossVectors(up, right).normalize();
    const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
    const cy = Math.cos(this.yaw), sy = Math.sin(this.yaw);
    // Spherical coordinates: yaw around `up`, pitch above the horizontal plane.
    const dx = (f.x * cy + right.x * sy) * cp + up.x * sp;
    const dy = (f.y * cy + right.y * sy) * cp + up.y * sp;
    const dz = (f.z * cy + right.z * sy) * cp + up.z * sp;
    return { offset: [dx * this.distance, dy * this.distance, dz * this.distance], up };
  }
}
