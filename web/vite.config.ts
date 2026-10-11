import { defineConfig } from "vite";

export default defineConfig({
  build: { target: "es2023", sourcemap: true, chunkSizeWarningLimit: 1500 },
  // The vehicle JSON lives in ../data (shared with the physics core).
  server: { port: 5173, strictPort: true, fs: { allow: [".."] } },
});
