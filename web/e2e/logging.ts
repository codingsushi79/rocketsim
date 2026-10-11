// Mirror the page's console and errors into the test output (diagnostics in CI).
import type { Page } from "@playwright/test";

export function mirrorConsole(page: Page): void {
  page.on("console", (m) => console.log(`[page:${m.type()}] ${m.text()}`));
  page.on("pageerror", (e) => console.log(`[page:exception] ${e.message}`));
  page.on("requestfailed", (r) => console.log(`[page:requestfailed] ${r.url()} ${r.failure()?.errorText ?? ""}`));
}
