// M6: map view, maneuver node, burn autopilot and the planned-vs-actual report.
import { expect, test, type Page } from "@playwright/test";
import { mirrorConsole } from "./logging";

async function frames(page: Page, n: number): Promise<void> {
  await page.evaluate(async (count) => {
    const h = window.__rocketsim!;
    for (let i = 0; i < count; i++) h.stepNow(1 / 60);
    await h.frame(1);
  }, n);
}

test("map view: plan a node and execute it with the autopilot", async ({ page }) => {
  test.setTimeout(300_000);
  mirrorConsole(page);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => m.type() === "error" && !m.text().startsWith("Failed to load resource") && errors.push(m.text()));
  await page.addInitScript(() => {
    const low = { preset: "low", depthMode: "auto", renderScale: 0.75, msaa: 0, bloom: false, atmosphereSteps: 8, starLimitMag: 6, textureQuality: "standard", bodySegments: 64 };
    localStorage.setItem("rocketsim.settings.v1", JSON.stringify({ version: 1, graphics: low }));
  });
  await page.goto("/?test");
  await page.getByRole("button", { name: "New Mission" }).click();
  await page.locator("#mission-leo400").click();
  await expect(page.locator(".hud-prop")).toBeVisible();
  await frames(page, 5);

  // Map view with markers for the current orbit.
  await page.keyboard.press("m");
  await frames(page, 10);
  await expect(page.locator(".map-panel")).toBeVisible();
  await expect(page.locator(".map-marker.m-pe, .map-marker.m-ap").first()).toBeAttached();

  // A 100 m/s prograde node 20 minutes ahead.
  await page.evaluate(() => {
    const s = window.__rocketsim!.sim!.sim;
    s.addNode(s.epochTdb() + 1200, 100, 0, 0);
  });
  await frames(page, 20);
  await expect(page.locator(".map-node")).toHaveCount(1);
  const plan = await page.evaluate(() => JSON.parse(window.__rocketsim!.sim!.sim.planJson()));
  expect(plan.nodes[0].duration).toBeGreaterThan(30);
  expect(plan.nodes[0].duration).toBeLessThan(45);
  expect(plan.dvAfter).toBeLessThan(3447 - 99);

  // Execute: warp on rails until the autopilot stops warp, then 10× through the burn.
  await page.evaluate(() => window.__rocketsim!.sim!.sim.executeNode(0));
  await page.evaluate(() => (window.__rocketsim!.sim!.warpIndex = 6));
  for (let k = 0; k < 60; k++) {
    await frames(page, 10);
    const w = await page.evaluate(() => window.__rocketsim!.sim!.warp);
    if (w === 1) break;
  }
  const ap1 = await page.evaluate(() => JSON.parse(window.__rocketsim!.sim!.sim.autopilotJson()));
  expect(ap1.phase).toBe("aligning");
  expect(ap1.toStart).toBeGreaterThan(25);
  expect(ap1.toStart).toBeLessThanOrEqual(30.01);
  await page.evaluate(() => (window.__rocketsim!.sim!.warpIndex = 2)); // 10×
  let ap: { phase: string; report?: { dvPlanned: number; dvDelivered: number; compare: { label: string; planned: number; actual: number }[] } } = ap1;
  for (let k = 0; k < 200 && ap.phase !== "done"; k++) {
    await frames(page, 20);
    ap = await page.evaluate(() => JSON.parse(window.__rocketsim!.sim!.sim.autopilotJson()));
  }
  expect(ap.phase).toBe("done");
  const r = ap.report!;
  expect(Math.abs(r.dvDelivered - r.dvPlanned)).toBeLessThan(0.2);
  const apo = r.compare.find((c) => c.label === "Apoapsis")!;
  expect(Math.abs(apo.actual - apo.planned)).toBeLessThan(1000);
  await frames(page, 30);
  await expect(page.locator(".map-panel")).toContainText("burn complete");
  expect(errors).toEqual([]);
});
