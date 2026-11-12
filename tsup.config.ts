import { cpSync, existsSync } from "node:fs";
import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    setup: "src/setup.ts",
    "cli/index": "src/cli/index.ts",
  },
  format: ["esm"],
  platform: "node",
  target: "node20",
  dts: { entry: { index: "src/index.ts", setup: "src/setup.ts" } },
  sourcemap: true,
  // Clean only tsup's own output; dist/ui is built separately by Vite.
  clean: ["**/*", "!ui", "!ui/**"],
  splitting: true,
  treeshake: true,
  // Default prompts ship inside the package so consumers can read and override them.
  onSuccess: async () => {
    if (existsSync("src/prompts")) {
      cpSync("src/prompts", "dist/prompts", { recursive: true });
    }
  },
});
