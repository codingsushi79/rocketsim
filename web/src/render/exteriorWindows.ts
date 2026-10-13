// Windows on the outside of the hull, from the cabin data (the same openings the cockpit
// interior cuts): each opening is projected from the pressure vessel along the wall's
// normal onto the outer mould line, and a dark glass pane with a thin frame is laid on the
// surface there. Glass: dielectric (F0 ≈ 0.04), very smooth, so it shows the Sun's glint
// and is otherwise near-black (a lit cabin behind it is far dimmer than daylight).

import * as THREE from "three";
import type { CabinDef } from "./interior";

function radial(def: CabinDef, az: number): THREE.Vector3 {
  const up = new THREE.Vector3(...def.up).normalize();
  const side = new THREE.Vector3(...def.forward).cross(up).normalize().negate();
  const a = (az * Math.PI) / 180;
  return up.multiplyScalar(Math.cos(a)).addScaledVector(side, Math.sin(a));
}

function roundedRect(w: number, h: number, r: number): THREE.Shape {
  const s = new THREE.Shape();
  const x = -w / 2, y = -h / 2;
  s.moveTo(x + r, y);
  s.lineTo(x + w - r, y);
  s.quadraticCurveTo(x + w, y, x + w, y + r);
  s.lineTo(x + w, y + h - r);
  s.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  s.lineTo(x + r, y + h);
  s.quadraticCurveTo(x, y + h, x, y + h - r);
  s.lineTo(x, y + r);
  s.quadraticCurveTo(x, y, x + r, y);
  return s;
}

/** Add window panes to `parent` (model space) on the outer surface of `hull`. */
export function addExteriorWindows(def: CabinDef, hull: THREE.Mesh[], parent: THREE.Object3D): void {
  const { x0, x1, r0, r1 } = def.vessel;
  const slope = (r1 - r0) / (x1 - x0);
  const glass = new THREE.MeshStandardMaterial({ color: 0x05070a, roughness: 0.04, metalness: 0.0 });
  const frame = new THREE.MeshStandardMaterial({ color: 0x3a3d42, roughness: 0.5, metalness: 0.6 });
  const ray = new THREE.Raycaster();
  for (const m of hull) m.updateWorldMatrix(true, false);
  // Hit the outermost surface whichever way its faces are wound.
  const sides = hull.map((m) => (m.material as THREE.Material).side);
  for (const m of hull) (m.material as THREE.Material).side = THREE.DoubleSide;
  for (const w of def.windows) {
    const rad = radial(def, w.azimuth);
    const rIn = r0 + slope * (w.x - x0);
    const p = new THREE.Vector3(w.x, 0, 0).addScaledVector(rad, rIn);
    // Outward wall normal of the frustum r(x): (−dr/dx, radial), normalised.
    const n = rad.clone().add(new THREE.Vector3(-slope, 0, 0)).normalize();
    // Cast inward from outside (the raycaster sees front faces only).
    ray.set(p.clone().addScaledVector(n, 2), n.clone().negate());
    ray.far = 2;
    const hit = ray.intersectObjects(hull, false).find((h) => h.face);
    if (!hit || !hit.face) continue;
    const nrm = hit.face.normal.clone().transformDirection(hit.object.matrixWorld).normalize();
    if (nrm.dot(n) < 0) nrm.negate();
    // Pane axes in the tangent plane: "height" along the vehicle axis, "width" around it.
    const hAxis = new THREE.Vector3(1, 0, 0).addScaledVector(nrm, -nrm.x).normalize();
    const wAxis = new THREE.Vector3().crossVectors(nrm, hAxis).normalize();
    const basis = new THREE.Matrix4().makeBasis(wAxis, hAxis, nrm);
    const rc = Math.min(w.width, w.height) * 0.28;
    const add = (geo: THREE.BufferGeometry, mat: THREE.Material, lift: number) => {
      const mesh = new THREE.Mesh(geo, mat);
      mesh.quaternion.setFromRotationMatrix(basis);
      mesh.position.copy(hit.point).addScaledVector(nrm, lift);
      mesh.castShadow = false;
      mesh.receiveShadow = true;
      parent.add(mesh);
    };
    add(new THREE.ShapeGeometry(roundedRect(w.width + 0.07, w.height + 0.07, rc + 0.035), 6), frame, 0.004);
    add(new THREE.ShapeGeometry(roundedRect(w.width, w.height, rc), 6), glass, 0.007);
  }
  hull.forEach((m, i) => ((m.material as THREE.Material).side = sides[i]!));
}
