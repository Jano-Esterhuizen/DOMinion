import { existsSync, readFileSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Locates this package's own files at runtime. The package name is read from package.json
 * rather than hardcoded, so renaming the package (an open decision in the spec) only means
 * editing package.json.
 */

interface PackageJson {
  name: string;
  version: string;
}

let cachedRoot: string | undefined;
let cachedPkg: PackageJson | undefined;

/** Directory that contains this package's package.json (works from src/ in dev and dist/ when published). */
export function packageRoot(): string {
  if (cachedRoot) return cachedRoot;
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (existsSync(join(dir, "package.json"))) {
      cachedRoot = dir;
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) throw new Error("DOMinion could not locate its own package.json");
    dir = parent;
  }
}

function readOwnPackageJson(): PackageJson {
  if (cachedPkg) return cachedPkg;
  const raw = JSON.parse(readFileSync(join(packageRoot(), "package.json"), "utf8")) as Partial<PackageJson>;
  cachedPkg = { name: raw.name ?? "dominion", version: raw.version ?? "0.0.0" };
  return cachedPkg;
}

/** npm package name, e.g. "@yourorg/dominion". Used in templates and generated imports. */
export function packageName(): string {
  return readOwnPackageJson().name;
}

export function packageVersion(): string {
  return readOwnPackageJson().version;
}

/** True when running from the built dist/ output rather than from TypeScript sources. */
export function runningFromDist(): boolean {
  return fileURLToPath(import.meta.url).includes(`${sep}dist${sep}`);
}

export function templatesDir(): string {
  return join(packageRoot(), "templates");
}

/** Default agent prompts: dist/prompts when published, src/prompts during development. */
export function defaultPromptsDir(): string {
  const dist = join(packageRoot(), "dist", "prompts");
  if (runningFromDist() && existsSync(dist)) return dist;
  return join(packageRoot(), "src", "prompts");
}
