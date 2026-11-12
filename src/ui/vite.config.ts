import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The UI is built at publish time into dist/ui and served by `dominion ui`; consumers never build it.
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  base: "/",
  plugins: [react()],
  build: {
    outDir: fileURLToPath(new URL("../../dist/ui", import.meta.url)),
    emptyOutDir: true,
    sourcemap: false,
  },
  server: {
    // `npm run dev:ui` while `dominion ui --port 4555` runs in a consumer repo.
    proxy: { "/api": { target: "http://127.0.0.1:4555", ws: true, changeOrigin: false } },
  },
});
