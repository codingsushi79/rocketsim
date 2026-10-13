// M9: the transfer planner. Lunar flyby: porkchop → plan → departure + midcourse nodes
// corrected on the n-body propagator, with the flyby periapsis on target.
import { expect, test, type Page } from "@playwright/test";
import { mirrorConsole } from "./logging";

const LOW = { preset: "low", depthMode: "auto", renderScale: 0.75, msaa: 0, bloom: false, atmosphereSteps: 8, starLimitMag: 6, textureQuality: "standard", bodySegments: 64, cloudSteps: 0 };
const OUT = process.env.SHOT_DIR;

async function frames(page: Page, n: number): Promise<void> {
  await page.evaluate(async (count) => {
    const h = window.__rocketsim!;
    for (let i = 0; i < count; i++) h.stepNow(1 / 60);
    await h.frame(1);
  }, n);
}

test("lunar flyby: porkchop, plan and n-body correction", async ({ page }) => {
  test.setTimeout(300_000);
  mirrorConsole(page);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.addInitScript((low) => localStorage.setItem("rocketsim.settings.v1", JSON.stringify({ version: 1, graphics: low })), LOW);
  await page.goto("/?test");
  await page.getByRole("button", { name: "New Mission" }).click();
  await page.locator("#mission-lunar-flyby").click();
  await expect(page.locator(".hud-prop")).toBeVisible();
  await frames(page, 5);
  await page.keyboard.press("m");
  await frames(page, 5);
  await expect(page.locator(".transfer-panel")).toBeVisible();
  await expect(page.locator(".transfer-panel select")).toHaveValue("301");
  await page.locator("#btn-porkchop").click();
  await expect(page.locator(".transfer-panel .note")).toContainText("Lambert arcs", { timeout: 30_000 });
  const best = await page.locator(".transfer-info .row").nth(2).locator("span").nth(1).textContent();
  const dv = Number(best!.replace(/[^0-9.]/g, ""));
  // TLI from LEO ≈ 3.1 km/s.
  expect(dv).toBeGreaterThan(3000);
  expect(dv).toBeLessThan(3300);
  await page.locator("#btn-plan-transfer").click();
  await expect(page.locator(".transfer-panel .note")).toContainText("Planned", { timeout: 120_000 });
  const plan = await page.evaluate(() => JSON.parse(window.__rocketsim!.sim!.sim.planJson()));
  expect(plan.nodes.length).toBe(2);
  expect(plan.nodes[0].dv).toBeGreaterThan(3000);
  expect(plan.nodes[1].dv).toBeLessThan(100);
  const note = await page.locator(".transfer-panel .note").textContent();
  const miss = Number(/within ([0-9.]+) km/.exec(note!)![1]);
  expect(miss).toBeLessThan(20);
  if (OUT) await page.screenshot({ path: `${OUT}/planner_moon.png` });
  expect(errors).toEqual([]);
});
