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
    expect(d.yaw, `${view}: arrow key`).toBeLessThan(c.yaw - 0.2); // left arrow = drag left
    expect(d.distance, `${view}: = key`).toBeLessThan(c.distance * 0.8);
  }
});

test("C cycles the camera modes: chase, free, locked, cockpit, body-locked, surface", async ({ page }) => {
  mirrorConsole(page);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.addInitScript((low) => localStorage.setItem("rocketsim.settings.v1", JSON.stringify({ version: 1, graphics: low })), LOW);
  await page.goto("/?test");
  await page.getByRole("button", { name: "New Mission" }).click();
  await page.locator("#mission-leo400").click();
  await expect(page.locator(".hud-prop")).toBeVisible();
  await frames(page, 5);

  const state = () =>
    page.evaluate(() => {
      const w = window.__rocketsim!.world!;
      const d = (a: number[], b: number[]) => Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!);
      return { mode: w.cameraMode, camToSc: d(w.frame.cam, w.frame.rsc), camR: Math.hypot(...w.frame.cam), off: w.frame.cam.map((c, i) => c - w.frame.rsc[i]!) };
    });
  const seen: string[] = [];
  for (let k = 0; k < 6; k++) {
    await page.keyboard.press("c");
    await frames(page, 60); // past the 0.6 s blend
    const st = await state();
    seen.push(st.mode);
    await expect(page.locator("#hud-focus")).toContainText(
      { free: "Free", locked: "Locked", cockpit: "Cockpit", body: "Body-locked", surface: "Surface", chase: "Chase" }[st.mode]!,
    );
    if (st.mode === "cockpit") {
      // Eye inside the crew module (vehicle data), a few metres from the CoM; the
      // interior replaces the hull.
      expect(st.camToSc).toBeLessThan(6);
      expect(await page.evaluate(() => (window.__rocketsim!.world as unknown as { interior: { root: { visible: boolean } } }).interior.root.visible)).toBe(true);
      // Console buttons: find a SAS key by ray and press it with a real mouse click.
      await page.evaluate(() => window.__rocketsim!.camera!.setAngles(0, 0.55, true));
      await frames(page, 10);
      const key = await page.evaluate(() => {
        const w = window.__rocketsim!.world as unknown as { cockpitClick(x: number, y: number): { kind: string; mode?: number } | null };
        // Centre of the first SAS key (other than the current mode) that is on the canvas.
        const hits = new Map<number, [number, number][]>();
        for (let y = -0.8; y <= 0.8; y += 0.02) for (let x = -0.8; x <= 0.8; x += 0.02) {
          const a = w.cockpitClick(x, y);
          const onCanvas = document.elementFromPoint((innerWidth / 2) * (1 + x), (innerHeight / 2) * (1 - y))?.tagName === "CANVAS";
          if (a && a.kind === "sas" && onCanvas && a.mode !== window.__rocketsim!.sim!.controls.sas) {
            if (!hits.has(a.mode!)) hits.set(a.mode!, []);
            hits.get(a.mode!)!.push([x, y]);
          }
        }
        const best = [...hits.entries()].sort((p, q) => q[1].length - p[1].length)[0];
        if (!best) return null;
        const n = best[1].length;
        const x = best[1].reduce((s, p) => s + p[0], 0) / n, y = best[1].reduce((s, p) => s + p[1], 0) / n;
        return { px: (innerWidth / 2) * (1 + x), py: (innerHeight / 2) * (1 - y), mode: best[0] };
      });
      expect(key).not.toBeNull();
      await page.mouse.click(key!.px, key!.py);
      await frames(page, 2);
      expect(await page.evaluate(() => window.__rocketsim!.sim!.controls.sas)).toBe(key!.mode);
    }
    if (st.mode === "surface") {
      // On the ground under the spacecraft (Earth: grid height + 100 m eye), 400 km below it.
      expect(st.camR).toBeGreaterThan(6.35e6);
      expect(st.camR).toBeLessThan(6.39e6);
      expect(Math.abs(st.camToSc - 400e3)).toBeLessThan(10e3);
    }
    if (st.mode === "free") {
      // Inertial: the offset does not turn with the orbit (chase would rotate with it).
      await frames(page, 30);
      const st2 = await state();
      const dd = Math.hypot(...st2.off.map((o, i) => o - st.off[i]!));
      expect(dd / st.camToSc).toBeLessThan(1e-6);
    }
  }
  expect(seen).toEqual(["free", "locked", "cockpit", "body", "surface", "chase"]);
  expect(errors).toEqual([]);
});
