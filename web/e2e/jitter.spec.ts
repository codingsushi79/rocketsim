// Floating origin (spec §6): spacecraft in Saturn orbit (~1.4e12 m from the SSB),
// camera 2 m from the hull. Consecutive frames must be identical where the hull is.
import { expect, test } from "@playwright/test";
import { mirrorConsole } from "./logging";

test("no jitter 2 m from the spacecraft near Saturn", async ({ page }) => {
  mirrorConsole(page);
  await page.goto("/?scene=saturn-jitter");
  await page.waitForFunction(() => window.__rocketsim?.ready === true, undefined, { timeout: 90_000 });
  expect(await page.evaluate(() => window.__rocketsim!.hudText!())).toContain("SATURN");
  const result = await page.evaluate(async () => {
    const h = window.__rocketsim!;
    const W = document.querySelector("canvas")!.width, H = document.querySelector("canvas")!.height;
    const box = { x: Math.round(W * 0.4), y: Math.round(H * 0.4), w: Math.round(W * 0.2), h: Math.round(H * 0.2) };
    let prev: number[] | null = null;
    let maxDiff = 0, lit = 0;
    for (let k = 0; k < 12; k++) {
      await h.frame(1);
      const px = h.readPixels(box.x, box.y, box.w, box.h);
      if (prev) for (let i = 0; i < px.length; i++) maxDiff = Math.max(maxDiff, Math.abs(px[i]! - prev[i]!));
      prev = px;
    }
    for (let i = 0; i < prev!.length; i += 4) if (prev![i]! + prev![i + 1]! + prev![i + 2]! > 30) lit++;
    return { maxDiff, litFraction: lit / (prev!.length / 4) };
  });
  // The hull fills the box (the test isn't vacuous) and doesn't move between frames.
  expect(result.litFraction).toBeGreaterThan(0.5);
  expect(result.maxDiff).toBeLessThanOrEqual(2);
});
