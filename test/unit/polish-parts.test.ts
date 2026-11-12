import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ejectPrompts, inspectPromptOverrides, renderPrompt } from "../../src/core/agents/prompts";
import { addSessionSecrets, readSessionHeaders, sessionHeadersFile, writeSessionHeaders } from "../../src/core/auth/headers";
import type { ManagedProjectEntry } from "../../src/core/playwright/patch";
import { patchPlaywrightConfig, renderManagedBlock } from "../../src/core/playwright/patch";
import { Redactor } from "../../src/core/redact";
import { summarizeRun } from "../../src/core/runs/list";
import { makeTempDir, removeDir, writeFiles } from "../helpers/tmp";

const dirs: string[] = [];
const tmp = (name: string) => {
  const dir = makeTempDir(name);
  dirs.push(dir);
  return dir;
};
afterAll(() => dirs.forEach(removeDir));

const API_ENTRY: ManagedProjectEntry = { env: "staging", role: "api", baseURL: "https://staging.example.com", storageState: ".auth/staging-api.json", testDir: "tests/agent", sessionHeaders: true };
const FORM_ENTRY: ManagedProjectEntry = { env: "staging", role: "customer", baseURL: "https://staging.example.com", storageState: ".auth/staging-customer.json", testDir: "tests/agent" };

describe("session headers", () => {
  it("live beside the storage state and round-trip", () => {
    const dir = tmp("headers");
    const state = join(dir, ".auth", "staging-api.json");
    expect(sessionHeadersFile(state)).toBe(join(dir, ".auth", "staging-api.headers.json"));
    expect(readSessionHeaders(state)).toBeUndefined();
    writeSessionHeaders(state, { Authorization: "Bearer abcdef0123456789" });
    expect(readSessionHeaders(state)).toEqual({ Authorization: "Bearer abcdef0123456789" });
    writeSessionHeaders(state, undefined);
    expect(readSessionHeaders(state)).toBeUndefined();
  });

  it("are registered as secrets, including the bare bearer token", () => {
    const dir = tmp("headers-secret");
    const state = join(dir, ".auth", "x.json");
    writeSessionHeaders(state, { Authorization: "Bearer tok_0123456789abcdef", "X-Api-Key": "key-9876543210" });
    const redactor = new Redactor();
    addSessionSecrets(redactor, state);
    expect(redactor.redact("auth=Bearer tok_0123456789abcdef; token tok_0123456789abcdef; key key-9876543210")).toBe("auth=[REDACTED]; token [REDACTED]; key [REDACTED]");
  });
});

describe("managed block for api roles", () => {
  it("sends the session headers only for api roles", () => {
    const block = renderManagedBlock([FORM_ENTRY, API_ENTRY], "");
    expect(block).toContain('storageState: ".auth/staging-api.json", extraHTTPHeaders: sessionHeaders(".auth/staging-api.json") }');
    expect(block).toContain('storageState: ".auth/staging-customer.json" }');
  });

  it("adds the import after the last import, once", () => {
    const dir = tmp("patch-import");
    const config = join(dir, "playwright.config.ts");
    writeFileSync(config, 'import { defineConfig } from "@playwright/test";\nimport os from "node:os";\n\nexport default defineConfig({\n  projects: [],\n});\n');
    expect(patchPlaywrightConfig(config, [API_ENTRY]).status).toBe("patched");
    const text = readFileSync(config, "utf8");
    expect(text.split("\n").slice(0, 3)).toEqual(['import { defineConfig } from "@playwright/test";', 'import os from "node:os";', 'import { sessionHeaders } from "@yourorg/dominion/setup";']);
    expect(patchPlaywrightConfig(config, [API_ENTRY]).status).toBe("unchanged");
    expect(readFileSync(config, "utf8").match(/sessionHeaders } from/g)).toHaveLength(1);
  });

  it("adds the import when an api role appears in an existing managed block", () => {
    const dir = tmp("patch-refresh");
    const config = join(dir, "playwright.config.ts");
    writeFileSync(config, 'import { defineConfig } from "@playwright/test";\nexport default defineConfig({\n  projects: [],\n});\n');
    patchPlaywrightConfig(config, [FORM_ENTRY]);
    expect(readFileSync(config, "utf8")).not.toContain("sessionHeaders");
    expect(patchPlaywrightConfig(config, [FORM_ENTRY, API_ENTRY]).status).toBe("patched");
    expect(readFileSync(config, "utf8")).toContain('import { sessionHeaders } from "@yourorg/dominion/setup";');
  });

  it("leaves a CommonJS config for the user, with the import in the snippet", () => {
    const dir = tmp("patch-cjs");
    const config = join(dir, "playwright.config.js");
    const source = 'const { defineConfig } = require("@playwright/test");\nmodule.exports = defineConfig({\n  projects: [],\n});\n';
    writeFileSync(config, source);
    const result = patchPlaywrightConfig(config, [API_ENTRY]);
    expect(result.status).toBe("manual");
    expect(result.reason).toMatch(/CommonJS/);
    expect(result.snippet).toContain('import { sessionHeaders } from "@yourorg/dominion/setup";');
    expect(readFileSync(config, "utf8")).toBe(source);
  });
});

describe("prompt overrides", () => {
  it("finds problems before a run would hit them", () => {
    const dir = tmp("prompts");
    writeFiles(dir, {
      "planner.md": "Plan. {{rules}} Use {{testIdAttribute}}.",
      "discovery.md": "Find flows for {{appName}}.",
      "rules.md": "",
      "notes.txt": "ignored",
      "plannerx.md": "typo",
    });
    const byName = Object.fromEntries(inspectPromptOverrides(dir).map((o) => [o.name, o.problems]));
    expect(byName).toEqual({
      discovery: ["uses unknown placeholder {{appName}} (available: none)"],
      planner: [],
      plannerx: [expect.stringMatching(/not a DOMinion prompt/)],
      rules: ["is empty"],
    });
  });

  it("renders an override with the overridden rules", () => {
    const dir = tmp("prompts-render");
    writeFiles(dir, { "generator.md": "GEN\n{{rules}}", "rules.md": "RULES for {{testIdAttribute}}" });
    expect(renderPrompt("generator", { testIdAttribute: "data-qa" }, dir)).toBe("GEN\nRULES for data-qa");
  });

  it("ejects defaults and never overwrites", () => {
    const dir = tmp("eject");
    writeFiles(dir, { "healer.md": "mine" });
    const results = ejectPrompts(dir, ["planner", "healer"]);
    expect(results.map((r) => r.status)).toEqual(["created", "exists"]);
    expect(readFileSync(join(dir, "healer.md"), "utf8")).toBe("mine");
    expect(readFileSync(join(dir, "planner.md"), "utf8").length).toBeGreaterThan(100);
  });
});

describe("run summaries", () => {
  it("count test results across flows and flag runs still in progress", () => {
    const summary = summarizeRun({
      id: "2026-11-12-abcd",
      mode: "crawl",
      env: "staging",
      role: "customer",
      model: "m",
      status: "generating",
      createdAt: "2026-11-12T10:00:00.000Z",
      updatedAt: "2026-11-12T10:01:00.000Z",
      costUsd: 2,
      budgetUsd: 10,
      options: { autoApprove: true, planOnly: false },
      changedFiles: [],
      flows: [
        { id: "a", name: "A", request: "a", status: "done", feedback: [], specFiles: ["a.spec.ts"], supportFiles: [], costUsd: 1, results: [{ file: "a.spec.ts", title: "1", status: "passed", durationMs: 1 }, { file: "a.spec.ts", title: "2", status: "failed", durationMs: 1 }] },
        { id: "b", name: "B", request: "b", status: "generating", feedback: [], specFiles: ["a.spec.ts", "b.spec.ts"], supportFiles: [], costUsd: 1, results: [{ file: "b.spec.ts", title: "3", status: "passed", durationMs: 1 }] },
      ],
    });
    expect(summary).toMatchObject({ active: true, flows: 2, tests: { passed: 2, failed: 1 }, specFiles: ["a.spec.ts", "b.spec.ts"], durationMs: undefined });
  });
});
