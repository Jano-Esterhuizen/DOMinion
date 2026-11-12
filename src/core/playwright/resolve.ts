import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { DominionError } from "../errors";

export type PlaywrightTestModule = typeof import("@playwright/test");

export interface ResolvedPlaywright {
  module: PlaywrightTestModule;
  version: string;
  /** Directory of the @playwright/test package that was loaded. */
  packageDir: string;
  /** Absolute path of @playwright/test's cli.js (run with `node`). */
  cliPath: string;
}

/** Minimum @playwright/test version (peer dependency range in package.json). */
export const MIN_PLAYWRIGHT_VERSION = "1.56.0";

const cache = new Map<string, Promise<ResolvedPlaywright>>();

export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.-]/).slice(0, 3).map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split(/[.-]/).slice(0, 3).map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if (pa[i]! !== pb[i]!) return pa[i]! - pb[i]!;
  }
  return 0;
}

/** Finds @playwright/test as the consumer repo resolves it, falling back to DOMinion's own resolution. */
export function locatePlaywrightTest(root: string): { packageJson: string } | undefined {
  for (const base of [join(root, "package.json"), import.meta.url]) {
    try {
      const require = createRequire(base);
      return { packageJson: require.resolve("@playwright/test/package.json") };
    } catch {
      // try the next base
    }
  }
  return undefined;
}

/**
 * Loads the consumer's @playwright/test (a peer dependency), so DOMinion drives the same Playwright
 * version and browsers the consumer's tests use.
 */
export function loadPlaywright(root: string): Promise<ResolvedPlaywright> {
  let pending = cache.get(root);
  if (!pending) {
    pending = (async () => {
      const located = locatePlaywrightTest(root);
      if (!located) {
        throw new DominionError("@playwright/test is not installed in this project.", {
          code: "PLAYWRIGHT_MISSING",
          hint: "Install it with `npm install -D @playwright/test` (DOMinion needs >= 1.56), then `npx playwright install chromium`.",
        });
      }
      const packageDir = dirname(located.packageJson);
      const { version } = JSON.parse(readFileSync(located.packageJson, "utf8")) as { version: string };
      if (compareVersions(version, MIN_PLAYWRIGHT_VERSION) < 0) {
        throw new DominionError(`@playwright/test ${version} is too old; DOMinion needs ${MIN_PLAYWRIGHT_VERSION} or later.`, {
          code: "PLAYWRIGHT_TOO_OLD",
          hint: "Upgrade with `npm install -D @playwright/test@latest`.",
        });
      }
      const require = createRequire(located.packageJson);
      const entry = require.resolve("@playwright/test");
      const module = (await import(pathToFileURL(entry).href)) as PlaywrightTestModule & { default?: PlaywrightTestModule };
      const resolved = module.chromium ? module : (module.default ?? module);
      return { module: resolved, version, packageDir, cliPath: join(packageDir, "cli.js") };
    })();
    cache.set(root, pending);
    pending.catch(() => cache.delete(root));
  }
  return pending;
}

/** Wraps "browser not installed" launch failures with the command that fixes them. */
export function explainLaunchError(error: unknown): unknown {
  const message = error instanceof Error ? error.message : String(error);
  if (/Executable doesn't exist|browserType\.launch:.*(not found|install)/is.test(message)) {
    return new DominionError("Playwright's Chromium browser is not installed.", {
      code: "BROWSER_MISSING",
      cause: error,
      hint: "Run `npx playwright install chromium` in your project, then try again.",
    });
  }
  return error;
}
