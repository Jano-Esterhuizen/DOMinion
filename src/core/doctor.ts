import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { roleStatus } from "./auth";
import { inspectPromptOverrides, PROMPT_NAMES } from "./agents/prompts";
import { apiLoginPath } from "./auth/api";
import { type LoadedConfig, loadConfig } from "./config/loader";
import { getEnvironment, listEnvironments, projectPaths } from "./config/resolve";
import { overlappingProjects } from "./project/wiring";
import { errorMessage, isDominionError } from "./errors";
import { relativePosix } from "./fs";
import { findPlaywrightConfigs } from "./init/detect";
import { isIgnored, REQUIRED_GITIGNORE_ENTRIES } from "./init/gitignore";
import { compareVersions, loadPlaywright, MIN_PLAYWRIGHT_VERSION } from "./playwright/resolve";
import { profileDrift } from "./project/profile";
import { scanProject } from "./project/scan";
import { redactorFor } from "./redact";

export type CheckStatus = "ok" | "warn" | "error" | "skip";

export interface DoctorCheck {
  id: string;
  title: string;
  status: CheckStatus;
  detail?: string;
  hint?: string;
}

export interface DoctorReport {
  checks: DoctorCheck[];
  /** False when any check is an error. */
  ok: boolean;
  loaded?: LoadedConfig;
}

export interface DoctorOptions {
  cwd?: string;
  /** Only check this environment's roles. */
  envName?: string;
  /** Open a browser to validate saved sessions (default true). */
  validateSessions?: boolean;
  env?: NodeJS.ProcessEnv;
}

export const MIN_NODE_VERSION = "20.0.0";

/** Which credential the Agent SDK will use, by name only. */
export function detectApiCredential(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env.ANTHROPIC_API_KEY) return "ANTHROPIC_API_KEY";
  if (env.ANTHROPIC_AUTH_TOKEN) return "ANTHROPIC_AUTH_TOKEN";
  if (env.CLAUDE_CODE_OAUTH_TOKEN) return "CLAUDE_CODE_OAUTH_TOKEN";
  if (env.CLAUDE_CODE_USE_BEDROCK === "1") return "Amazon Bedrock (CLAUDE_CODE_USE_BEDROCK)";
  if (env.CLAUDE_CODE_USE_VERTEX === "1") return "Google Vertex AI (CLAUDE_CODE_USE_VERTEX)";
  if (env.CLAUDE_CODE_USE_FOUNDRY === "1") return "Microsoft Foundry (CLAUDE_CODE_USE_FOUNDRY)";
  return undefined;
}

/** Files tracked by git that must never be committed. */
function trackedSecrets(root: string): string[] | undefined {
  const result = spawnSync("git", ["ls-files", "--", ".auth", ".env.local"], { cwd: root, encoding: "utf8" });
  if (result.status !== 0) return undefined;
  return result.stdout.split(/\r?\n/).filter(Boolean);
}

export async function runDoctor(options: DoctorOptions = {}): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  const env = options.env ?? process.env;
  const add = (check: DoctorCheck) => checks.push(check);

  // Node
  const node = process.versions.node;
  add(
    compareVersions(node, MIN_NODE_VERSION) >= 0
      ? { id: "node", title: "Node.js", status: "ok", detail: `v${node}` }
      : { id: "node", title: "Node.js", status: "error", detail: `v${node}`, hint: `DOMinion needs Node ${MIN_NODE_VERSION} or later.` },
  );

  // Config
  let loaded: LoadedConfig | undefined;
  try {
    loaded = await loadConfig({ cwd: options.cwd });
    add({ id: "config", title: "dominion.config.ts", status: "ok", detail: relativePosix(options.cwd ?? process.cwd(), loaded.configPath) });
  } catch (error) {
    add({
      id: "config",
      title: "dominion.config.ts",
      status: "error",
      detail: errorMessage(error),
      hint: isDominionError(error) ? error.hint : undefined,
    });
    return { checks, ok: false };
  }
  const root = loaded.root;
  const redactor = redactorFor(loaded, env);

  // Playwright
  let playwrightOk = false;
  try {
    const pw = await loadPlaywright(root);
    playwrightOk = true;
    add({ id: "playwright", title: "@playwright/test", status: "ok", detail: `${pw.version} (needs >= ${MIN_PLAYWRIGHT_VERSION})` });
  } catch (error) {
    add({ id: "playwright", title: "@playwright/test", status: "error", detail: errorMessage(error), hint: isDominionError(error) ? error.hint : undefined });
  }
  const pwConfigs = loaded.config.project ? [loaded.config.project.playwrightConfig] : findPlaywrightConfigs(root);
  add(
    pwConfigs.length
      ? { id: "playwright-config", title: "Playwright config", status: "ok", detail: pwConfigs.join(", ") }
      : {
          id: "playwright-config",
          title: "Playwright config",
          status: "warn",
          detail: "no playwright.config.* next to dominion.config.ts",
          hint: "Run `npm init playwright@latest` so DOMinion can run the tests it generates.",
        },
  );

  // API credential
  const credential = detectApiCredential(env);
  add(
    credential
      ? { id: "api-key", title: "Claude API credential", status: "ok", detail: `${credential} is set` }
      : {
          id: "api-key",
          title: "Claude API credential",
          status: "error",
          detail: "ANTHROPIC_API_KEY is not set",
          hint: "Add ANTHROPIC_API_KEY=... to .env.local (gitignored) or export it; CI should use a secret.",
        },
  );

  // Prompt overrides (dominion/prompts/<name>.md replaces the packaged default)
  const overrides = inspectPromptOverrides(projectPaths(loaded).promptOverridesDir);
  for (const override of overrides) {
    const file = relativePosix(root, override.path);
    add(
      override.problems.length
        ? {
            id: `prompt:${override.name}`,
            title: "Prompt override",
            status: (PROMPT_NAMES as string[]).includes(override.name) ? "error" : "warn",
            detail: `${file} ${override.problems.join("; ")}`,
            hint: "Fix the file, or delete it to use the default prompt. `npx dominion prompts` lists the prompts and their placeholders.",
          }
        : { id: `prompt:${override.name}`, title: "Prompt override", status: "ok", detail: `${file} replaces the default ${override.name} prompt` },
    );
  }

  // Environments, credentials, sessions
  let environments;
  try {
    environments = options.envName ? [getEnvironment(loaded, options.envName)] : listEnvironments(loaded);
  } catch (error) {
    add({ id: "env", title: `environment ${options.envName}`, status: "error", detail: errorMessage(error), hint: isDominionError(error) ? error.hint : undefined });
    return { checks, ok: false, loaded };
  }

  for (const environment of environments) {
    const formRoles = Object.entries(environment.roles).filter(([, r]) => r.strategy === "form" && !r.loginScript);
    if (formRoles.length > 0) {
      const script = environment.auth.loginScript;
      add(
        existsSync(script)
          ? { id: `login-script:${environment.name}`, title: `${environment.name}: login script`, status: "ok", detail: relativePosix(root, script) }
          : {
              id: `login-script:${environment.name}`,
              title: `${environment.name}: login script`,
              status: "error",
              detail: `${relativePosix(root, script)} does not exist`,
              hint: "Run `npx dominion init` to create it from the template, or fix auth.loginScript.",
            },
      );
    }
    if (!environment.auth.validate && Object.values(environment.roles).some((r) => r.strategy !== "none")) {
      add({
        id: `validate:${environment.name}`,
        title: `${environment.name}: session validation`,
        status: "warn",
        detail: "auth.validate is not configured, so expired sessions cannot be detected",
        hint: 'Add auth: { validate: { url: "/account", loggedOutPattern: "/login" } } to this environment.',
      });
    }

    for (const roleName of Object.keys(environment.roles)) {
      const id = `role:${environment.name}/${roleName}`;
      const title = `${environment.name}/${roleName}`;
      let status;
      try {
        status = await roleStatus({ loaded, envName: environment.name, roleName, validate: playwrightOk && options.validateSessions !== false });
      } catch (error) {
        add({ id, title, status: "error", detail: errorMessage(error), hint: isDominionError(error) ? error.hint : undefined });
        continue;
      }
      const missing = status.missingEnvVars;
      switch (status.badge) {
        case "no-session-needed":
          add({ id, title, status: "ok", detail: "guest role, no session needed" });
          break;
        case "session-valid":
          add({ id, title, status: missing.length ? "warn" : "ok", detail: `session valid${missing.length ? `; but ${missing.join(", ")} not set, so it cannot be refreshed` : ""}` });
          break;
        case "credentials-missing":
          add({
            id,
            title,
            status: "error",
            detail: `${missing.join(", ")} not set`,
            hint: `Add ${missing.map((m) => `${m}=...`).join(" ")} to .env.local or your CI secrets.`,
          });
          break;
        case "session-expired":
          add({ id, title, status: "warn", detail: `session expired${status.detail ? ` (${status.detail})` : ""}`, hint: `Run \`npx dominion auth ${environment.name} --role ${roleName}\`; form and api roles also refresh automatically before a run.` });
          break;
        case "session-unverified":
          add({ id, title, status: "warn", detail: status.detail ?? "session saved but not validated" });
          break;
        case "never-logged-in":
          add({ id, title, status: "warn", detail: "never logged in", hint: `Run \`npx dominion auth ${environment.name} --role ${roleName}\`.` });
          break;
      }
      const roleConfig = environment.roles[roleName]!;
      if (roleConfig.strategy === "api") {
        const modulePath = apiLoginPath({ loaded, env: environment }, roleConfig);
        if (!modulePath || !existsSync(modulePath)) {
          add({
            id: `${id}:api-login`,
            title,
            status: "error",
            detail: modulePath ? `API login module ${relativePosix(root, modulePath)} not found` : "uses the api strategy, but no login module is configured",
            hint: modulePath
              ? "Create the module, or fix auth.apiLogin in dominion.config.ts."
              : `Set auth.apiLogin (for example "./dominion/auth/api-login.ts") for the "${environment.name}" environment in dominion.config.ts.`,
          });
        }
      }
    }
  }

  // New projects: other projects that would also run the generated tests (without DOMinion's session).
  if (!loaded.config.project && pwConfigs.length) {
    try {
      const testDir = projectPaths(loaded).testDir;
      const overlap = await overlappingProjects(join(root, pwConfigs[0]!), testDir);
      if (overlap.length) {
        add({
          id: "overlap",
          title: "Generated tests in other projects",
          status: "warn",
          detail: `project${overlap.length === 1 ? "" : "s"} ${overlap.map((p) => `"${p}"`).join(", ")} also ${overlap.length === 1 ? "picks" : "pick"} up ${relativePosix(root, testDir)} and would run generated tests without DOMinion's baseURL and session`,
          hint: `Add testIgnore: "**/${relativePosix(root, testDir).split("/").pop()}/**" to ${overlap.length === 1 ? "that project" : "those projects"} in ${pwConfigs[0]}, and run generated tests with \`npx dominion run\`.`,
        });
      }
    } catch {
      // the Playwright config check above already reports load problems
    }
  }

  // Existing-project profile drift (spec: doctor re-runs detection and warns when the profile drifted)
  const profile = loaded.config.project;
  if (profile) {
    let scan;
    try {
      scan = await scanProject(root, profile.playwrightConfig);
    } catch (error) {
      add({ id: "profile", title: "Project profile", status: "error", detail: errorMessage(error), hint: "Re-run `npx dominion init` to detect the project again." });
    }
    const drift = profileDrift(root, profile, scan);
    if (scan && drift.length === 0) add({ id: "profile", title: "Project profile", status: "ok", detail: `matches ${profile.playwrightConfig}` });
    drift.forEach((issue, index) => add({ id: `profile-drift-${index}`, title: "Project profile", status: issue.severity, detail: issue.message, hint: issue.hint }));
  }

  if (redactor.tooShort.length > 0) {
    add({
      id: "short-secrets",
      title: "Secret length",
      status: "warn",
      detail: `${redactor.tooShort.join(", ")} ${redactor.tooShort.length === 1 ? "is" : "are"} shorter than 4 characters and cannot be reliably redacted from logs`,
      hint: "Use longer test credentials.",
    });
  }

  // Git hygiene
  const gitignorePath = join(root, ".gitignore");
  const gitignoreLines = existsSync(gitignorePath) ? readFileSync(gitignorePath, "utf8").split(/\r?\n/) : [];
  const notIgnored = REQUIRED_GITIGNORE_ENTRIES.filter((entry) => !isIgnored(gitignoreLines, entry));
  add(
    notIgnored.length
      ? { id: "gitignore", title: ".gitignore", status: "warn", detail: `missing ${notIgnored.join(", ")}`, hint: "Run `npx dominion init` to add them." }
      : { id: "gitignore", title: ".gitignore", status: "ok", detail: "ignores .env.local, .auth/ and .dominion/" },
  );
  const tracked = trackedSecrets(root);
  if (tracked && tracked.length > 0) {
    add({
      id: "tracked-secrets",
      title: "Secrets in git",
      status: "error",
      detail: `tracked by git: ${tracked.join(", ")}`,
      hint: "Sessions and credentials are secrets. Run `git rm --cached -r .auth .env.local`, commit, and rotate the exposed credentials.",
    });
  }

  return { checks, ok: !checks.some((c) => c.status === "error"), loaded };
}
