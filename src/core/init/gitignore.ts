import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Paths DOMinion requires to be gitignored in the consumer repo. Directories end with "/". */
export const REQUIRED_GITIGNORE_ENTRIES = [".env.local", ".auth/", ".dominion/"] as const;

function globToRegExp(glob: string): RegExp {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]!;
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        out += ".*";
        i++;
      } else {
        out += "[^/]*";
      }
    } else if (ch === "?") {
      out += "[^/]";
    } else if (ch === "[") {
      const close = glob.indexOf("]", i + 1);
      if (close === -1) {
        out += "\\[";
      } else {
        out += `[${glob.slice(i + 1, close).replace(/^!/, "^").replace(/\\/g, "\\\\")}]`;
        i = close;
      }
    } else if ("\\^$.|+(){}".includes(ch)) {
      out += `\\${ch}`;
    } else {
      out += ch;
    }
  }
  return new RegExp(`^${out}$`);
}

/**
 * Decides whether a root-level entry (".env.local" or a directory like ".auth/") is ignored by
 * the given .gitignore lines. Implements the subset of gitignore semantics that matters for
 * root-level paths: comments, negation (last match wins), leading "/" anchors, trailing "/"
 * directory-only patterns, "dir/*" and "dir/**" content patterns, and * ? ** [] globs.
 */
export function isIgnored(lines: readonly string[], entry: string): boolean {
  const isDir = entry.endsWith("/");
  const name = entry.replace(/\/+$/, "");
  let ignored = false;
  for (const rawLine of lines) {
    let line = rawLine.replace(/\s+$/, "");
    if (!line || line.startsWith("#")) continue;
    let negate = false;
    if (line.startsWith("!")) {
      negate = true;
      line = line.slice(1);
    }
    if (line.startsWith("\\")) line = line.slice(1);
    line = line.replace(/^\//, "");
    if (!line) continue;

    let matched = false;
    // "dir/*" and "dir/**" ignore everything inside the directory, which covers our use.
    const contents = /^(.*)\/\*\*?$/.exec(line);
    if (isDir && contents && globToRegExp(contents[1]!).test(name)) {
      matched = true;
    } else {
      const dirOnly = line.endsWith("/");
      const pattern = line.replace(/\/+$/, "");
      // Patterns containing "/" in the middle are anchored; our entries are root-level, so the
      // only anchored patterns that can match are single-segment ones.
      if (!pattern.includes("/") || !pattern.replace(/^\*\*\//, "").includes("/")) {
        const segment = pattern.replace(/^\*\*\//, "");
        if ((!dirOnly || isDir) && globToRegExp(segment).test(name)) matched = true;
      }
    }
    if (matched) ignored = !negate;
  }
  return ignored;
}

export interface GitignoreResult {
  path: string;
  created: boolean;
  added: string[];
}

/** Appends any missing required entries to <root>/.gitignore, creating it if needed. */
export function ensureGitignore(root: string, entries: readonly string[] = REQUIRED_GITIGNORE_ENTRIES): GitignoreResult {
  const path = join(root, ".gitignore");
  const exists = existsSync(path);
  const current = exists ? readFileSync(path, "utf8") : "";
  const lines = current.split(/\r?\n/);
  const missing = entries.filter((entry) => !isIgnored(lines, entry));
  if (missing.length === 0) return { path, created: false, added: [] };

  const eol = current.includes("\r\n") ? "\r\n" : "\n";
  let next = current;
  if (next.length > 0 && !next.endsWith("\n")) next += eol;
  if (next.length > 0) next += eol;
  next += `# DOMinion: local credentials, saved sessions and run artifacts${eol}`;
  next += missing.join(eol) + eol;
  writeFileSync(path, next, "utf8");
  return { path, created: !exists, added: [...missing] };
}
