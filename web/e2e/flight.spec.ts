// M5 flight: the RS-1 model loads, the engine burns with a plume and SAS, RCS fires,
// the service module separates and drifts away. Screenshots go to test-results/.
import { expect, test, type Page } from "@playwright/test";
import { mirrorConsole } from "./logging";

async function frames(page: Page, n: number): Promise<void> {
  const t0 = Date.now();
  await page.evaluate(async (count) => {
    const h = window.__rocketsim!;
    for (let i = 0; i < count; i++) h.stepNow(1 / 60);
    await h.frame(1);
  }, n);
  console.log(`${n} frames in ${Date.now() - t0} ms`);
}

test("fly the RS-1: burn, RCS, staging", async ({ page }, info) => {
  test.setTimeout(300_000);
  mirrorConsole(page);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => m.type() === "error" && !m.text().startsWith("Failed to load resource") && errors.push(m.text()));
  // Low preset: CI renders with SwiftShader (software GL); physics is unaffected.
  await page.addInitScript(() => {
    const low = { preset: "low", depthMode: "auto", renderScale: 0.75, msaa: 0, bloom: false, atmosphereSteps: 8, starLimitMag: 6, textureQuality: "standard", bodySegments: 64, cloudSteps: 0 };
    localStorage.setItem("rocketsim.settings.v1", JSON.stringify({ version: 1, graphics: low }));
  });
  await page.goto("/?test");
  await page.getByRole("button", { name: "New Mission" }).click();
  await page.locator("#mission-leo400").click();
  await expect(page.locator(".hud-prop")).toBeVisible();
  await expect(page.locator("#hud-dv")).toContainText("m/s");
  const dv0 = parseFloat((await page.locator("#hud-dv").textContent()) ?? "0");
  expect(dv0).toBeGreaterThan(3400);
  expect(dv0).toBeLessThan(3500);

  // Burn prograde at full throttle.
  await page.evaluate(() => {
    const h = window.__rocketsim!;
    h.camera!.setDistance(30, true);
    h.camera!.setAngles(2.5, 0.25, true);
    const c = h.sim!.controls;
    c.sas = 2;
    c.throttle = 1;
  });
  await frames(page, 180);
  const burn = await page.evaluate(() => window.__rocketsim!.sim!.telemetry()!);
  expect(burn.engines[0]!.running).toBe(true);
  expect(burn.engines[0]!.thrust).toBeCloseTo(66_723, 0);
  expect(burn.mass).toBeLessThan(24_960);
  await page.screenshot({ path: info.outputPath("flight-burn.png") });

  // Cut the engine (X) and pitch up with S (SAS rate command): RCS fires.
  await page.keyboard.press("x");
  await page.keyboard.press("1");
  await page.keyboard.down("s");
  await frames(page, 40);
  const rcs = await page.evaluate(() => window.__rocketsim!.sim!.telemetry()!);
  expect(rcs.rcs[0]!.some((d) => d > 0)).toBe(true);
  expect(rcs.omega[1]).toBeGreaterThan(0);
  await page.screenshot({ path: info.outputPath("flight-rcs.png") });
  await page.keyboard.up("s");

  // Separate the service module.
  await page.evaluate(() => {
    const h = window.__rocketsim!;
    h.sim!.stage();
  });
  await frames(page, 240);
  const attached = await page.evaluate(() => Array.from(window.__rocketsim!.sim!.sim.attachedStages()));
  expect(attached).toEqual([0, 1]);
  const debris = await page.evaluate(() => window.__rocketsim!.sim!.sim.debris().length);
  expect(debris).toBe(11);
  expect(await page.locator("#hud-stage").textContent()).toContain("final stage");
  await page.evaluate(() => window.__rocketsim!.camera!.setDistance(25, true));
  await frames(page, 2);
  await page.screenshot({ path: info.outputPath("flight-staged.png") });
  expect(errors).toEqual([]);
});
