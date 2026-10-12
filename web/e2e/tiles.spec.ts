// M7: Google Photorealistic 3D Tiles compliance, against a fixture tileset served in
// place of tile.googleapis.com (no real key or network needed):
// - without a key nothing is requested from Google;
// - with a key: the key and session ride on the requests, the displayed tile's
//   copyright is shown, the official logo is 16–19 px tall with its accessibility
//   label, nothing overlaps it, and the hybrid-data disclosure is present.
import { expect, test, type Page, type Route } from "@playwright/test";
import { mirrorConsole } from "./logging";

const COPYRIGHT = "Data FixtureCo; Imagery TestSat";
const LOW = { preset: "low", depthMode: "auto", renderScale: 0.75, msaa: 0, bloom: false, atmosphereSteps: 8, starLimitMag: 6, textureQuality: "standard", bodySegments: 64, cloudSteps: 0 };

/** A minimal glTF 2.0 binary: one triangle, with `asset.copyright`. */
function glb(copyright: string): Buffer {
  const pos = new Float32Array([6.4e6, 0, 0, 6.4e6, 1e5, 0, 6.4e6, 0, 1e5]);
  const bin = Buffer.from(pos.buffer);
  const json = {
    asset: { version: "2.0", copyright },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: "VEC3", min: [6.4e6, 0, 0], max: [6.4e6, 1e5, 1e5] }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: bin.length }],
    buffers: [{ byteLength: bin.length }],
  };
  let j = Buffer.from(JSON.stringify(json));
  j = Buffer.concat([j, Buffer.alloc((4 - (j.length % 4)) % 4, 0x20)]);
  const total = 12 + 8 + j.length + 8 + bin.length;
  const head = Buffer.alloc(12);
  head.writeUInt32LE(0x46546c67, 0);
  head.writeUInt32LE(2, 4);
  head.writeUInt32LE(total, 8);
  const jh = Buffer.alloc(8);
  jh.writeUInt32LE(j.length, 0);
  jh.writeUInt32LE(0x4e4f534a, 4);
  const bh = Buffer.alloc(8);
  bh.writeUInt32LE(bin.length, 0);
  bh.writeUInt32LE(0x004e4942, 4);
  return Buffer.concat([head, jh, j, bh, bin]);
}

const ROOT = {
  asset: { version: "1.0" },
  geometricError: 1e7,
  root: {
    boundingVolume: { sphere: [0, 0, 0, 7e6] },
    geometricError: 1e6,
    refine: "REPLACE",
    children: [{ boundingVolume: { sphere: [0, 0, 0, 7e6] }, geometricError: 0, content: { uri: "/v1/3dtiles/datasets/fixture/tile.glb?session=FIXTURE-SESSION" } }],
  },
};

async function start(page: Page, earth: object | null): Promise<void> {
  await page.addInitScript(
    ([low, e]) => localStorage.setItem("rocketsim.settings.v1", JSON.stringify({ version: 1, graphics: low, ...(e ? { earth: e } : {}) })),
    [LOW, earth] as const,
  );
  await page.goto("/?test");
  await page.getByRole("button", { name: "New Mission" }).click();
  await page.locator("#mission-leo400").click();
  await expect(page.locator(".hud-prop")).toBeVisible();
}

async function frames(page: Page, n: number): Promise<void> {
  await page.evaluate(async (count) => {
    const h = window.__rocketsim!;
    for (let i = 0; i < count; i++) h.stepNow(1 / 60);
    await h.frame(1);
  }, n);
}

test("without a key nothing is requested from Google", async ({ page }) => {
  mirrorConsole(page);
  const google: string[] = [];
  page.on("request", (r) => /googleapis\.com/.test(r.url()) && google.push(r.url()));
  await start(page, { tiles: true, apiKey: "", tileError: 12 });
  await frames(page, 60);
  expect(google).toEqual([]);
  await expect(page.locator("#google-attrib")).toBeHidden();
});

test("tiles: key, session, attribution, logo and disclosure", async ({ page }) => {
  mirrorConsole(page);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  const requests: string[] = [];
  await page.route(/tile\.googleapis\.com/, async (route: Route) => {
    const url = route.request().url();
    requests.push(url);
    if (url.includes("root.json")) return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(ROOT) });
    if (url.includes("tile.glb")) return route.fulfill({ status: 200, contentType: "model/gltf-binary", body: glb(COPYRIGHT) });
    return route.fulfill({ status: 404, body: "" });
  });
  await start(page, { tiles: true, apiKey: "TEST-KEY-123", tileError: 12 });
  for (let k = 0; k < 40; k++) {
    await frames(page, 10);
    if (await page.locator("#google-attrib").isVisible()) break;
  }
  await expect(page.locator("#google-attrib")).toBeVisible();
  await expect(page.locator("#google-data")).toHaveText(COPYRIGHT);
  await expect(page.locator(".google-hybrid")).toContainText("Google Maps");
  // Key on every Google request; the session from the root rides on tile requests.
  expect(requests.length).toBeGreaterThanOrEqual(2);
  for (const u of requests) expect(new URL(u).searchParams.get("key")).toBe("TEST-KEY-123");
  expect(requests.some((u) => u.includes("tile.glb") && new URL(u).searchParams.get("session") === "FIXTURE-SESSION")).toBe(true);
  // Logo: official asset, 16–19 px tall, labelled, and not overlapped by any HUD panel.
  const logo = page.locator(".google-logo");
  await expect(logo).toHaveAttribute("aria-label", "Google Maps");
  await expect(logo).toHaveAttribute("src", /GoogleMaps_Logo_WithDarkOutline\.svg$/);
  const box = (await logo.boundingBox())!;
  expect(box.height).toBeGreaterThanOrEqual(16);
  expect(box.height).toBeLessThanOrEqual(19);
  const overlaps = await page.evaluate((b) => {
    const hit: string[] = [];
    for (const sel of [".hud-orbit", ".hud-prop", ".hud-navball", ".hud-sas", ".hud-top > div"]) {
      for (const el of document.querySelectorAll<HTMLElement>(sel)) {
        const r = el.getBoundingClientRect();
        if (r.width === 0) continue;
        if (r.left < b.x + b.width && r.right > b.x && r.top < b.y + b.height && r.bottom > b.y) hit.push(sel);
      }
    }
    return hit;
  }, box);
  expect(overlaps).toEqual([]);
  expect(errors).toEqual([]);
});
