// Atmospheric entry: high warp stops at the entry interface; entering with the service
// module attached destroys it (heat limit) with the explosion and the outcome overlay;
// Restart brings the mission back.
import { expect, test, type Page } from "@playwright/test";
import { mirrorConsole } from "./logging";

const LOW = { preset: "low", depthMode: "auto", renderScale: 0.75, msaa: 0, bloom: false, atmosphereSteps: 8, starLimitMag: 6, textureQuality: "standard", bodySegments: 64, cloudSteps: 0 };

async function steps(page: Page, n: number, dt: number): Promise<void> {
  await page.evaluate(
    async ([count, d]) => {
      const h = window.__rocketsim!;
      for (let i = 0; i < count; i++) h.stepNow(d);
      await h.frame(1);
    },
    [n, dt] as const,
  );
}

test("entry: warp stops at the interface, burn-up, explosion, restart", async ({ page }) => {
  test.setTimeout(300_000);
  mirrorConsole(page);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.addInitScript((low) => localStorage.setItem("rocketsim.settings.v1", JSON.stringify({ version: 1, graphics: low })), LOW);
  await page.goto("/?test");
  await page.getByRole("button", { name: "New Mission" }).click();
  await page.locator("#mission-deorbit").click();
  await expect(page.locator(".hud-prop")).toBeVisible();

  await page.evaluate(() => (window.__rocketsim!.sim!.warpIndex = 7)); // 100,000×
  let warp = 0;
  for (let k = 0; k < 60; k++) {
    await steps(page, 5, 1 / 60);
    warp = await page.evaluate(() => window.__rocketsim!.sim!.warp);
    if (warp === 1) break;
  }
  expect(warp).toBe(1);
  const info = await page.evaluate(() => Array.from(window.__rocketsim!.sim!.sim.orbitInfo()));
  expect(info[9]!).toBeGreaterThan(115e3);
  expect(info[9]!).toBeLessThan(125e3);
  await expect(page.locator(".hud-warn")).toContainText("Entering the atmosphere");

  // 10× through entry until the service module's heat limit is exceeded.
  await page.evaluate(() => (window.__rocketsim!.sim!.warpIndex = 2));
  let outcome = "flying";
  for (let k = 0; k < 200 && outcome === "flying"; k++) {
    await steps(page, 10, 0.25);
    outcome = await page.evaluate(() => window.__rocketsim!.sim!.sim.outcome());
  }
  expect(outcome).toBe("burnedup");
  await steps(page, 2, 1 / 60);
  await expect(page.locator("#outcome")).toBeVisible();
  await expect(page.locator("#outcome")).toContainText("burned up");

  await page.locator("#btn-restart").click();
  await steps(page, 5, 1 / 60);
  expect(await page.evaluate(() => window.__rocketsim!.sim!.sim.outcome())).toBe("flying");
  await expect(page.locator("#outcome")).toBeHidden();
  expect(errors).toEqual([]);
});
