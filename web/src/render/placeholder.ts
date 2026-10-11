// Placeholder spacecraft for scenarios without a vehicle definition (test scenes). Built in
// the spacecraft body frame: +x is the capsule nose (forward), the engine points −x.
// Dimensions are roughly those of a ~15 t capsule + service module.

import * as THREE from "three";

export function placeholderSpacecraft(): THREE.Group {
  const g = new THREE.Group();
  const hull = new THREE.MeshStandardMaterial({ color: 0xd9dde3, metalness: 0.2, roughness: 0.55 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x2a2d33, metalness: 0.6, roughness: 0.4 });
  const panel = new THREE.MeshStandardMaterial({ color: 0x1b2a4a, metalness: 0.3, roughness: 0.35 });
  const shield = new THREE.MeshStandardMaterial({ color: 0x5a4632, metalness: 0.0, roughness: 0.9 });

  // Service module: cylinder along x, 4.0 m diameter, 4.5 m long.
  const sm = new THREE.Mesh(new THREE.CylinderGeometry(2.0, 2.0, 4.5, 48), hull);
  sm.rotation.z = Math.PI / 2;
  sm.position.x = -2.25;
  g.add(sm);
  // Engine bell.
  const bell = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 1.1, 1.8, 40, 1, true), dark);
  bell.rotation.z = Math.PI / 2;
  bell.position.x = -5.4;
  g.add(bell);
  // Heat shield and capsule (frustum), docking port at the nose.
  const hs = new THREE.Mesh(new THREE.CylinderGeometry(2.05, 2.05, 0.25, 48), shield);
  hs.rotation.z = Math.PI / 2;
  hs.position.x = 0.12;
  g.add(hs);
  const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.75, 2.0, 2.9, 48), hull);
  cap.rotation.z = -Math.PI / 2;
  cap.position.x = 1.7;
  g.add(cap);
  const port = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 0.6, 0.35, 32), dark);
  port.rotation.z = Math.PI / 2;
  port.position.x = 3.3;
  g.add(port);
  // Two solar wings.
  for (const side of [-1, 1]) {
    const wing = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.04, 7.0), panel);
    wing.position.set(-2.4, 0, side * (2.0 + 3.6));
    g.add(wing);
    const strut = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.6, 8), dark);
    strut.rotation.x = Math.PI / 2;
    strut.position.set(-2.4, 0, side * 2.2);
    g.add(strut);
  }
  // RCS quads (four blocks around the SM forward rim).
  for (let k = 0; k < 4; k++) {
    const a = (k * Math.PI) / 2 + Math.PI / 4;
    const q = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.35, 0.35), dark);
    q.position.set(-0.8, Math.cos(a) * 2.1, Math.sin(a) * 2.1);
    g.add(q);
  }
  return g;
}
