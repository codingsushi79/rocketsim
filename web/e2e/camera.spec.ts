// Camera controls reach the canvas through the HUD layers: mouse drag orbits, the wheel
// zooms, arrow keys and = / − do the same, in flight and in the map view.
import { expect, test, type Page } from "@playwright/test";
import { mirrorConsole } from "./logging";

const LOW = { preset: "low", depthMode: "auto", renderScale: 0.75, msaa: 0, bloom: false, atmosphereSteps: 8, starLimitMag: 6, textureQuality: "standard", bodySegments: 64, cloudSteps: 0 };

async function frames(page: Page, n: number): Promise<void> {
  await page.evaluate(async (count) => {
    const h = window.__rocketsim!;
    for (let i = 0; i < count; i++) h.stepNow(1 / 60);
    await h.frame(1);
  }, n);
}

const cam = (page: Page) =>
  page.evaluate(() => {
    const c = window.__rocketsim!.camera as unknown as { yaw: number; pitch: number; distance: number };
    return { yaw: c.yaw, pitch: c.pitch, distance: c.distance };
  });

test("mouse and keyboard move the camera in flight and map view", async ({ page }) => {
  mirrorConsole(page);
  await page.addInitScript((low) => localStorage.setItem("rocketsim.settings.v1", JSON.stringify({ version: 1, graphics: low })), LOW);
  await page.goto("/?test");
  await page.getByRole("button", { name: "New Mission" }).click();
  await page.locator("#mission-leo400").click();
  await expect(page.locator(".hud-prop")).toBeVisible();
  await frames(page, 5);

  for (const view of ["flight", "map"]) {
    if (view === "map") {
      await page.keyboard.press("m");
      await frames(page, 5);
    }
    // Drag in empty sky above the centre (no panel there).
    const a = await cam(page);
    await page.mouse.move(640, 260);
    await page.mouse.down();
    await page.mouse.move(760, 300, { steps: 8 });
    await page.mouse.up();
    await frames(page, 30);
    const b = await cam(page);
    expect(Math.abs(b.yaw - a.yaw), `${view}: drag yaw`).toBeGreaterThan(0.2);
    expect(Math.abs(b.pitch - a.pitch), `${view}: drag pitch`).toBeGreaterThan(0.05);
    // Wheel zooms out.
    await page.mouse.move(640, 260);
    await page.mouse.wheel(0, 400);
    await frames(page, 30);
    const c = await cam(page);
    expect(c.distance, `${view}: wheel`).toBeGreaterThan(b.distance * 1.3);
    // Keys: arrow left rotates, = zooms in.
    await page.keyboard.down("ArrowLeft");
    await page.keyboard.down("Equal");
    await frames(page, 30);
    await page.keyboard.up("ArrowLeft");
    await page.keyboard.up("Equal");
    await frames(page, 20);
    const d = await cam(page);
    expect(d.yaw, `${view}: arrow key`).toBeLessThan(c.yaw - 0.2);
    expect(d.distance, `${view}: = key`).toBeLessThan(c.distance * 0.8);
  }
});
