// M10: quicksave / quickload restore the flight; named saves list in Load; the replay player
// plays back the flight recorder.
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

const state = (page: Page) =>
  page.evaluate(() => {
    const s = window.__rocketsim!.sim!.sim;
    return { t: s.epochTdb(), sc: Array.from(s.spacecraft()) };
  });

test("quicksave, quickload, save list and replay", async ({ page }) => {
  test.setTimeout(240_000);
  mirrorConsole(page);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.addInitScript((low) => {
    localStorage.setItem("rocketsim.settings.v1", JSON.stringify({ version: 1, graphics: low }));
    localStorage.removeItem("rocketsim.saves.v1");
  }, LOW);
  await page.goto("/?test");
  await page.getByRole("button", { name: "New Mission" }).click();
  await page.locator("#mission-leo400").click();
  await expect(page.locator(".hud-prop")).toBeVisible();
  // A short burn, then quicksave.
  await page.evaluate(() => (window.__rocketsim!.sim!.controls.throttle = 1));
  await steps(page, 120, 1 / 20);
  await page.evaluate(() => (window.__rocketsim!.sim!.controls.throttle = 0));
  await steps(page, 20, 1 / 20);
  await page.keyboard.press("F5");
  await steps(page, 2, 1 / 60);
  const saved = await state(page);
  // Change the flight, then quickload.
  await page.evaluate(() => (window.__rocketsim!.sim!.controls.throttle = 1));
  await steps(page, 100, 1 / 20);
  await page.keyboard.press("F9");
  await expect(page.locator(".hud-warn")).toContainText("Loaded");
  const loaded = await state(page);
  // Against the save file itself: the loaded flight continues from the saved state, so after
  // the Δt of real frames since loading it is at r_save + v·Δt (to well under a km).
  const save = await page.evaluate(() => JSON.parse(JSON.parse(localStorage.getItem("rocketsim.saves.v1")!)[0].sim).flight);
  const dt = loaded.t - save.epoch_tdb;
  expect(dt).toBeGreaterThanOrEqual(0);
  expect(dt).toBeLessThan(5);
  const miss = Math.hypot(...[0, 1, 2].map((k) => loaded.sc[1 + k]! - (save.r[k] + save.v[k] * dt)));
  expect(miss).toBeLessThan(1000);
  void saved;
  await expect(page.locator(".hud-warn")).toContainText("Loaded");
  // Named save from the pause menu, visible in Load.
  await page.keyboard.press("Escape");
  await page.locator("#btn-save").click();
  await page.locator("#save-name").fill("Test save");
  await page.locator("#btn-save-confirm").click();
  await page.locator("#btn-load-pause").click();
  await expect(page.locator(".save-row")).toHaveCount(2);
  await expect(page.locator(".save-row").first()).toContainText("Test save");
  await page.getByRole("button", { name: "Back" }).click();
  // Replay.
  await page.locator("#btn-replay").click();
  await expect(page.locator(".replay-bar")).toBeVisible();
  await steps(page, 30, 1 / 30);
  await expect(page.locator(".replay-time")).toContainText("T+");
  await page.getByRole("button", { name: "Exit replay" }).click();
  await expect(page.locator(".replay-bar")).toBeHidden();
  expect(errors).toEqual([]);
});
