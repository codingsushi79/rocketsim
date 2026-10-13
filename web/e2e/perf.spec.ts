// Frame-time measurement (opt-in: PERF=1). 2560×1440, Max preset, LEO view with Earth,
// atmosphere and the spacecraft in frame. Reports mean/p95 frame time including a GPU
// sync (1-pixel readPixels), so it measures real work rather than queueing.
import { test } from "@playwright/test";

declare const process: { env: Record<string, string | undefined> };

test.skip(!process.env.PERF, "set PERF=1 to run");
// Real GPU (the default project forces SwiftShader for CI determinism).
test.use({ viewport: { width: 2560, height: 1440 }, launchOptions: { args: ["--use-angle=metal", "--ignore-gpu-blocklist"] } });

const PRESETS = {
  max: { preset: "max", renderScale: 1, msaa: 8, bloom: true, atmosphereSteps: 64, starLimitMag: 8, textureQuality: "high", depthMode: "auto", bodySegments: 256, cloudSteps: 128, cloudScale: 1 },
  high: { preset: "high", renderScale: 1, msaa: 4, bloom: true, atmosphereSteps: 32, starLimitMag: 8, textureQuality: "high", depthMode: "auto", bodySegments: 192, cloudSteps: 64, cloudScale: 2 },
  medium: { preset: "medium", renderScale: 1, msaa: 0, bloom: true, atmosphereSteps: 16, starLimitMag: 7, textureQuality: "standard", depthMode: "auto", bodySegments: 128, cloudSteps: 32, cloudScale: 2 },
};

for (const [name, graphics] of Object.entries(PRESETS)) test(`frame time at 1440p, ${name} preset`, async ({ page }) => {
  await page.addInitScript((g) => {
    localStorage.setItem("rocketsim.settings.v1", JSON.stringify({ version: 1, graphics: g }));
  }, graphics);
  await page.goto("/?test");
  await page.getByRole("button", { name: "New Mission" }).click();
  await page.locator("#mission-leo400").click();
  await page.waitForTimeout(1500);
  const r = await page.evaluate(async () => {
    const h = window.__rocketsim!;
    const gl = (document.querySelector("canvas") as HTMLCanvasElement).getContext("webgl2")!;
    const times: number[] = [];
    // readPixels forces a full GPU sync (gl.finish is not reliable under ANGLE/Metal).
    const px = new Uint8Array(4);
    const sync = () => gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    for (let i = 0; i < 10; i++) h.stepNow(1 / 60); // warm-up
    sync();
    for (let i = 0; i < 120; i++) {
      const t0 = performance.now();
      h.stepNow(1 / 60);
      sync();
      times.push(performance.now() - t0);
    }
    times.sort((a, b) => a - b);
    const mean = times.reduce((a, b) => a + b, 0) / times.length;
    return { mean, p50: times[60], p95: times[114], canvas: [gl.drawingBufferWidth, gl.drawingBufferHeight] };
  });
  console.log(`${name}: frame time: mean ${r.mean.toFixed(2)} ms, p50 ${r.p50!.toFixed(2)} ms, p95 ${r.p95!.toFixed(2)} ms at ${r.canvas.join("×")}`);
});
