// Depth precision (spec §1): a green quad 1e-3 (relative) in front of a red one at
// 2 m, 1 km, 1,000 km, 1e9 m and 6e11 m (Jupiter). Any red pixel is z-fighting.
import { expect, test, type Page } from "@playwright/test";

async function redFractions(page: Page, depth: string): Promise<{ active: string; red: number[] }> {
  await page.goto(`/?scene=depth-test&depth=${depth}`);
  await page.waitForFunction(() => window.__rocketsim?.ready === true);
  await page.evaluate(() => window.__rocketsim!.frame(3));
  return page.evaluate(() => {
    const h = window.__rocketsim!;
    const red = h.regions!.map((r) => {
      const px = h.readPixels(r.x, r.y, r.w, r.h);
      let bad = 0;
      for (let i = 0; i < px.length; i += 4) if (px[i]! > px[i + 1]!) bad++;
      return bad / (px.length / 4);
    });
    return { active: h.depth, red };
  });
}

for (const mode of ["reversed", "log"]) {
  test(`no z-fighting from 2 m to 6e11 m (${mode} depth)`, async ({ page }) => {
    const { active, red } = await redFractions(page, mode);
    test.skip(mode === "reversed" && active !== "reversed", "EXT_clip_control unavailable in this browser");
    expect(active).toBe(mode);
    for (const f of red) expect(f).toBe(0);
  });
}

test("negative control: a standard depth buffer does z-fight", async ({ page }) => {
  const { active, red } = await redFractions(page, "standard");
  expect(active).toBe("standard");
  expect(Math.max(...red)).toBeGreaterThan(0.5);
});
