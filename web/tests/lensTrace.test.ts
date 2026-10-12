// Lens model checks against analytic references. Run: npm run test:unit
import assert from "node:assert/strict";
import { test } from "node:test";
import { LENS, allGhosts, focalProperties, indexAt, reflectance, traceGhost } from "../src/render/lensTrace.ts";

test("double-Gauss focal length is 50 mm (Kolb et al. 1995 scaling)", () => {
  const { efl, pupilArea } = focalProperties();
  assert.ok(Math.abs(efl - 50) < 1, `EFL ${efl}`);
  // f-number from the traced entrance pupil, stopped down by STOP_SCALE = 0.5 from f/2.
  const n = efl / (2 * Math.sqrt(pupilArea / Math.PI));
  assert.ok(n > 3.8 && n < 4.8, `f/${n}`);
});

test("Fresnel: uncoated normal incidence is ((n−1)/(n+1))²", () => {
  for (const n of [1.5, 1.67, 1.717]) {
    const want = ((n - 1) / (n + 1)) ** 2;
    assert.ok(Math.abs(reflectance(1, n, 1, 550, false) - want) < 1e-12);
  }
});

test("quarter-wave MgF₂ coating hits its design minimum at 550 nm (Hecht §9.7)", () => {
  const ng = 1.67, nf = 1.38;
  const want = ((ng - nf * nf) / (ng + nf * nf)) ** 2;
  assert.ok(Math.abs(reflectance(1, ng, 1, 550, true) - want) < 1e-9);
  // Off the design wavelength the reflectance rises (the ghosts' magenta tint).
  assert.ok(reflectance(1, ng, 1, 450, true) > want && reflectance(1, ng, 1, 650, true) > want);
});

test("dispersion: nF − nC = (nd − 1)/vd", () => {
  const nd = 1.67, vd = 47.2;
  assert.ok(Math.abs(indexAt(nd, vd, 486.1) - indexAt(nd, vd, 656.3) - (nd - 1) / vd) < 1e-12);
  assert.ok(Math.abs(indexAt(nd, vd, 587.6) - nd) < 1e-12);
});

test("ghosts: 45 surface pairs, each two reflections attenuating the beam", () => {
  const g = allGhosts();
  assert.equal(g.length, 45);
  const { imageZ } = focalProperties();
  const r = traceGhost(g[0]!, 0.1, 550, 16, imageZ);
  for (const e of r.e) assert.ok(e >= 0 && e < 0.07 * 0.07, `energy ${e}`);
  assert.equal(LENS.length, 11);
});
