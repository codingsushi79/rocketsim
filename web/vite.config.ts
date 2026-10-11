import { defineConfig } from "vite";

export default defineConfig({
  build: { target: "es2023", sourcemap: true, chunkSizeWarningLimit: 1500 },
  server: { port: 5173, strictPort: true },
});
