import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { relativePosix } from "../fs";

const TEXT_EXTENSIONS = /\.(ts|tsx|js|jsx|mjs|cjs|mts|cts|md|json)$/i;
const MAX_FILE_BYTES = 1_000_000;

export interface FileState {
  hash: string;
  content: string;
}

/** Repo-relative path -> content for every text file under the given folders. */
export type Snapshot = Map<string, FileState>;

export function snapshotFiles(root: string, dirs: readonly string[]): Snapshot {
  const snapshot: Snapshot = new Map();
  const walk = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name.startsWith(".git")) continue;
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (TEXT_EXTENSIONS.test(entry.name) && statSync(abs).size <= MAX_FILE_BYTES) {
        const content = readFileSync(abs, "utf8");
        snapshot.set(relativePosix(root, abs), { hash: createHash("sha256").update(content).digest("hex"), content });
      }
    }
  };
  for (const dir of new Set(dirs)) walk(dir);
  return snapshot;
}

export interface SnapshotDiff {
  added: string[];
  modified: string[];
  removed: string[];
}

export function diffSnapshots(before: Snapshot, after: Snapshot): SnapshotDiff {
  const diff: SnapshotDiff = { added: [], modified: [], removed: [] };
  for (const [path, state] of after) {
    const prev = before.get(path);
    if (!prev) diff.added.push(path);
    else if (prev.hash !== state.hash) diff.modified.push(path);
  }
  for (const path of before.keys()) if (!after.has(path)) diff.removed.push(path);
  return diff;
}

/** Stores the pre-run copy of a modified file under <runDir>/before/<path> for diffs. */
export function saveBeforeCopy(runDir: string, relPath: string, content: string): string {
  const rel = `before/${relPath}`;
  const abs = join(runDir, ...rel.split("/"));
  mkdirSync(dirname(abs), { recursive: true });
  if (!existsSync(abs)) writeFileSync(abs, content, "utf8");
  return rel;
}
