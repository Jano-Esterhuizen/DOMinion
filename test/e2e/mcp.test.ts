import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BROWSER_VERIFY_TOOLS } from "../../src/core/agents/guard";
import { parseToolResultText, toolResultContent } from "../../src/core/agents/messages";
import { ensureSession } from "../../src/core/auth";
import { loadConfig } from "../../src/core/config/loader";
import { getEnvironment } from "../../src/core/config/resolve";
import { buildMcpLaunch, ensureMcpBrowser } from "../../src/core/mcp";
import { nonInteractivePrompter } from "../../src/core/prompter";
import { type FixtureApp, startFixtureApp } from "../fixture-app/server.mjs";
import { FIXTURE_ENV, makeFixtureConsumer, setEnv } from "../helpers/consumer";
import { removeDir } from "../helpers/tmp";

let fixture: FixtureApp;
let root: string;
let restoreEnv: () => void;
let client: Client;

const text = (result: unknown) => toolResultContent((result as { content: unknown }).content).text;

beforeAll(async () => {
  fixture = await startFixtureApp();
  root = makeFixtureConsumer("mcp", fixture.url);
  restoreEnv = setEnv({ ...FIXTURE_ENV });
  const loaded = await loadConfig({ cwd: root });
  const session = await ensureSession({ loaded, envName: "staging", roleName: "customer", prompter: nonInteractivePrompter() });
  await ensureMcpBrowser(loaded.config.agentBrowser);
  const launch = buildMcpLaunch({
    env: getEnvironment(loaded, "staging"),
    storageState: session.file,
    configPath: join(root, ".dominion", "runs", "test", "mcp.json"),
    outputDir: join(root, ".dominion", "runs", "test", "mcp-output"),
    testIdAttribute: loaded.config.testIdAttribute,
    agentBrowser: loaded.config.agentBrowser,
  });
  client = new Client({ name: "dominion-test", version: "0.0.0" });
  await client.connect(new StdioClientTransport({ command: launch.server.command, args: launch.server.args, cwd: root, stderr: "pipe" }));
}, 180_000);

afterAll(async () => {
  await client?.close();
  restoreEnv?.();
  await fixture?.close();
  if (root) removeDir(root);
});

describe("Playwright MCP launched with DOMinion's arguments", () => {
  it("exposes the browser and testing tools", async () => {
    const names = (await client.listTools()).tools.map((t) => t.name);
    for (const tool of ["browser_navigate", "browser_snapshot", "browser_click", ...BROWSER_VERIFY_TOOLS]) expect(names).toContain(tool);
  });

  it("starts logged in from the saved session", async () => {
    const result = await client.callTool({ name: "browser_navigate", arguments: { url: `${fixture.url}/account` } });
    expect(parseToolResultText(text(result))).toMatchObject({ code: expect.stringContaining("page.goto("), pageUrl: `${fixture.url}/account` });
    // Action results only link to a snapshot file; browser_snapshot returns the page inline.
    const page = text(await client.callTool({ name: "browser_snapshot", arguments: {} }));
    expect(page).toContain("Your account");
    expect(page).toContain("Signed in as Fixture Customer");
  });

  it("returns verified locators and assertion code in the formats the event parser reads", async () => {
    await client.callTool({ name: "browser_navigate", arguments: { url: `${fixture.url}/products` } });
    const verified = await client.callTool({ name: "browser_verify_element_visible", arguments: { role: "heading", accessibleName: "Products" } });
    expect(parseToolResultText(text(verified)).code).toMatch(/toBeVisible\(\)/);
    const snapshot = text(await client.callTool({ name: "browser_snapshot", arguments: {} }));
    // Refs look like e22, or f1e23 once the page has been replaced (frame-prefixed).
    const ref = /button "Add to cart" \[ref=([a-z0-9]+)\]/.exec(snapshot)?.[1];
    expect(ref, snapshot.slice(0, 1500)).toBeDefined();
    const clicked = text(await client.callTool({ name: "browser_click", arguments: { element: "Add to cart button", target: ref } }));
    expect(parseToolResultText(clicked).code).toMatch(/getByRole\('listitem'\)\.filter\(\{ hasText: 'Backpack/);
  });

  it("does not load pages from origins outside allowedOrigins", async () => {
    await client.callTool({ name: "browser_navigate", arguments: { url: "https://example.com/" } });
    const page = text(await client.callTool({ name: "browser_snapshot", arguments: {} }));
    expect(page).not.toContain("Example Domain");
  });
});
