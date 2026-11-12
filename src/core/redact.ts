import { existsSync, readFileSync } from "node:fs";
import { parse as parseDotenv } from "dotenv";
import type { LoadedConfig } from "./config/loader";
import type { DominionConfig } from "./config/schema";
import { referencedEnvVars } from "./config/resolve";

/**
 * Secret redaction. Every log line, event and file DOMinion writes passes through a Redactor that
 * replaces configured secret values with [REDACTED] (spec: Secrets rules). Values come from the
 * env vars the config names plus well-known API credentials.
 */
export const REDACTED = "[REDACTED]";

/** Values shorter than this are not redacted (they would mangle ordinary text); doctor warns about them. */
export const MIN_SECRET_LENGTH = 4;

/** Credentials DOMinion itself uses, redacted even though the config does not name them. */
export const WELL_KNOWN_SECRET_ENV_VARS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_BEARER_TOKEN_BEDROCK",
  "ANTHROPIC_FOUNDRY_API_KEY",
] as const;

interface SecretEntry {
  name: string;
  /** The raw value plus encodings it may appear in (URL, JSON string, HTML). */
  forms: string[];
}

function htmlEscape(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function variantsOf(value: string): string[] {
  const forms = new Set<string>([value]);
  try {
    const uri = encodeURIComponent(value);
    forms.add(uri);
    forms.add(uri.replace(/%20/g, "+"));
    forms.add(uri.replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase()));
    forms.add(encodeURI(value));
    // application/x-www-form-urlencoded (browsers, URLSearchParams) also escapes ! ' ( ) ~
    const form = new URLSearchParams([["k", value]]).toString().slice(2);
    forms.add(form);
    forms.add(form.replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase()));
  } catch {
    // Lone surrogates cannot be URI-encoded; the raw form is still covered.
  }
  forms.add(JSON.stringify(value).slice(1, -1));
  forms.add(htmlEscape(value));
  const base64 = Buffer.from(value, "utf8").toString("base64");
  forms.add(base64);
  forms.add(base64.replace(/=+$/, ""));
  return [...forms].filter((form) => form.length >= MIN_SECRET_LENGTH);
}

/** Plain short words ("admin", "test") are common text; they are redacted on word boundaries only. */
function isWeakValue(value: string): boolean {
  return /^[A-Za-z]{1,10}$/.test(value);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export class Redactor {
  private readonly entries: SecretEntry[] = [];
  /** Usernames that are ordinary words: redacted on word boundaries, never treated as leaks. */
  private readonly weak: SecretEntry[] = [];
  private pattern: RegExp | undefined;
  private weakPattern: RegExp | undefined;
  /** Names of secrets that were too short to redact safely. */
  readonly tooShort: string[] = [];

  constructor(secrets: ReadonlyArray<{ name: string; value: string | undefined }> = []) {
    for (const secret of secrets) this.add(secret.name, secret.value);
  }

  /**
   * Registers a secret value. Empty values are ignored; very short ones are recorded in `tooShort`.
   * Usernames (kind "user") that are plain words are only redacted as whole words.
   */
  add(name: string, value: string | undefined, kind?: string): void {
    if (!value) return;
    if (value.length < MIN_SECRET_LENGTH) {
      if (!this.tooShort.includes(name)) this.tooShort.push(name);
      return;
    }
    if (kind === "user" && isWeakValue(value)) {
      if (!this.weak.some((e) => e.forms[0] === value)) this.weak.push({ name, forms: [value] });
      this.weakPattern = undefined;
      return;
    }
    if (this.entries.some((e) => e.forms[0] === value)) return;
    this.entries.push({ name, forms: variantsOf(value) });
    this.pattern = undefined;
  }

  get size(): number {
    return this.entries.length + this.weak.length;
  }

  private regex(): RegExp | undefined {
    if (this.entries.length === 0) return undefined;
    if (!this.pattern) {
      // Longest first so a secret that contains another is replaced whole.
      const forms = [...new Set(this.entries.flatMap((e) => e.forms))].sort((a, b) => b.length - a.length);
      this.pattern = new RegExp(forms.map(escapeRegExp).join("|"), "g");
    }
    return this.pattern;
  }

  redact(text: string): string {
    if (!text) return text;
    let out = text;
    const re = this.regex();
    if (re) {
      re.lastIndex = 0;
      out = out.replace(re, REDACTED);
    }
    if (this.weak.length) {
      this.weakPattern ??= new RegExp(`\\b(?:${this.weak.map((e) => escapeRegExp(e.forms[0]!)).join("|")})\\b`, "g");
      this.weakPattern.lastIndex = 0;
      out = out.replace(this.weakPattern, REDACTED);
    }
    return out;
  }

  /** Returns a copy of `value` with every string (keys untouched) redacted. */
  redactDeep<T>(value: T): T {
    if (this.entries.length === 0 && this.weak.length === 0) return value;
    return this.walk(value, new WeakMap()) as T;
  }

  private walk(value: unknown, seen: WeakMap<object, unknown>): unknown {
    if (typeof value === "string") return this.redact(value);
    if (value === null || typeof value !== "object") return value;
    if (seen.has(value)) return seen.get(value);
    if (Array.isArray(value)) {
      const out: unknown[] = [];
      seen.set(value, out);
      for (const item of value) out.push(this.walk(item, seen));
      return out;
    }
    if (value instanceof Date || value instanceof RegExp) return value;
    const out: Record<string, unknown> = {};
    seen.set(value, out);
    for (const [key, item] of Object.entries(value)) out[key] = this.walk(item, seen);
    return out;
  }

  /** Names of secrets whose value (in any encoding) appears in `text`. */
  findSecrets(text: string): string[] {
    if (!text) return [];
    return this.entries.filter((e) => e.forms.some((form) => text.includes(form))).map((e) => e.name);
  }
}

/** Env var names that look like credentials; used for names DOMinion finds rather than is told. */
export const CREDENTIAL_NAME_RE = /PASS|PWD|SECRET|TOKEN|KEY|USER|EMAIL|LOGIN|OTP|PIN|AUTH|COOKIE|SESSION|CRED/i;

/** Usernames and emails: plain-word values are redacted on word boundaries only. */
const kindOf = (name: string) => (/USER|EMAIL|LOGIN|NAME/i.test(name) ? "user" : undefined);

/** Builds a redactor from the env vars a config references plus well-known API credentials. */
export function redactorFromConfig(config: DominionConfig | undefined, env: NodeJS.ProcessEnv = process.env): Redactor {
  const redactor = new Redactor();
  for (const name of WELL_KNOWN_SECRET_ENV_VARS) redactor.add(name, env[name]);
  if (config) {
    for (const name of config.secretEnv ?? []) redactor.add(name, env[name], kindOf(name));
    const refs = referencedEnvVars(config);
    for (const ref of refs) redactor.add(ref.name, env[ref.name], ref.kind);
    // HTTP Basic auth headers carry base64("user:pass").
    for (const user of refs.filter((r) => r.kind === "user")) {
      const pass = refs.find((r) => r.kind === "pass" && r.env === user.env && r.role === user.role);
      const u = env[user.name];
      const p = pass ? env[pass.name] : undefined;
      if (u && p) redactor.add(`${user.name}:${pass!.name}`, `${u}:${p}`);
    }
  }
  return redactor;
}

/**
 * The redactor for a loaded project: the config's env vars and `secretEnv`, plus any .env.local
 * entry whose name looks like a credential (.env.local is where credentials live, so a password
 * added there for the project's own setup is redacted even before `secretEnv` names it).
 */
export function redactorFor(loaded: Pick<LoadedConfig, "config" | "envFile">, env: NodeJS.ProcessEnv = process.env): Redactor {
  const redactor = redactorFromConfig(loaded.config, env);
  if (loaded.envFile && existsSync(loaded.envFile)) {
    try {
      for (const [name, value] of Object.entries(parseDotenv(readFileSync(loaded.envFile)))) {
        if (CREDENTIAL_NAME_RE.test(name)) redactor.add(name, env[name] ?? value, kindOf(name));
      }
    } catch {
      // an unreadable .env.local was already reported by the loader
    }
  }
  return redactor;
}

let active: Redactor = new Redactor();

/** The process-wide redactor used by CLI output and logs. */
export function activeRedactor(): Redactor {
  return active;
}

export function setActiveRedactor(redactor: Redactor): void {
  active = redactor;
}

/** Shorthand for activeRedactor().redact(text). */
export function redactText(text: string): string {
  return active.redact(text);
}
