import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, resolve, sep } from "node:path";
import type { ResolvedEnvironment } from "../config/resolve";
import type { AgentName } from "../events";
import { isInside, relativePosix } from "../fs";
import { MCP_TOOL_PREFIX } from "../mcp";
import type { Redactor } from "../redact";

/**
 * Tool policy for one agent call. Enforced in code by a PreToolUse hook (which runs for every tool
 * call, including reads Claude Code would otherwise auto-allow) and again by canUseTool.
 */
export interface ToolPolicy {
  agent: AgentName;
  /** Consumer repo root (the agent's cwd). */
  root: string;
  /** Built-in tools available to the agent, e.g. ["Read", "Write"]. */
  builtinTools: string[];
  /** Playwright MCP tools (bare names) the agent may call. */
  mcpTools: string[];
  /** Absolute files or folders the agent may read (Read, Glob, Grep). Write roots are readable too. */
  readRoots: string[];
  /** Absolute files or folders the agent may create or edit. */
  writeRoots: string[];
  /** Allowed extensions for written files. */
  writeExtensions: string[];
  /** Returns blocking problems with the would-be content of a file (lint, secrets); empty = OK. */
  checkContent?: (absPath: string, content: string) => string | undefined;
  env?: ResolvedEnvironment;
  /** crawl.exclude patterns: paths agents never navigate to. */
  excludePatterns: string[];
  redactor: Redactor;
  /**
   * Existing hand-written files (page objects, fixtures, helpers) the agent may not change directly
   * (modifyExisting: false). A write to one is recorded as a proposed diff and refused.
   */
  proposals?: {
    isProtected: (absPath: string) => boolean;
    record: (absPath: string, before: string, after: string) => void;
  };
}

export const PROPOSAL_RECORDED =
  "This file is hand-written, so DOMinion did not change it. Your change was saved as a proposed diff for a person to review in the UI or CLI; it is NOT applied. Do not rely on it: write your test so it works with the file as it is (for example, keep a new locator or helper inside your own spec or a new page object file).";

export type GuardDecision = { allow: true } | { allow: false; reason: string };

/** Browser tools no agent gets: arbitrary code, file access, raw storage. */
export const ALWAYS_DENIED_MCP_TOOLS = new Set([
  "browser_run_code_unsafe",
  "browser_evaluate",
  "browser_file_upload",
  "browser_drop",
  "browser_install",
  "browser_storage_state",
  "browser_set_storage_state",
]);

/** Read-only browser exploration tools. */
export const BROWSER_READ_TOOLS = [
  "browser_navigate",
  "browser_navigate_back",
  "browser_snapshot",
  "browser_find",
  "browser_take_screenshot",
  "browser_wait_for",
  "browser_tabs",
  "browser_console_messages",
  "browser_network_requests",
  "browser_resize",
  "browser_close",
];

/** Tools that interact with the page. */
export const BROWSER_INPUT_TOOLS = [
  "browser_click",
  "browser_type",
  "browser_fill_form",
  "browser_select_option",
  "browser_press_key",
  "browser_hover",
  "browser_drag",
  "browser_handle_dialog",
];

/** Locator and assertion verification tools (Playwright MCP "testing" capability). */
export const BROWSER_VERIFY_TOOLS = [
  "browser_generate_locator",
  "browser_verify_element_visible",
  "browser_verify_text_visible",
  "browser_verify_list_visible",
  "browser_verify_value",
];

const CASE_INSENSITIVE_FS = process.platform === "win32" || process.platform === "darwin";
const fold = (value: string) => (CASE_INSENSITIVE_FS ? value.toLowerCase() : value);

/**
 * Resolves a path the way the file system will: realpath of the nearest existing ancestor (expands
 * symlinks, junctions and Windows 8.3 short names such as AUTH~1) plus the remaining segments.
 */
export function canonicalPath(path: string): string {
  let current = resolve(path);
  const rest: string[] = [];
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) break;
    rest.unshift(basename(current));
    current = parent;
  }
  let real = current;
  try {
    real = realpathSync.native(current);
  } catch {
    // keep the resolved path
  }
  return rest.length ? join(real, ...rest) : real;
}

/** True for files that hold secrets or live sessions, whatever the policy says. */
export function isSecretPath(root: string, absPath: string): boolean {
  const rel = fold(relativePosix(canonicalPath(root), canonicalPath(absPath)));
  const parts = rel.split("/");
  const name = parts[parts.length - 1] ?? "";
  return (
    parts.includes(".auth") ||
    parts.includes(".git") ||
    parts.includes("node_modules") ||
    name.startsWith(".env") ||
    name.endsWith(".pem") ||
    name.endsWith(".key") ||
    parts[0] === ".dominion"
  );
}

/** A search root that directly holds secrets (for example a testDir of "."), which Grep must not scan. */
function containsSecrets(dir: string): boolean {
  if (!existsSync(dir)) return false;
  try {
    return readdirSync(dir).some((name) => {
      const n = fold(name);
      return n === ".auth" || n === ".dominion" || n === ".git" || n.startsWith(".env") || n.endsWith(".pem") || n.endsWith(".key");
    });
  } catch {
    return true;
  }
}

function within(roots: readonly string[], absPath: string): boolean {
  const target = canonicalPath(absPath);
  return roots.some((root) => {
    const r = canonicalPath(root);
    return fold(target) === fold(r) || isInside(r, target);
  });
}

function globToRegExp(pattern: string): RegExp {
  const source = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "\u0000")
    .replace(/\*/g, "[^/]*")
    .replace(/\u0000/g, ".*");
  return new RegExp(`^${source}$`);
}

/** Decodes (repeatedly), strips ;params and trailing dots/slashes, and lower-cases a URL path for matching. */
export function normalizeUrlPath(pathname: string): string {
  let out = pathname;
  for (let i = 0; i < 4; i++) {
    try {
      const decoded = decodeURIComponent(out);
      if (decoded === out) break;
      out = decoded;
    } catch {
      break;
    }
  }
  out = out.replace(/\\/g, "/").replace(/;[^/]*/g, "").replace(/\/{2,}/g, "/").replace(/[.\s/]+$/, "");
  return (out || "/").toLowerCase();
}

/** Whether a URL path matches crawl.exclude ("/logout" prefix match, or a glob), ignoring case and encoding. */
export function isExcludedPath(pathname: string, patterns: readonly string[]): boolean {
  const path = normalizeUrlPath(pathname);
  return patterns.some((raw) => {
    const pattern = raw.toLowerCase();
    if (pattern.includes("*")) return globToRegExp(pattern).test(path) || globToRegExp(`**${pattern}`).test(path);
    const p = normalizeUrlPath(pattern);
    return path === p || path.startsWith(`${p}/`);
  });
}

/** Link or button descriptions agents never click (spec: deny-listed link text such as log out, delete account). */
export const DENIED_ELEMENT_RE =
  /\b(log\s*-?\s*out|sign\s*-?\s*out|delete\s+(my\s+|your\s+)?account|remove\s+(my\s+|your\s+)?account|close\s+(my\s+|your\s+)?account|unsubscribe)\b/i;

function resolveInputPath(root: string, value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  // "~" expands to the home directory in Claude Code's tools; never allow it.
  if (value.startsWith("~")) return undefined;
  return isAbsolute(value) ? resolve(value) : resolve(root, value);
}

/**
 * Computes the content a file will have after Edit, matching like Claude Code does: CRLF files are
 * compared as LF and written back with CRLF. Returns undefined when old_string is not found.
 */
export function applyEdit(current: string, oldString: unknown, newString: unknown, replaceAll: unknown): string | undefined {
  if (typeof oldString !== "string" || typeof newString !== "string") return undefined;
  const crlf = current.includes("\r\n");
  const base = crlf ? current.replace(/\r\n/g, "\n") : current;
  const from = oldString.replace(/\r\n/g, "\n");
  const to = newString.replace(/\r\n/g, "\n");
  if (!from || !base.includes(from)) return undefined;
  const out = replaceAll === true ? base.split(from).join(to) : base.replace(from, () => to);
  return crlf ? out.replace(/\n/g, "\r\n") : out;
}

export function evaluateToolCall(policy: ToolPolicy, toolName: string, input: Record<string, unknown>): GuardDecision {
  const deny = (reason: string): GuardDecision => ({ allow: false, reason });

  if (toolName.startsWith("mcp__")) {
    if (!toolName.startsWith(MCP_TOOL_PREFIX)) return deny(`${toolName} is not available to the ${policy.agent}.`);
    const tool = toolName.slice(MCP_TOOL_PREFIX.length);
    if (ALWAYS_DENIED_MCP_TOOLS.has(tool)) return deny(`${tool} is disabled by DOMinion for safety.`);
    if (!policy.mcpTools.includes(tool)) return deny(`${tool} is not available to the ${policy.agent}.`);
    for (const key of ["filename", "path", "paths"]) {
      if (input[key] !== undefined && input[key] !== "") {
        return deny("Saving or reading files through browser tools is disabled; DOMinion captures screenshots and snapshots itself. Call the tool without a filename.");
      }
    }
    if ((tool === "browser_click" || tool === "browser_hover") && typeof input.element === "string" && DENIED_ELEMENT_RE.test(input.element)) {
      return deny(`"${input.element}" looks like log out, sign out or delete account. Agents never click those: it would end the session or destroy data.`);
    }
    if (tool === "browser_navigate" || (tool === "browser_tabs" && typeof input.url === "string")) {
      return checkNavigation(policy, input.url);
    }
    return { allow: true };
  }

  if (!policy.builtinTools.includes(toolName)) return deny(`The ${toolName} tool is not available to the ${policy.agent}.`);

  switch (toolName) {
    case "Read": {
      const path = resolveInputPath(policy.root, input.file_path);
      if (!path) return deny("Read needs a file_path.");
      if (isSecretPath(policy.root, path)) return deny("That file holds secrets or sessions and is never readable by agents.");
      if (!within([...policy.readRoots, ...policy.writeRoots], path)) {
        return deny(`Read is limited to: ${[...policy.readRoots, ...policy.writeRoots].map((r) => relativePosix(policy.root, r)).join(", ")}.`);
      }
      return { allow: true };
    }
    case "Glob":
    case "Grep": {
      const path = resolveInputPath(policy.root, input.path);
      const roots = [...policy.readRoots, ...policy.writeRoots];
      if (!path || !within(roots, path)) {
        return deny(`${toolName} needs a "path" inside: ${roots.map((r) => relativePosix(policy.root, r)).join(", ")}.`);
      }
      if (isSecretPath(policy.root, path)) return deny("That location holds secrets or sessions and is never searchable by agents.");
      if (containsSecrets(path)) return deny(`${relativePosix(policy.root, path) || "."} also holds secret files; search a narrower folder (for example your tests folder).`);
      if (typeof input.pattern === "string" && input.pattern.includes("..")) return deny(`${toolName} patterns must not contain "..".`);
      return { allow: true };
    }
    case "Write":
    case "Edit":
    case "MultiEdit": {
      const path = resolveInputPath(policy.root, input.file_path);
      if (!path) return deny(`${toolName} needs a file_path.`);
      if (isSecretPath(policy.root, path)) return deny("Agents cannot write to secret or session files.");
      if (policy.proposals && existsSync(path) && within([...policy.readRoots, ...policy.writeRoots], path) && policy.proposals.isProtected(path)) {
        const before = readFileSync(path, "utf8");
        let after: string | undefined;
        if (toolName === "Write") after = typeof input.content === "string" ? input.content : undefined;
        else if (toolName === "Edit") after = applyEdit(before, input.old_string, input.new_string, input.replace_all);
        else if (Array.isArray(input.edits)) {
          after = before;
          for (const edit of input.edits as Array<Record<string, unknown>>) after = after === undefined ? undefined : applyEdit(after, edit.old_string, edit.new_string, edit.replace_all);
        }
        if (after === undefined) return deny(`${toolName} could not be applied to ${relativePosix(policy.root, path)} (old_string not found). ${PROPOSAL_RECORDED}`);
        if (policy.redactor.findSecrets(after).length) return deny("The change contains a credential value. Never write credentials into files.");
        policy.proposals.record(path, before, after);
        return deny(PROPOSAL_RECORDED);
      }
      if (!within(policy.writeRoots, path)) {
        return deny(`${toolName} is limited to: ${policy.writeRoots.map((r) => relativePosix(policy.root, r)).join(", ")}.`);
      }
      if (!policy.writeExtensions.includes(extname(path).toLowerCase())) {
        return deny(`Only ${policy.writeExtensions.join(", ")} files can be written.`);
      }
      let next: string | undefined;
      if (toolName === "Write") {
        next = typeof input.content === "string" ? input.content : undefined;
      } else {
        const current = existsSync(path) ? readFileSync(path, "utf8") : "";
        if (toolName === "Edit") {
          next = applyEdit(current, input.old_string, input.new_string, input.replace_all);
        } else if (Array.isArray(input.edits)) {
          next = current;
          for (const edit of input.edits as Array<Record<string, unknown>>) {
            next = next === undefined ? undefined : applyEdit(next, edit.old_string, edit.new_string, edit.replace_all);
          }
        }
        // Fail closed: if DOMinion cannot compute the result, the edit is not allowed.
        if (next === undefined) return deny(`old_string was not found in ${relativePosix(policy.root, path)}. Read the file again and retry with text copied exactly from it.`);
      }
      if (next === undefined) return deny("Write needs content.");
      const leaked = policy.redactor.findSecrets(next);
      if (leaked.length) return deny(`The content contains the value of ${leaked.join(", ")}. Never write credentials into files.`);
      const problem = policy.checkContent?.(path, next);
      if (problem) return deny(`The file was not saved because it breaks DOMinion's test generation rules:\n${problem}\nFix these and write the file again.`);
      return { allow: true };
    }
    default:
      return { allow: true };
  }
}

function checkNavigation(policy: ToolPolicy, rawUrl: unknown): GuardDecision {
  if (typeof rawUrl !== "string" || !rawUrl) return { allow: false, reason: "browser_navigate needs a url." };
  const env = policy.env;
  let url: URL;
  try {
    url = env ? new URL(rawUrl, `${env.baseURL}/`) : new URL(rawUrl);
  } catch {
    return { allow: false, reason: `"${rawUrl}" is not a valid URL.` };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { allow: false, reason: "Only http(s) pages of the application can be opened." };
  }
  if (env && !env.allowedOrigins.includes(url.origin)) {
    return { allow: false, reason: `${url.origin} is outside the application. Allowed origins: ${env.allowedOrigins.join(", ")}.` };
  }
  if (isExcludedPath(url.pathname, policy.excludePatterns)) {
    return { allow: false, reason: `${url.pathname} is excluded (crawl.exclude); agents never visit it.` };
  }
  return { allow: true };
}

/** Folder segment helper for policies: absolute dir with a trailing separator removed. */
export function absDir(root: string, dir: string): string {
  const abs = isAbsolute(dir) ? dir : resolve(root, dir);
  return abs.endsWith(sep) ? abs.slice(0, -1) : abs;
}
