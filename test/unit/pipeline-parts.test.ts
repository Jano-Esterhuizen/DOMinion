import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { buildMcpConfig } from "../../src/core/mcp";
import { flowSlugFromRequest, newRunId, RUN_ID_RE, slugify } from "../../src/core/orchestrator/ids";
import { RunStore } from "../../src/core/orchestrator/store";
import type { RunRecord } from "../../src/core/orchestrator/types";
import { MANAGED_END, MANAGED_START, type ManagedProjectEntry, patchPlaywrightConfig, renderManagedBlock } from "../../src/core/playwright/patch";
import { type JsonReport, parseJsonReport, stripAnsi } from "../../src/core/playwright/report";
import { fileFilter } from "../../src/core/playwright/runner";
import { parsePlan, planScenarios, serializePlan } from "../../src/core/plans";
import { REDACTED, Redactor } from "../../src/core/redact";
import { STOCK_PLAYWRIGHT_CONFIG } from "../helpers/consumer";
import { makeTempDir, removeDir } from "../helpers/tmp";

const dir = makeTempDir("parts");
afterAll(() => removeDir(dir));

describe("ids", () => {
  it("makes sortable run ids and readable flow slugs", () => {
    expect(newRunId(new Date(2026, 10, 11))).toMatch(/^2026-11-11-[0-9a-f]{4}$/);
    expect(RUN_ID_RE.test(newRunId())).toBe(true);
    expect(flowSlugFromRequest("write tests for the add to cart workflow")).toBe("add-to-cart");
    expect(flowSlugFromRequest("Guest checkout")).toBe("guest-checkout");
    expect(flowSlugFromRequest("add a product to the cart")).toBe("add-product-to-cart");
    expect(flowSlugFromRequest("Write e2e tests for the guest checkout flow")).toBe("guest-checkout");
    expect(flowSlugFromRequest("test the login")).toBe("login");
    expect(slugify("Crème brûlée & Co's order!")).toBe("creme-brulee-cos-order");
    expect(slugify("")).toBe("flow");
  });
});

describe("plans", () => {
  it("round-trips frontmatter and tolerates a fenced plan", () => {
    const text = serializePlan({ env: "staging", role: "customer", flow: "x", createdAt: "2026-11-11T09:00:00.000Z", status: "draft", note: "a: b" }, "# T\n\n### 1. One\n### 2) Two");
    const parsed = parsePlan(text);
    expect(parsed.frontmatter).toEqual({ env: "staging", role: "customer", flow: "x", createdAt: "2026-11-11T09:00:00.000Z", status: "draft", note: "a: b" });
    expect(planScenarios(parsed.body)).toEqual(["One", "Two"]);
    expect(parsePlan("```markdown\n" + text + "```").frontmatter.flow).toBe("x");
    expect(parsePlan("# No frontmatter").frontmatter).toEqual({});
  });
});

describe("Playwright config patching", () => {
  const entries: ManagedProjectEntry[] = [
    { env: "staging", role: "customer", baseURL: "https://s.example.com", storageState: ".auth/staging-customer.json", testDir: "tests/agent" },
    { env: "staging", role: "guest", baseURL: "https://s.example.com", testDir: "tests/agent" },
  ];

  it("renders the managed block from the spec", () => {
    const block = renderManagedBlock(entries, "");
    expect(block.startsWith(MANAGED_START)).toBe(true);
    expect(block.endsWith(MANAGED_END)).toBe(true);
    expect(block).toContain('{ name: "dominion-setup-staging-customer", testDir: "tests/agent", testMatch: /dominion\\.setup\\.ts/,');
    expect(block).toContain('dependencies: ["dominion-setup-staging-customer"], grep: /@role:customer(?![\\w-])/ },');
    expect(block).toContain('{ name: "dominion-staging-guest", testDir: "tests/agent",');
    expect(block).not.toContain("dominion-setup-staging-guest");
  });

  it("inserts into the projects array, then updates in place idempotently", () => {
    const file = join(dir, "playwright.config.ts");
    writeFileSync(file, STOCK_PLAYWRIGHT_CONFIG);
    expect(patchPlaywrightConfig(file, entries).status).toBe("patched");
    const once = readFileSync(file, "utf8");
    expect(once).toContain('      name: "chromium",');
    expect(once.indexOf(MANAGED_START)).toBeGreaterThan(once.indexOf('name: "chromium"'));
    expect(once).toMatch(/\},\n    \/\/ --- dominion:start/);
    expect(patchPlaywrightConfig(file, entries).status).toBe("unchanged");
    expect(patchPlaywrightConfig(file, [entries[0]!]).status).toBe("patched");
    expect(readFileSync(file, "utf8")).not.toContain("dominion-staging-guest");
    expect(readFileSync(file, "utf8").match(/dominion:start/g)).toHaveLength(1);
  });

  it("handles trailing commas, empty arrays and CommonJS configs", () => {
    const cases = [
      'export default defineConfig({ projects: [{ name: "a" },] });',
      "export default defineConfig({\n  projects: [],\n});",
      'const { defineConfig } = require("@playwright/test");\nmodule.exports = defineConfig({\n  projects: [\n    { name: "a" }\n  ]\n});',
      'const config = defineConfig({ projects: [{ name: "a" }] });\nexport default config;',
    ];
    for (const [i, source] of cases.entries()) {
      const file = join(dir, `case-${i}.config.ts`);
      writeFileSync(file, source);
      expect(patchPlaywrightConfig(file, entries).status, source).toBe("patched");
      const out = readFileSync(file, "utf8");
      expect(out, out).not.toMatch(/,\s*,/);
      expect(out).toContain('name: "dominion-staging-customer"');
    }
  });

  it("asks the user to add the snippet when the config is too unusual to edit", () => {
    for (const source of ["export default defineConfig({ testDir: './t' });", "export default defineConfig({ projects: makeProjects() });", "export default makeConfig();"]) {
      const file = join(dir, "unusual.config.ts");
      writeFileSync(file, source);
      const result = patchPlaywrightConfig(file, entries);
      expect(result.status).toBe("manual");
      expect(result.snippet).toContain(MANAGED_START);
      expect(readFileSync(file, "utf8")).toBe(source);
    }
  });
});

describe("JSON report parsing", () => {
  it("flattens suites, strips ANSI and maps fixme", () => {
    const report: JsonReport = {
      config: { rootDir: "/repo/tests" },
      errors: [],
      suites: [
        {
          title: "agent\\cart\\a.spec.ts",
          file: "agent/cart/a.spec.ts",
          suites: [
            {
              title: "Cart @dominion",
              file: "agent/cart/a.spec.ts",
              line: 3,
              specs: [
                { title: "passes", file: "agent/cart/a.spec.ts", line: 4, column: 3, tags: ["dominion"], tests: [{ projectName: "p", status: "expected", results: [{ status: "passed", duration: 12.4 }] }] },
                {
                  title: "fails",
                  file: "agent/cart/a.spec.ts",
                  line: 9,
                  column: 3,
                  tests: [
                    {
                      projectName: "p",
                      status: "unexpected",
                      results: [
                        { status: "failed", duration: 5, error: { message: "first try" } },
                        { status: "failed", duration: 7, error: { message: "\u001b[31mError:\u001b[39m expected" }, attachments: [{ name: "trace", path: "/r/trace.zip" }, { name: "error-context", path: "/r/ctx.md" }] },
                      ],
                    },
                  ],
                },
                { title: "broken app", file: "agent/cart/a.spec.ts", line: 20, column: 8, tests: [{ projectName: "p", status: "skipped", annotations: [{ type: "fixme", description: "badge never updates" }], results: [{ status: "skipped", duration: 0 }] }] },
              ],
            },
          ],
        },
      ],
    };
    const [passed, failed, fixme] = parseJsonReport(report);
    expect(passed).toMatchObject({ title: "passes", titlePath: ["Cart @dominion", "passes"], status: "passed", durationMs: 12, line: 4 });
    expect(passed!.file.replace(/\\/g, "/")).toMatch(/\/repo\/tests\/agent\/cart\/a\.spec\.ts$/);
    expect(failed).toMatchObject({ status: "failed", error: "Error: expected", tracePath: "/r/trace.zip", errorContextPath: "/r/ctx.md" });
    expect(fixme).toMatchObject({ status: "fixme", fixmeReason: "badge never updates" });
    expect(stripAnsi("\u001b[2mx\u001b[22m")).toBe("x");
  });

  it("passes file filters Playwright can match on every OS", () => {
    expect(fileFilter("C:\\repo", "C:\\repo\\tests\\agent\\cart\\a.spec.ts")).toBe("tests/agent/cart/a\\.spec\\.ts");
    expect(fileFilter("/repo", "/repo/tests/a (1).spec.ts")).toBe("tests/a \\(1\\)\\.spec\\.ts");
  });
});

describe("MCP config", () => {
  it("passes allowed origins, blocks payment providers and enables the testing tools", () => {
    const config = buildMcpConfig({
      env: { name: "s", baseURL: "https://a.example.com", origin: "https://a.example.com", allowedOrigins: ["https://a.example.com", "https://js.stripe.com"], allowDestructive: false, auth: { loginUrl: "/login", loginScript: "x" }, roles: {} },
      storageState: "/repo/.auth/s-c.json",
      configPath: "/x/mcp.json",
      outputDir: "/x/out",
      testIdAttribute: "data-qa",
      agentBrowser: { headless: true, browser: "chromium" },
    });
    expect(config.network.allowedOrigins).toEqual(["https://a.example.com", "https://js.stripe.com"]);
    expect(config.network.blockedOrigins).toContain("https://checkout.stripe.com");
    expect(config.network.blockedOrigins).not.toContain("https://js.stripe.com");
    expect(config.capabilities).toEqual(["testing"]);
    expect(config.testIdAttribute).toBe("data-qa");
    expect(config.browser.contextOptions.storageState).toBe("/repo/.auth/s-c.json");
  });
});

describe("run store", () => {
  it("persists redacted run state and numbered events, and reopens them", () => {
    const redactor = new Redactor([{ name: "P", value: "hunter22-secret" }]);
    const store = new RunStore({ runsDir: join(dir, "runs") }, redactor);
    const record: RunRecord = {
      id: "2026-11-11-abcd",
      mode: "task",
      env: "s",
      role: "c",
      request: "log in with hunter22-secret",
      model: "m",
      status: "created",
      createdAt: "2026-11-11T00:00:00.000Z",
      updatedAt: "2026-11-11T00:00:00.000Z",
      costUsd: 0,
      budgetUsd: 1,
      options: { autoApprove: false, planOnly: false },
      flows: [],
      changedFiles: [],
    };
    const run = store.create(record);
    const seen: number[] = [];
    run.bus.subscribe((e) => seen.push(e.seq));
    run.emit({ type: "log", level: "info", message: "typed hunter22-secret" });
    run.emit({ type: "run.stage_changed", stage: "planning" });
    expect(seen).toEqual([1, 2]);
    expect(readFileSync(join(run.dir, "run.json"), "utf8")).toContain(`log in with ${REDACTED}`);
    expect(run.events()[0]).toMatchObject({ seq: 1, type: "log", message: `typed ${REDACTED}` });
    expect(run.events(1).map((e) => e.seq)).toEqual([2]);

    const reopened = new RunStore({ runsDir: join(dir, "runs") }, redactor).get(record.id);
    reopened.emit({ type: "log", level: "info", message: "after restart" });
    expect(reopened.events().map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(store.list().map((r) => r.id)).toEqual([record.id]);
    expect(() => store.get("2026-01-01-ffff")).toThrow(/not found/);
    expect(() => store.get("../../etc")).toThrow(/not a run ID/);
  });
});
