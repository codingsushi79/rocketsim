import { test } from "@playwright/test";
const OUT = process.env.SHOT_DIR!;
test("sun shots", async ({ page }) => {
  test.setTimeout(300_000);
  const errs: string[] = [];
  page.on("pageerror", (e) => errs.push(String(e)));
  page.on("console", (m) => m.type() === "error" && errs.push(m.text()));
  await page.goto("/?test");
  await page.getByRole("button", { name: "New Mission" }).click();
  await page.locator("#mission-leo400").click();
  await page.waitForTimeout(3000);
  await page.addStyleTag({ content: "#ui { display: none !important; }" });
  await page.keyboard.press("c");
  const aim = async (dyaw: number, dpitch: number, dist: number) =>
    page.evaluate(([dyaw, dpitch, dist]) => {
      const h = (window as any).__rocketsim;
      const s = h.sim.sim;
      const sc = Array.from(s.spacecraft()) as number[];
      const sun = Array.from(s.relativeState(10, sc[0])) as number[];
      let u = [sun[0]! - sc[1]!, sun[1]! - sc[2]!, sun[2]! - sc[3]!];
      const n = Math.hypot(u[0]!, u[1]!, u[2]!); u = u.map((x) => x / n);
      const eps = (84381.406 / 3600) * (Math.PI / 180);
      const up = [0, -Math.sin(eps), Math.cos(eps)], fwd = [1, 0, 0];
      const cr = (a: number[], b: number[]) => [a[1]! * b[2]! - a[2]! * b[1]!, a[2]! * b[0]! - a[0]! * b[2]!, a[0]! * b[1]! - a[1]! * b[0]!];
      const nz = (a: number[]) => { const l = Math.hypot(a[0]!, a[1]!, a[2]!); return a.map((x) => x / l); };
      const right = nz(cr(fwd, up)), f = nz(cr(up, right));
      const o = u.map((x) => -x);
      const dt = (a: number[], b: number[]) => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
      h.camera.setAngles(Math.atan2(dt(o, right), dt(o, f)) + dyaw!, Math.asin(dt(o, up)) + dpitch!, true);
      h.camera.setDistance(dist!, true);
    }, [dyaw, dpitch, dist]);
  for (const [name, a, b, d] of [["off8", 0.14, 0.05, 25], ["off15", 0.26, 0.1, 25], ["off30", 0.5, 0.12, 25]] as [string, number, number, number][]) {
    await aim(a, b, d);
    await page.waitForTimeout(3000);
    await page.screenshot({ path: `${OUT}/sun_${name}.png` });
  }
  console.log("ERRS", JSON.stringify(errs));
});
