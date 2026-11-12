import { cpSync, existsSync } from "node:fs";
import { defineConfig } from "tsup";

export default defineConfig([
  {
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
    // Clean only tsup's own ESM output; dist/ui is built by Vite, and the CommonJS build below
    // runs at the same time.
    clean: ["**/*", "!ui", "!ui/**", "!*.cjs", "!*.cjs.map", "!*.d.cts"],
    splitting: true,
    treeshake: true,
    // Default prompts ship inside the package so consumers can read and override them.
    onSuccess: async () => {
      if (existsSync("src/prompts")) {
        cpSync("src/prompts", "dist/prompts", { recursive: true });
      }
    },
  },
  {
    // CommonJS builds of the public entry points. Projects without "type": "module" (the default for
    // `npm init playwright`) compile their tests and playwright.config.ts to require() calls, and
    // the generated dominion.setup.ts imports `<package>/setup`.
    entry: { index: "src/index.ts", setup: "src/setup.ts" },
    format: ["cjs"],
    platform: "node",
    target: "node20",
    dts: true,
    sourcemap: true,
    shims: true,
    splitting: false,
    treeshake: true,
    clean: false,
  },
]);
