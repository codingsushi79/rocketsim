import { defineConfig, devices } from "@playwright/test";

declare const process: { env: Record<string, string | undefined> };

// Rendering tests run the real app in headless Chromium (WebGL2 via SwiftShader in CI).
export default defineConfig({
  testDir: "e2e",
  timeout: 120_000,
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:5174",
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 1,
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        // Locally, PW_CHANNEL=chrome uses the installed Google Chrome (real GPU).
        channel: process.env.PW_CHANNEL,
        launchOptions: { args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] },
      },
    },
  ],
  webServer: {
    command: "npx vite --port 5174 --strictPort",
    url: "http://localhost:5174",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
