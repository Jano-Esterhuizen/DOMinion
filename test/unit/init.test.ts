import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DominionError } from "../../src/core/errors";
import { detectPackageManager, playwrightInitCommand } from "../../src/core/init/detect";
import { envVarsReferencedBy, runInit } from "../../src/core/init";
import { nonInteractivePrompter } from "../../src/core/prompter";
import { scriptedPrompter } from "../helpers/prompter";
import { makePlaywrightProject, makeTempDir, removeDir, snapshotTree, writeFiles } from "../helpers/tmp";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) removeDir(dirs.pop()!);
});
function project(extra: Record<string, string> = {}) {
  const root = makePlaywrightProject("init", extra);
  dirs.push(root);
  return root;
}

describe("runInit in an empty Playwright project", () => {
  it("creates the expected files and folders", async () => {
    const root = project();
    const result = await runInit({ root, baseURL: "https://staging.example.com/", prompter: nonInteractivePrompter() });

    expect(result.playwrightConfig).toBe("playwright.config.ts");
    expect(result.files.map((f) => [f.path, f.status])).toEqual([
      ["dominion.config.ts", "created"],
      ["dominion/auth/login.ts", "created"],
      [".env.local", "created"],
      [".gitignore", "created"],
      ["specs/", "created"],
      ["tests/agent/", "created"],
      // The "chromium" project's testDir (./tests) contains tests/agent: it now ignores the
      // generated tests, which run in DOMinion's own projects with the session.
      ["playwright.config.ts", "updated"],
    ]);
    expect(readFileSync(join(root, "playwright.config.ts"), "utf8")).toContain(
      '{ name: "chromium", testIgnore: "**/tests/agent/**", use: { ...devices["Desktop Chrome"] } },',
    );

    const config = readFileSync(join(root, "dominion.config.ts"), "utf8");
    expect(config).toContain('import { defineConfig } from "dominion-playwright";');
    expect(config).toContain('baseURL: "https://staging.example.com"');
    expect(config).toContain('allowedOrigins: ["https://staging.example.com"]');
    expect(config).toContain('userEnv: "STAGING_CUSTOMER_USER"');
    expect(config).not.toMatch(/\{\{|\}\}/);

    const login = readFileSync(join(root, "dominion", "auth", "login.ts"), "utf8");
    expect(login).toContain('import type { LoginContext } from "dominion-playwright";');
    expect(login).toContain("ADJUST");

    const envLocal = readFileSync(join(root, ".env.local"), "utf8");
    expect(envLocal).toMatch(/^ANTHROPIC_API_KEY=$/m);
    expect(envLocal).toMatch(/^STAGING_CUSTOMER_USER=$/m);
    expect(envLocal).toMatch(/^STAGING_CUSTOMER_PASS=$/m);
    // commented-out example roles are not listed
    expect(envLocal).not.toContain("STAGING_ADMIN_USER");

    const gitignore = readFileSync(join(root, ".gitignore"), "utf8");
    for (const entry of [".env.local", ".auth/", ".dominion/"]) expect(gitignore).toContain(entry);

    expect(existsSync(join(root, "specs", ".gitkeep"))).toBe(true);
    expect(existsSync(join(root, "tests", "agent", ".gitkeep"))).toBe(true);
  });

  it("changes nothing when run a second time", async () => {
    const root = project();
    await runInit({ root, baseURL: "https://staging.example.com", prompter: nonInteractivePrompter() });
    const before = snapshotTree(root);
    const second = await runInit({ root, baseURL: "https://other.example.com", prompter: nonInteractivePrompter() });
    expect(snapshotTree(root)).toEqual(before);
    expect(second.files.every((f) => f.status === "skipped")).toBe(true);
  });

  it("asks for the base URL interactively when --base-url is not given", async () => {
    const root = project();
    const { prompter, asked } = scriptedPrompter({ input: ["https://qa.example.com"] });
    await runInit({ root, prompter });
    expect(asked.some((q) => q.startsWith("input: Base URL"))).toBe(true);
    expect(readFileSync(join(root, "dominion.config.ts"), "utf8")).toContain('baseURL: "https://qa.example.com"');
  });

  it("falls back to a placeholder base URL with a warning in non-interactive mode", async () => {
    const root = project();
    const result = await runInit({ root, prompter: nonInteractivePrompter() });
    expect(readFileSync(join(root, "dominion.config.ts"), "utf8")).toContain('baseURL: "http://localhost:3000"');
    expect(result.warnings.join("\n")).toMatch(/--base-url/);
  });

  it("rejects an invalid base URL with a clear error", async () => {
    const root = project();
    await expect(runInit({ root, baseURL: "staging.example.com", prompter: nonInteractivePrompter() })).rejects.toThrow(
      DominionError,
    );
    await expect(runInit({ root, baseURL: "ftp://x.example.com", prompter: nonInteractivePrompter() })).rejects.toThrow(
      /http:\/\/ or https:\/\//,
    );
  });
});

describe("runInit never overwrites", () => {
  it("skips an existing .env.local and lists the variables it is missing", async () => {
    const root = project({ ".env.local": "ANTHROPIC_API_KEY=sk-test-not-real\nOTHER=1\n" });
    const result = await runInit({ root, baseURL: "https://staging.example.com", prompter: nonInteractivePrompter() });
    const env = result.files.find((f) => f.path === ".env.local")!;
    expect(env.status).toBe("skipped");
    expect(env.detail).toContain("STAGING_CUSTOMER_USER");
    expect(env.detail).not.toContain("ANTHROPIC_API_KEY");
    expect(readFileSync(join(root, ".env.local"), "utf8")).toBe("ANTHROPIC_API_KEY=sk-test-not-real\nOTHER=1\n");
  });

  it("keeps an existing dominion.config.ts and derives .env.local from it", async () => {
    const config = [
      'import { defineConfig } from "dominion-playwright";',
      "export default defineConfig({ environments: { qa: { baseURL: 'https://qa.example.com', roles: {",
      "  admin: { strategy: 'form', userEnv: 'QA_ADMIN_USER', passEnv: 'QA_ADMIN_PASS', totpEnv: 'QA_ADMIN_TOTP' },",
      "} } } });",
    ].join("\n");
    const root = project({ "dominion.config.ts": config });
    const result = await runInit({ root, baseURL: "https://ignored.example.com", prompter: nonInteractivePrompter() });
    expect(readFileSync(join(root, "dominion.config.ts"), "utf8")).toBe(config);
    expect(result.envVars).toEqual(["ANTHROPIC_API_KEY", "QA_ADMIN_USER", "QA_ADMIN_PASS", "QA_ADMIN_TOTP"]);
    expect(readFileSync(join(root, ".env.local"), "utf8")).toMatch(/^QA_ADMIN_TOTP=$/m);
  });

  it("does not add .gitkeep to folders that already exist", async () => {
    const root = project({ "specs/existing.md": "# plan\n" });
    await runInit({ root, baseURL: "https://staging.example.com", prompter: nonInteractivePrompter() });
    expect(existsSync(join(root, "specs", ".gitkeep"))).toBe(false);
    expect(readFileSync(join(root, "specs", "existing.md"), "utf8")).toBe("# plan\n");
  });
});

describe("runInit without Playwright", () => {
  it("errors clearly outside a Node project", async () => {
    const root = makeTempDir("init-nopkg");
    dirs.push(root);
    await expect(runInit({ root, prompter: nonInteractivePrompter() })).rejects.toMatchObject({
      code: "INIT_NO_PACKAGE_JSON",
    });
  });

  it("offers to run npm init playwright@latest and continues after it succeeds", async () => {
    const root = makeTempDir("init-nopw");
    dirs.push(root);
    writeFiles(root, { "package.json": '{"name":"x"}' });
    const calls: string[] = [];
    const { prompter } = scriptedPrompter({ confirm: [true], input: ["https://staging.example.com"] });
    const result = await runInit({
      root,
      prompter,
      runCommand: async (command, args, { cwd }) => {
        calls.push(`${command} ${args.join(" ")}`);
        writeFileSync(join(cwd, "playwright.config.ts"), "export default {};\n");
        return 0;
      },
    });
    expect(calls).toEqual(["npm init playwright@latest"]);
    expect(result.playwrightConfig).toBe("playwright.config.ts");
    expect(result.warnings.join("\n")).not.toMatch(/not set up/);
  });

  it("warns when the user declines to set up Playwright", async () => {
    const root = makeTempDir("init-nopw");
    dirs.push(root);
    writeFiles(root, { "package.json": '{"name":"x"}' });
    const { prompter } = scriptedPrompter({ confirm: [false], input: ["https://staging.example.com"] });
    const result = await runInit({ root, prompter, runCommand: async () => 0 });
    expect(result.playwrightConfig).toBeUndefined();
    expect(result.warnings.join("\n")).toMatch(/Playwright is not set up/);
  });

  it("surfaces a failing playwright scaffold command", async () => {
    const root = makeTempDir("init-nopw");
    dirs.push(root);
    writeFiles(root, { "package.json": '{"name":"x"}' });
    await expect(
      runInit({ root, yes: true, prompter: nonInteractivePrompter(), runCommand: async () => 2 }),
    ).rejects.toMatchObject({ code: "INIT_PLAYWRIGHT_FAILED" });
  });
});

describe("detection helpers", () => {
  it("detects the package manager from packageManager, lockfiles and the user agent", () => {
    const root = makeTempDir("pm");
    dirs.push(root);
    writeFiles(root, { ".git/HEAD": "ref: refs/heads/main\n", "package.json": '{"name":"x"}' });
    expect(detectPackageManager(root, {})).toBe("npm");
    expect(detectPackageManager(root, { npm_config_user_agent: "pnpm/9.1.0 npm/? node/v22" })).toBe("pnpm");
    writeFiles(root, { "yarn.lock": "" });
    expect(detectPackageManager(root, {})).toBe("yarn");
    writeFiles(root, { "package.json": '{"name":"x","packageManager":"pnpm@9.12.0"}' });
    expect(detectPackageManager(root, {})).toBe("pnpm");
  });

  it("builds the Playwright scaffold command per package manager", () => {
    expect(playwrightInitCommand("npm", true)).toEqual({
      command: "npm",
      args: ["init", "playwright@latest", "--", "--quiet", "--lang=ts", "--browser=chromium"],
    });
    expect(playwrightInitCommand("pnpm", false)).toEqual({ command: "pnpm", args: ["create", "playwright"] });
  });

  it("extracts env var names referenced by a config, ignoring comments", () => {
    const source = [
      'customer: { strategy: "form", userEnv: "A_USER", passEnv: "A_PASS" },',
      '// admin: { strategy: "form", userEnv: "B_USER", passEnv: "B_PASS" },',
      "api: { strategy: 'api', tokenEnv: `A_TOKEN` },",
    ].join("\n");
    expect(envVarsReferencedBy(source)).toEqual(["A_USER", "A_PASS", "A_TOKEN"]);
  });
});
