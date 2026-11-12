import { describe, expect, it } from "vitest";
import { compactSitemap, discoveryJsonSchema, normalizeDiscovered, parseDiscovery } from "../../src/core/agents/flowDiscovery";
import type { AgentResult } from "../../src/core/agents/runner";
import { parseFlowSelection } from "../../src/cli/commands/crawl";
import type { Sitemap } from "../../src/core/crawler/crawl";
import { DENIED_LINK_TEXT, isIdSegment, normalizeUrl } from "../../src/core/crawler/normalize";
import type { DiscoveredFlow } from "../../src/core/orchestrator/types";
import { FIXTURE_FLOWS } from "../helpers/fixture-scripts";

const BASE = "https://shop.example.com";
const result = (partial: Partial<AgentResult>): AgentResult => ({ ok: true, subtype: "success", text: "", costUsd: 0, turns: 1, errors: [], ...partial });

describe("URL normalization", () => {
  it.each([
    ["/products/42", `${BASE}/products/:id`],
    ["/orders/3f2a1c9e-5b7d-4e2f-9a1b-0c8d7e6f5a4b/items", `${BASE}/orders/:id/items`],
    ["/blog/how-to-choose-the-right-backpack-for-hiking", `${BASE}/blog/:id`],
    ["/sku/AB12CD345", `${BASE}/sku/:id`],
    ["/api/v2/users", `${BASE}/api/v2/users`],
    ["/products/#reviews", `${BASE}/products`],
    ["/products?category=gear&utm_source=x", `${BASE}/products?category=gear`],
    ["/products?utm_source=x", `${BASE}/products`],
    ["/search?q=bike&page=2", `${BASE}/search?q=bike`],
  ])("%s -> %s", (raw, pattern) => {
    expect(normalizeUrl(raw, BASE, ["category", "q"])?.pattern).toBe(pattern);
  });

  it("keeps the concrete URL, drops credentials, hashes and non-http links", () => {
    expect(normalizeUrl("https://user:pw@shop.example.com/p/1?b=2&a=1#x", BASE, ["a", "b"])?.url).toBe(`${BASE}/p/1?a=1&b=2`);
    expect(normalizeUrl("mailto:a@example.com", BASE)).toBeUndefined();
    expect(normalizeUrl("javascript:void(0)", BASE)).toBeUndefined();
  });

  it("recognises identifiers but not route names", () => {
    expect(isIdSegment("123")).toBe(true);
    expect(isIdSegment("checkout")).toBe(false);
    expect(isIdSegment("v1")).toBe(false);
    expect(isIdSegment("my-account")).toBe(false);
  });

  it("denies log out, delete and unsubscribe links", () => {
    for (const text of ["Log out", "Sign out", "Logout", "Delete account", "Remove my account", "Unsubscribe"]) expect(DENIED_LINK_TEXT.test(text), text).toBe(true);
    for (const text of ["Products", "Login", "Account", "Cart 2"]) expect(DENIED_LINK_TEXT.test(text), text).toBe(false);
  });
});

describe("flow discovery output", () => {
  it("accepts structured output or JSON text and validates it", () => {
    const flows = FIXTURE_FLOWS(BASE);
    expect(parseDiscovery(result({ structured: flows }))).toMatchObject({ ok: true });
    expect(parseDiscovery(result({ text: `Here you go:\n\`\`\`json\n${JSON.stringify(flows)}\n\`\`\`` }))).toMatchObject({ ok: true });
    const bad = parseDiscovery(result({ structured: { flows: [{ id: "x", priority: "urgent" }] } }));
    expect(bad.ok).toBe(false);
    expect(!bad.ok && bad.error).toMatch(/flows\.0\.priority/);
    expect(parseDiscovery(result({ text: "no json here" })).ok).toBe(false);
  });

  it("normalizes ids and keeps start URLs on the app", () => {
    const flows = normalizeDiscovered(
      {
        flows: [
          { id: "Add To Cart!", name: "Add to cart", priority: "critical", startUrl: "/products/:id", pagesInvolved: [], description: "d", destructive: false },
          { id: "add-to-cart", name: "Again", priority: "high", startUrl: "https://evil.example.net/", pagesInvolved: [], description: "d", destructive: false },
        ],
      },
      BASE,
    );
    expect(flows.map((f) => [f.id, f.startUrl])).toEqual([
      ["add-to-cart", `${BASE}/products/1`],
      ["add-to-cart-2", BASE],
    ]);
  });

  it("produces a JSON schema for structured output", () => {
    const schema = discoveryJsonSchema() as { properties: { flows: { items: { required: string[] } } } };
    expect(schema.properties.flows.items.required).toEqual(expect.arrayContaining(["id", "priority", "startUrl", "destructive"]));
  });

  it("keeps the sitemap the agent reads compact", () => {
    const sitemap: Sitemap = {
      baseURL: BASE,
      role: "customer",
      startedAt: "",
      finishedAt: "",
      stoppedReason: "complete",
      edges: [],
      pages: Array.from({ length: 300 }, (_, i) => ({
        url: `${BASE}/p/${i}`,
        pattern: `${BASE}/p${i}`,
        title: `Page ${i}`,
        status: 200,
        depth: 1,
        ariaSnapshot: "x".repeat(4000),
        counts: { forms: 0, inputs: 0, buttons: 1, links: 3 },
        buttons: ["Buy"],
        headings: ["Heading"],
        links: [],
      })),
    };
    expect(compactSitemap(sitemap).length).toBeLessThanOrEqual(120_100);
  });
});

describe("CLI flow selection", () => {
  const flows = FIXTURE_FLOWS(BASE).flows as DiscoveredFlow[];
  it("parses numbers, ids, critical, all and none", () => {
    expect(parseFlowSelection("", flows)).toEqual(["add-to-cart", "checkout", "login"]);
    expect(parseFlowSelection("critical", flows)).toEqual(["add-to-cart", "checkout", "login"]);
    expect(parseFlowSelection("all", flows)).toHaveLength(4);
    expect(parseFlowSelection("none", flows)).toEqual([]);
    expect(parseFlowSelection("1, 4", flows)).toEqual(["add-to-cart", "search"]);
    expect(parseFlowSelection("search 1 1", flows)).toEqual(["search", "add-to-cart"]);
    expect(parseFlowSelection("9", flows)).toBeUndefined();
  });
});
