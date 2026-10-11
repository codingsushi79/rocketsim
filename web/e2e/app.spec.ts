// Smoke test: main menu → mission → HUD shows a 400 km orbit; no page errors.
import { expect, test } from "@playwright/test";
import { mirrorConsole } from "./logging";

test("main menu to LEO mission", async ({ page }) => {
  mirrorConsole(page);
  const errors: string[] = [];
  const missing: string[] = [];
  // High-resolution textures are optional (scripts/fetch-assets.sh); their 404s are expected.
  const optional = /assets\/(earth_day_5400|earth_night_8192|milkyway_4096)\.jpg$/;
  page.on("response", (r) => r.status() === 404 && !optional.test(r.url()) && missing.push(r.url()));
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => m.type() === "error" && !m.text().startsWith("Failed to load resource") && errors.push(m.text()));
  await page.goto("/?test");
  await page.getByRole("button", { name: "New Mission" }).click();
  await page.locator("#mission-leo400").click();
  await expect(page.locator("#hud")).toBeVisible();
  await expect(page.locator("#hud-alt")).toContainText("km");
  await expect(page.locator("#hud-geo")).toContainText("km");
  const alt = parseFloat((await page.locator("#hud-alt").textContent()) ?? "0");
  expect(alt).toBeGreaterThan(380);
  expect(alt).toBeLessThan(420);
  await expect(page.locator("#hud-per")).toContainText("01:32");
  // Settings opens from the pause menu and returns.
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Settings" }).click();
  await expect(page.locator("#settings")).toBeVisible();
  await page.locator("#btn-settings-back").click();
  expect(errors).toEqual([]);
  expect(missing).toEqual([]);
});
