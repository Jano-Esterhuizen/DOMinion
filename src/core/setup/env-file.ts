import { chmodSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseDotenv } from "dotenv";
import { DominionError } from "../errors";
import { writeFileAtomic } from "../fs";
import { ensureGitignore } from "../init/gitignore";
import { renderTemplate } from "../templates";

export const ENV_FILE = ".env.local";
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Whether an env var has a value, and where it comes from. Never carries the value itself. */
export interface EnvVarState {
  name: string;
  /** Has a non-empty value (from .env.local or the shell). */
  set: boolean;
  /** Has a non-empty value in .env.local. */
  inFile: boolean;
  /** Set in the shell to something other than .env.local's value; the shell wins (CI secrets). */
  fromShell: boolean;
}

function readEnvFile(root: string): Record<string, string> {
  const path = join(root, ENV_FILE);
  if (!existsSync(path)) return {};
  try {
    return parseDotenv(readFileSync(path));
  } catch {
    return {};
  }
}

export function envVarStates(root: string, names: readonly string[], env: NodeJS.ProcessEnv = process.env): EnvVarState[] {
  const file = readEnvFile(root);
  return [...new Set(names)].map((name) => {
    const inFile = Boolean(file[name]);
    const value = env[name];
    return { name, set: Boolean(value), inFile, fromShell: Boolean(value) && value !== file[name] };
  });
}

/** How a value is written so dotenv reads back exactly the same string. */
export function formatEnvValue(value: string): string {
  const candidates = [
    /^[A-Za-z0-9_./:@+=,-]*$/.test(value) ? value : undefined,
    !value.includes("'") && !/[\r\n]/.test(value) ? `'${value}'` : undefined,
    !value.includes('"') && !value.includes("\\") ? `"${value.replace(/\r?\n/g, "\\n")}"` : undefined,
    !value.includes("`") && !/[\r\n]/.test(value) ? `\`${value}\`` : undefined,
  ];
  for (const candidate of candidates) {
    if (candidate !== undefined && parseDotenv(`K=${candidate}`).K === value) return candidate;
  }
  throw new DominionError("That value mixes quote characters in a way .env.local cannot store.", {
    code: "ENV_VALUE_UNSUPPORTED",
    hint: "Set this variable in your shell or CI secrets instead.",
  });
}

export interface WriteEnvResult {
  written: string[];
  /** Saved to .env.local, but the shell sets a different value, which wins. */
  shellWins: string[];
  /** Entries added to .gitignore first, so the secrets can never be committed. */
  gitignoreAdded: string[];
}

/**
 * Saves values to .env.local (spec: credentials only from env vars; the UI writes them here and
 * never reads them back). .gitignore is fixed first so the file can never be committed. Values
 * loaded from .env.local are updated in this process too; values the shell set keep winning.
 * An empty string clears a variable.
 */
export function writeEnvValues(root: string, values: Readonly<Record<string, string>>, env: NodeJS.ProcessEnv = process.env): WriteEnvResult {
  const names = Object.keys(values);
  const bad = names.filter((n) => !NAME_RE.test(n));
  if (bad.length) throw new DominionError(`Not an environment variable name: ${bad.join(", ")}.`, { code: "BAD_ENV_NAME" });
  const formatted = Object.fromEntries(names.map((n) => [n, formatEnvValue(values[n]!)]));

  const gitignore = ensureGitignore(root);
  const path = join(root, ENV_FILE);
  const before = readEnvFile(root);
  let text = existsSync(path) ? readFileSync(path, "utf8") : renderTemplate("env.local.tmpl", { variables: "" });
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  for (const name of names) {
    const line = `${name}=${formatted[name]}`;
    const re = new RegExp(`^[ \\t]*(?:export[ \\t]+)?${name}[ \\t]*=.*$`, "m");
    if (re.test(text)) text = text.replace(re, () => line);
    else text = `${text.replace(/\s*$/, "")}${eol}${line}${eol}`;
  }
  writeFileAtomic(path, text);
  if (process.platform !== "win32") {
    try {
      chmodSync(path, 0o600);
    } catch {
      // best effort
    }
  }

  const shellWins: string[] = [];
  for (const name of names) {
    const current = env[name];
    if (current === undefined || current === "" || current === before[name]) {
      if (values[name] === "") delete env[name];
      else env[name] = values[name];
    } else if (current !== values[name]) shellWins.push(name);
  }
  return { written: names, shellWins, gitignoreAdded: gitignore.added };
}
