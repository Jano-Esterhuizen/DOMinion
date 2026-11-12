import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadConfig } from "../config/loader";
import type { ProjectProfile } from "../config/schema";
import { DominionError, errorMessage } from "../errors";
import { ensureDir, relativePosix, toPosix, writeFileIfMissing } from "../fs";
import { packageName } from "../package-info";
import { buildProfile, insertProfileIntoConfig, renderProfile } from "../project/profile";
import { findPlaywrightConfigsInRepo, type ProjectScan, scanProject } from "../project/scan";
import { credentialEnvVarsUsedBy, scannedFiles } from "../project/secrets";
import { ensureDominionPlaywrightConfig, overlappingProjects } from "../project/wiring";
import { ignoreTestsInProjects } from "../playwright/patch";
import type { CommandRunner, Prompter } from "../prompter";
import { renderTemplate } from "../templates";
import { detectPackageManager, findDominionConfig, hasPlaywrightTest, type PackageManager, playwrightInitCommand } from "./detect";
import { ensureGitignore } from "./gitignore";

export const DEFAULT_ENV_NAME = "staging";
export const DEFAULT_BASE_URL = "http://localhost:3000";
export const DEFAULT_TEST_DIR = "tests/agent";
export const DEFAULT_SPECS_DIR = "specs";

/** Printed by `init` and repeated in the docs (Security and safety: Permission). */
export const AUTHORIZED_USE_NOTICE =
  "DOMinion drives a real browser against your app. Only use it on applications you own or are " +
  "authorized to test, ideally non-production environments with dedicated test accounts.";

export interface InitOptions {
  /** Consumer repo root (the folder with package.json). */
  root: string;
  baseURL?: string;
  /** Accept defaults without asking (also implied when the prompter is non-interactive). */
  yes?: boolean;
  envName?: string;
  /** Which Playwright config to adopt when the repo has several (repo-relative). */
  playwrightConfig?: string;
  prompter: Prompter;
  /** Runs package-manager commands such as `npm init playwright@latest`. */
  runCommand?: CommandRunner;
  /** Optional analysis agent for an existing suite's conventions. */
  analyzeConventions?: (input: { root: string; scan: ProjectScan; profile: ProjectProfile }) => Promise<string | undefined>;
  /** Shows the detected profile to the user before they confirm it. */
  onProfile?: (source: string, notes: string[]) => void;
  /**
   * New projects: add testIgnore to Playwright projects that would also run DOMinion's tests.
   * Set by the UI (a checkbox); when undefined the prompter asks.
   */
  ignoreOverlap?: boolean;
}

export type InitFileStatus = "created" | "skipped" | "updated";

export interface InitFileResult {
  /** Repo-relative path with forward slashes; directories end with "/". */
  path: string;
  status: InitFileStatus;
  detail?: string;
}

export interface InitResult {
  root: string;
  packageManager: PackageManager;
  playwrightConfig?: string;
  /** "existing": an existing Playwright suite was detected and DOMinion adopts its conventions. */
  mode: "new" | "existing";
  profile?: ProjectProfile;
  files: InitFileResult[];
  warnings: string[];
  /** Env var names the config references (always includes ANTHROPIC_API_KEY). */
  envVars: string[];
  nextSteps: string[];
}

const ENV_VAR_REFERENCE_RE = /\b(?:userEnv|passEnv|totpEnv|tokenEnv)\s*:\s*["'`]([A-Za-z_][A-Za-z0-9_]*)["'`]/g;

/** Env var names referenced by a config file's source (role credentials and secretEnv), ignoring commented-out lines. */
export function envVarsReferencedBy(source: string): string[] {
  const names = new Set<string>();
  const live = source
    .split(/\r?\n/)
    .filter((line) => !/^\s*\/\//.test(line))
    .join("\n");
  for (const match of live.matchAll(ENV_VAR_REFERENCE_RE)) names.add(match[1]!);
  for (const list of live.matchAll(/\bsecretEnv\s*:\s*\[([^\]]*)\]/g)) {
    for (const item of list[1]!.matchAll(/["'`]([A-Za-z_][A-Za-z0-9_]*)["'`]/g)) names.add(item[1]!);
  }
  return [...names];
}

export function envPrefix(envName: string): string {
  return envName.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
}

export function normalizeBaseURL(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new DominionError(`"${raw}" is not a valid URL.`, {
      code: "INIT_BAD_BASE_URL",
      hint: "Pass the full base URL of the environment to test, for example --base-url https://staging.example.com",
    });
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new DominionError(`The base URL must start with http:// or https:// (got "${raw}").`, {
      code: "INIT_BAD_BASE_URL",
      hint: "Pass the full base URL, for example --base-url https://staging.example.com",
    });
  }
  return url.href.replace(/\/+$/, "");
}

/** A real hand-written suite (not just create-playwright's example tests) means an existing project. */
export function isExistingSuite(scan: ProjectScan): boolean {
  return scan.source.testFiles.some((t) => !/(^|\/)example\.spec\.(ts|js)$/.test(t.file) && !t.file.includes("tests-examples/"));
}

async function chooseConfig(options: InitOptions, configs: string[], nonInteractive: boolean): Promise<string> {
  if (options.playwrightConfig) {
    const wanted = toPosix(options.playwrightConfig).replace(/^\.\//, "");
    if (!existsSync(join(options.root, wanted))) {
      throw new DominionError(`--playwright-config ${options.playwrightConfig} does not exist.`, {
        code: "INIT_PLAYWRIGHT_CONFIG_NOT_FOUND",
        hint: configs.length ? `Playwright configs in this repo: ${configs.join(", ")}.` : undefined,
      });
    }
    return wanted;
  }
  if (configs.length === 1) return configs[0]!;
  if (nonInteractive) {
    throw new DominionError(`This repo has several Playwright configs: ${configs.join(", ")}.`, {
      code: "INIT_PLAYWRIGHT_CONFIG_AMBIGUOUS",
      hint: "Choose one with --playwright-config <path>.",
    });
  }
  return options.prompter.select("Which Playwright config should DOMinion use?", configs.map((c) => ({ value: c, label: c })), configs[0]);
}

/**
 * Scaffolds DOMinion in a consumer repo. Never overwrites an existing file; everything it skips
 * is reported. Running it twice changes nothing the second time. When the repo already has a
 * Playwright suite, DOMinion adopts its conventions (spec: Existing projects).
 */
export async function runInit(options: InitOptions): Promise<InitResult> {
  const { root, prompter } = options;
  const nonInteractive = options.yes === true || !prompter.interactive;
  const envName = options.envName ?? DEFAULT_ENV_NAME;
  const files: InitFileResult[] = [];
  const warnings: string[] = [];

  if (!existsSync(join(root, "package.json"))) {
    throw new DominionError(`No package.json found in ${root}.`, {
      code: "INIT_NO_PACKAGE_JSON",
      hint: "Run `npx dominion init` from your project root (the folder that contains package.json).",
    });
  }
  const packageManager = detectPackageManager(root);

  // 1. Playwright must exist; offer to scaffold it when it does not.
  let playwrightConfigs = findPlaywrightConfigsInRepo(root);
  if (playwrightConfigs.length === 0) {
    const cmd = playwrightInitCommand(packageManager, nonInteractive);
    const display = `${cmd.command} ${cmd.args.join(" ")}`;
    const shouldRun = await prompter.confirm(`No playwright.config was found. Run \`${display}\` to set up Playwright first?`, options.yes === true);
    if (shouldRun && options.runCommand) {
      const code = await options.runCommand(cmd.command, cmd.args, { cwd: root });
      if (code !== 0) {
        throw new DominionError(`\`${display}\` exited with code ${code}.`, {
          code: "INIT_PLAYWRIGHT_FAILED",
          hint: `Run \`${display}\` yourself, then run \`npx dominion init\` again.`,
        });
      }
      playwrightConfigs = findPlaywrightConfigsInRepo(root);
    }
    if (playwrightConfigs.length === 0) {
      warnings.push(`Playwright is not set up in this project. DOMinion needs it to run tests: run \`${display}\`, then \`npx dominion init\` again.`);
    }
  }
  if (playwrightConfigs.length > 0 && !hasPlaywrightTest(root)) {
    warnings.push("@playwright/test is not installed. Install it (for example `npm install -D @playwright/test`) before running DOMinion.");
  }

  // 2. Detection: adopt an existing suite's conventions.
  let chosenConfig: string | undefined;
  let scan: ProjectScan | undefined;
  let profile: ProjectProfile | undefined;
  let profileNotes: string[] = [];
  if (playwrightConfigs.length > 0) {
    chosenConfig = await chooseConfig(options, playwrightConfigs, nonInteractive);
    try {
      scan = await scanProject(root, chosenConfig);
    } catch (error) {
      warnings.push(`Could not scan ${chosenConfig} (${errorMessage(error)}); using DOMinion's default layout.`);
    }
    if (scan && isExistingSuite(scan)) {
      const draft = buildProfile(root, scan);
      profile = draft.profile;
      profileNotes = draft.notes;
    }
  }
  const mode: InitResult["mode"] = profile ? "existing" : "new";

  // 3. dominion.config.ts
  const existingConfig = findDominionConfig(root);
  let configSource: string;
  let configured: { specsDir: string; testDir: string; envName: string; role?: string } | undefined;
  if (existingConfig) {
    configSource = readFileSync(join(root, existingConfig), "utf8");
    try {
      const loaded = await loadConfig({ cwd: root, loadEnvFile: false });
      const [firstEnv, env] = Object.entries(loaded.config.environments)[0]!;
      const role = Object.entries(env.roles).find(([, r]) => r.strategy !== "none")?.[0];
      configured = { specsDir: loaded.config.specsDir, testDir: loaded.config.project ? "" : loaded.config.testDir, envName: firstEnv, role };
    } catch (error) {
      warnings.push(`${existingConfig} could not be loaded (${errorMessage(error).split("\n")[0]}); run \`npx dominion doctor\` for details.`);
    }
    if (profile && !/\bproject\s*:/.test(configSource)) {
      options.onProfile?.(renderProfile(profile), profileNotes);
      if (await prompter.confirm(`Add the detected project profile to ${existingConfig}?`, true)) {
        if (insertProfileIntoConfig(join(root, existingConfig), profile)) {
          files.push({ path: existingConfig, status: "updated", detail: "added the project profile" });
          configSource = readFileSync(join(root, existingConfig), "utf8");
        } else {
          files.push({ path: existingConfig, status: "skipped", detail: "could not add the profile automatically; paste it in yourself" });
        }
      } else {
        files.push({ path: existingConfig, status: "skipped", detail: "already exists" });
      }
    } else {
      files.push({ path: existingConfig, status: "skipped", detail: "already exists" });
    }
  } else {
    let baseURLInput = options.baseURL;
    const detectedBase = scan?.config.baseURL && /^https?:\/\//.test(scan.config.baseURL) ? scan.config.baseURL : undefined;
    if (!baseURLInput && !nonInteractive) {
      baseURLInput = await prompter.input("Base URL of the environment DOMinion should test (for example https://staging.example.com)", detectedBase ?? DEFAULT_BASE_URL);
    }
    if (!baseURLInput && detectedBase) baseURLInput = detectedBase;
    if (!baseURLInput) {
      baseURLInput = DEFAULT_BASE_URL;
      warnings.push(`No --base-url given; dominion.config.ts uses ${DEFAULT_BASE_URL}. Edit environments.${envName}.baseURL before running DOMinion.`);
    }
    const baseURL = normalizeBaseURL(baseURLInput);
    const vars = { packageName: packageName(), envName, baseURL, origin: new URL(baseURL).origin, envPrefix: envPrefix(envName) };

    if (profile && scan) {
      if (!nonInteractive) {
        const outputDir = (await prompter.input("Where should DOMinion write new tests?", profile.outputDir)).trim();
        if (outputDir && outputDir !== profile.outputDir) profile = { ...profile, outputDir: toPosix(outputDir).replace(/\/+$/, "") };
      }
      if (options.analyzeConventions) {
        const conventions = await options.analyzeConventions({ root, scan, profile }).catch(() => undefined);
        if (conventions) profile = { ...profile, conventions };
        else profileNotes.push("The conventions summary was not generated; generation still uses your exemplar tests.");
      }
      options.onProfile?.(renderProfile(profile), profileNotes);
      if (!(await prompter.confirm("Use this project profile? (you can edit it in dominion.config.ts later)", true))) {
        throw new DominionError("Init stopped before writing anything.", {
          code: "INIT_PROFILE_DECLINED",
          hint: "Re-run `npx dominion init` (use --playwright-config to pick another config), or create dominion.config.ts by hand.",
        });
      }
      const roles = profile.auth
        ? `        user: { strategy: "existing" }, // reuses your ${profile.auth.setupProject ? `"${profile.auth.setupProject}" setup project` : "globalSetup"} and ${profile.auth.storageState}`
        : `        customer: { strategy: "form", userEnv: "${vars.envPrefix}_CUSTOMER_USER", passEnv: "${vars.envPrefix}_CUSTOMER_PASS" },`;
      const secretEnv = credentialEnvVarsUsedBy(root, scannedFiles(scan, chosenConfig!));
      configSource = renderTemplate("dominion.config.existing.ts.tmpl", {
        ...vars,
        testIdAttribute: scan.config.testIdAttribute ?? "data-testid",
        secretEnv: secretEnv.length
          ? [
              "",
              "  // Credentials your suite reads (found by init): redacted from DOMinion's output and hidden",
              "  // from its agents, but still passed to your tests and setup project.",
              `  secretEnv: [${secretEnv.map((n) => JSON.stringify(n)).join(", ")}],`,
            ].join("\n")
          : "",
        roles,
        project: renderProfile(profile),
      });
    } else {
      configSource = renderTemplate("dominion.config.ts.tmpl", vars);
    }
    files.push({ path: "dominion.config.ts", status: writeFileIfMissing(join(root, "dominion.config.ts"), configSource) });
  }

  // 4. Login script, unless the project's own auth setup is reused (no second login mechanism).
  if (!profile?.auth) {
    const status = writeFileIfMissing(join(root, "dominion", "auth", "login.ts"), renderTemplate("login.ts.tmpl", { packageName: packageName() }));
    files.push({ path: "dominion/auth/login.ts", status, ...(status === "skipped" ? { detail: "already exists" } : {}) });
  }

  // 5. playwright.dominion.config.ts extends (never patches) an existing project's config.
  if (profile) {
    const wiring = ensureDominionPlaywrightConfig(root, profile);
    files.push({
      path: relativePosix(root, wiring.path),
      status: wiring.status === "created" ? "created" : wiring.status === "updated" ? "updated" : "skipped",
      ...(wiring.status === "foreign" ? { detail: "exists but was not written by DOMinion; leaving it alone" } : wiring.status === "unchanged" ? { detail: "already exists" } : {}),
    });
  }

  // 6. .env.local listing every env var the config references, with empty values.
  const envVars = ["ANTHROPIC_API_KEY", ...envVarsReferencedBy(configSource)];
  const envLocalPath = join(root, ".env.local");
  if (existsSync(envLocalPath)) {
    const present = new Set(
      readFileSync(envLocalPath, "utf8")
        .split(/\r?\n/)
        .map((line) => /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line)?.[1])
        .filter((name): name is string => Boolean(name)),
    );
    const missing = envVars.filter((name) => !present.has(name));
    files.push({ path: ".env.local", status: "skipped", detail: missing.length ? `already exists; add these variables to it: ${missing.join(", ")}` : "already exists" });
  } else {
    files.push({ path: ".env.local", status: writeFileIfMissing(envLocalPath, renderTemplate("env.local.tmpl", { variables: envVars.map((name) => `${name}=`).join("\n") })) });
  }

  // 7. .gitignore entries
  const gitignore = ensureGitignore(root);
  files.push(
    gitignore.added.length > 0
      ? { path: ".gitignore", status: gitignore.created ? "created" : "updated", detail: `added ${gitignore.added.join(", ")}` }
      : { path: ".gitignore", status: "skipped", detail: "already ignores .env.local, .auth/ and .dominion/" },
  );

  // 8. specs/ and (new projects) tests/agent/, with .gitkeep so the empty folders can be committed.
  const folders = configured
    ? [configured.specsDir, configured.testDir].filter(Boolean)
    : profile
      ? [DEFAULT_SPECS_DIR]
      : [DEFAULT_SPECS_DIR, DEFAULT_TEST_DIR];
  for (const dir of folders) {
    const abs = join(root, dir);
    if (ensureDir(abs)) {
      writeFileIfMissing(join(abs, ".gitkeep"), "");
      files.push({ path: `${toPosix(dir)}/`, status: "created" });
    } else {
      files.push({ path: `${toPosix(dir)}/`, status: "skipped", detail: "already exists" });
    }
  }

  // 9. New projects: stop other projects (create-playwright's "chromium" with testDir ./tests) from
  //    also running the generated tests without DOMinion's baseURL and session.
  if (mode === "new" && chosenConfig) {
    const configAbs = join(root, chosenConfig);
    const testDirAbs = join(root, configured?.testDir ?? DEFAULT_TEST_DIR);
    let overlap: string[] = [];
    try {
      overlap = await overlappingProjects(configAbs, testDirAbs);
    } catch {
      // doctor reports the same overlap once the config loads
    }
    if (overlap.length) {
      const pattern = `**/${relativePosix(dirname(configAbs), testDirAbs)}/**`;
      const names = overlap.map((p) => `"${p}"`).join(", ");
      const one = overlap.length === 1;
      const consent =
        options.ignoreOverlap ??
        (await prompter.confirm(
          `Playwright project${one ? "" : "s"} ${names} would also run DOMinion's generated tests, without DOMinion's session and baseURL. Add testIgnore: "${pattern}" to ${one ? "it" : "them"} in ${chosenConfig}?`,
          true,
        ));
      const ignored = consent ? ignoreTestsInProjects(configAbs, overlap, pattern) : { patched: [], skipped: overlap.map((name) => ({ name, reason: "you chose to keep it" })) };
      if (ignored.patched.length) {
        files.push({ path: chosenConfig, status: "updated", detail: `project${ignored.patched.length === 1 ? "" : "s"} ${ignored.patched.map((p) => `"${p}"`).join(", ")} now ${ignored.patched.length === 1 ? "ignores" : "ignore"} ${toPosix(relativePosix(root, testDirAbs))}/ (run those tests with \`npx dominion run\`)` });
      }
      for (const skip of ignored.skipped) {
        warnings.push(`Project "${skip.name}" also picks up ${toPosix(relativePosix(root, testDirAbs))}/ and would run the generated tests without DOMinion's session; ${skip.reason}. Add testIgnore: "${pattern}" to it in ${chosenConfig}.`);
      }
    }
  }

  const credentialVars = envVars.filter((name) => name !== "ANTHROPIC_API_KEY");
  const role = configured ? (configured.role ?? "<role>") : profile?.auth ? "user" : "customer";
  const authEnv = configured?.envName ?? envName;
  const commands: Array<[string, string]> = [
    [`npx dominion auth ${authEnv} --role ${role}`, profile?.auth ? "runs your setup project and reuses its session" : "log in once and save the session"],
    ["npx dominion doctor", "check config, env vars, sessions and API key"],
    ["npx dominion ui", "open the local UI"],
  ];
  const width = Math.max(...commands.map(([cmd]) => cmd.length)) + 3;
  const nextSteps = [
    `Fill in .env.local with ANTHROPIC_API_KEY${credentialVars.length ? ` and test-account credentials (${credentialVars.join(", ")})` : ""}.`,
    ...(profile?.auth ? [] : ["Adjust the selectors marked ADJUST in dominion/auth/login.ts."]),
    ...commands.map(([cmd, note]) => `${cmd.padEnd(width)}# ${note}`),
  ];

  return { root, packageManager, playwrightConfig: chosenConfig, mode, profile, files, warnings, envVars, nextSteps };
}
