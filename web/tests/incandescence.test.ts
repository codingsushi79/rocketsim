// Entry incandescence against physical references. Run: npm run test:unit
import assert from "node:assert/strict";
import { test } from "node:test";
import { EMISSIVITY, incandescenceU, wallTemperature } from "../src/render/incandescence.ts";

const SUN_RADIANCE_U = (149_597_870_700 / 695_700_000) ** 2; // units.ts: (AU/R☉)²

test("a 5772 K black body has the solar disk's radiance and is white", () => {
  // σT⁴/E☉ vs (AU/R☉)²: the IAU 2015 B3 nominal Teff, TSI and R☉ agree to ~1e-4
  // (4π·AU²·1361 W/m² = 3.8275e26 W vs the nominal L☉ 3.828e26 W).
  const c = incandescenceU(5772, 1);
  for (const x of c) assert.ok(Math.abs(x / SUN_RADIANCE_U - 1) < 3e-4, String(x));
  assert.ok(Math.abs(c[0] - c[1]) < 1e-9 * c[1] && Math.abs(c[2] - c[1]) < 1e-9 * c[1], "white balance");
});

test("radiative equilibrium: εσT⁴ = q", () => {
  const q = 5e5;
  const T = wallTemperature(q);
  assert.ok(Math.abs(EMISSIVITY * 5.670374419e-8 * T ** 4 - q) / q < 1e-12);
});

test("hot walls are red-orange (R > G > B) and brighten steeply with T", () => {
  const [r, g, b] = incandescenceU(1800);
  assert.ok(r > g && g > b, `${r} ${g} ${b}`);
  // Visible radiance rises far faster than T⁴ at these temperatures (Wien tail).
  assert.ok(incandescenceU(2000)[1] / g > (2000 / 1800) ** 4 * 2);
});
