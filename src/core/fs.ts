import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

/** Converts a path to forward slashes, for config files, plans, events and the UI. */
export function toPosix(p: string): string {
  return p.split(sep).join("/").replace(/\\/g, "/");
}

/** Path of `target` relative to `root`, with forward slashes. */
export function relativePosix(root: string, target: string): string {
  return toPosix(relative(root, target)) || ".";
}

/**
 * True when `target` is `root` or lives inside it. Resolves `..` segments and compares
 * case-insensitively on Windows, where the file system is case-insensitive.
 */
export function isInside(root: string, target: string): boolean {
  const absRoot = resolve(root);
  const absTarget = resolve(absRoot, target);
  const rel = relative(absRoot, absTarget);
  if (rel === "") return true;
  if (isAbsolute(rel)) return false; // different drive on Windows
  const first = rel.split(sep)[0] ?? "";
  return first !== "..";
}

export function readTextIfExists(path: string): string | undefined {
  return existsSync(path) ? readFileSync(path, "utf8") : undefined;
}

/** Creates the directory (and parents). Returns true if it did not exist before. */
export function ensureDir(path: string): boolean {
  if (existsSync(path)) return false;
  mkdirSync(path, { recursive: true });
  return true;
}

/**
 * Writes a file only if nothing exists at that path. Uses the exclusive "wx" flag so an existing
 * file is never overwritten, even under a race.
 */
export function writeFileIfMissing(path: string, content: string): "created" | "skipped" {
  if (existsSync(path)) return "skipped";
  mkdirSync(dirname(path), { recursive: true });
  try {
    writeFileSync(path, content, { encoding: "utf8", flag: "wx" });
    return "created";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return "skipped";
    throw error;
  }
}

/** Writes via a temporary file and rename so readers never observe a half-written file. */
export function writeFileAtomic(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, content, "utf8");
  try {
    // On Windows a virus scanner or indexer can briefly lock the target; retry before giving up.
    for (let attempt = 0; ; attempt++) {
      try {
        renameSync(tmp, path);
        return;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code ?? "";
        if (!["EPERM", "EACCES", "EBUSY"].includes(code) || attempt >= 20) break;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25 * (attempt + 1));
      }
    }
    writeFileSync(path, content, "utf8");
  } finally {
    if (existsSync(tmp)) rmSync(tmp, { force: true });
  }
}
