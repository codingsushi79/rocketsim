import { test, type Page } from "@playwright/test";
const OUT = process.env.SHOT_DIR!;
async function steps(page: Page, n: number, dt: number) {
  await page.evaluate(async ([count, d]) => { const h = (window as any).__rocketsim; for (let i = 0; i < count; i++) h.stepNow(d); await h.frame(1); }, [n, dt] as const);
}
test("entry fx", async ({ page }) => {
  test.setTimeout(1_500_000);
  const errs: string[] = [];
  page.on("pageerror", (e) => errs.push(String(e)));
  page.on("console", (m) => m.type() === "error" && errs.push(m.text()));
  await page.goto("/?test");
  await page.getByRole("button", { name: "New Mission" }).click();
  await page.locator("#mission-deorbit").click();
  await page.waitForTimeout(2000);
  await page.evaluate(() => { const sim = (window as any).__rocketsim.sim; sim.stage(); sim.controls.sas = 3; sim.controls.speedRef = 1; });
  await steps(page, 120, 1 / 60);
  await page.evaluate(() => ((window as any).__rocketsim.sim.warpIndex = 7));
  for (let k = 0; k < 60; k++) { await steps(page, 5, 1 / 60); if ((await page.evaluate(() => (window as any).__rocketsim.sim.warp)) === 1) break; }
  await page.evaluate(() => ((window as any).__rocketsim.sim.warpIndex = 2));
  const shots = [1.5e5, 4e5];
  let si = 0, maxq = 0;
  for (let k = 0; k < 400 && si < shots.length; k++) {
    await steps(page, 1, 2.0);
    const t = await page.evaluate(() => { const h = (window as any).__rocketsim; const tel = h.sim.telemetry(); return { heat: tel?.heat ?? 0, out: h.sim.sim.outcome() }; });
    maxq = Math.max(maxq, t.heat);
    if (t.out !== "flying") { console.log("OUT", t.out); break; }
    if (t.heat >= shots[si]!) {
      await page.evaluate(() => ((window as any).__rocketsim.sim.warpIndex = 0));
      await steps(page, 30, 1 / 60);
      await page.screenshot({ path: `${OUT}/entry_${si}.png` });
      await page.evaluate(() => (window as any).__rocketsim.camera.setAngles(1.2, 0.1, true));
      await steps(page, 10, 1 / 60);
      await page.screenshot({ path: `${OUT}/entry_${si}_side.png` });
      console.log("SHOT", si, t.heat.toFixed(0));
      si++;
      await page.evaluate(() => ((window as any).__rocketsim.sim.warpIndex = 2));
    }
  }
  console.log("MAXQ", maxq.toFixed(0), "ERRS", JSON.stringify(errs.slice(0, 3)));
});
