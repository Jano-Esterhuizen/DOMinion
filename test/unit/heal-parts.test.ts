import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { healerContentCheck, specTags } from "../../src/core/agents/healer";
import type { AgentContext } from "../../src/core/agents/context";
import { fixmeReasonFromSource } from "../../src/core/orchestrator/pipeline";
import { assertionCount, markTestFixme, testTitles } from "../../src/core/playwright/fixme";
import { Redactor } from "../../src/core/redact";
import { ADD_TO_CART_SPEC } from "../helpers/fixture-scripts";
import { makeTempDir, removeDir } from "../helpers/tmp";

const dir = makeTempDir("heal-parts");
afterAll(() => removeDir(dir));

describe("markTestFixme", () => {
  it("marks the test at the reported position and explains why", () => {
    const file = join(dir, "a.spec.ts");
    writeFileSync(file, ADD_TO_CART_SPEC("r"));
    const line = ADD_TO_CART_SPEC("r").split("\n").findIndex((l) => l.includes('test("empty cart message"')) + 1;
    expect(markTestFixme(file, { line, column: 3, title: "Add to cart > empty cart message" }, "the cart page shows an error instead of the empty state")).toBe(true);
    const out = readFileSync(file, "utf8");
    expect(out).toContain('  // DOMinion: the cart page shows an error instead of the empty state\n  test.fixme("empty cart message"');
    expect(out).toContain('  test("add a product from the listing page"');
    expect(fixmeReasonFromSource(file, line + 1)).toBe("the cart page shows an error instead of the empty state");
    expect(markTestFixme(file, { line: line + 1, column: 3, title: "empty cart message" }, "again")).toBe(false);
  });

  it("falls back to the title when the file moved, keeps CRLF, and keeps comments single-line", () => {
    const file = join(dir, "b.spec.ts");
    writeFileSync(file, ADD_TO_CART_SPEC("r").replace(/\n/g, "\r\n"));
    expect(markTestFixme(file, { line: 999, column: 1, title: "add a product from the listing page" }, "line one\nline two */ end")).toBe(true);
    const out = readFileSync(file, "utf8");
    expect(out).toContain("  // DOMinion: line one line two * / end\r\n  test.fixme(\"add a product from the listing page\"");
    expect(out).not.toMatch(/[^\r]\n/);
    expect(markTestFixme(file, { line: 1, column: 1, title: "no such test" }, "x")).toBe(false);
  });

  it("counts tests and assertions", () => {
    const spec = ADD_TO_CART_SPEC("r");
    expect(testTitles(spec)).toEqual(["add a product from the listing page", "empty cart message"]);
    expect(assertionCount(spec)).toBe(6);
    expect(specTags(spec)).toEqual({ flow: "add-to-cart", role: "customer" });
  });
});

describe("healer content check", () => {
  const file = join(dir, "tests", "agent", "cart", "add-to-cart.spec.ts");
  const ctx = {
    paths: { root: dir },
    redactor: new Redactor(),
    env: { baseURL: "https://app.example.com" },
  } as unknown as AgentContext;
  const check = healerContentCheck(ctx, false);
  const original = ADD_TO_CART_SPEC("r");

  it("allows a locator fix and a fixme with a reason", () => {
    mkdirSync(join(dir, "tests", "agent", "cart"), { recursive: true });
    writeFileSync(file, original);
    expect(check(file, original.replace('name: "Add to cart" })', 'name: "Add to basket" })'))).toBeUndefined();
    expect(check(file, original.replace('  test("empty cart message"', '  // DOMinion: app bug\n  test.fixme("empty cart message"'))).toBeUndefined();
  });

  it("rejects edits that remove assertions or rename tests", () => {
    writeFileSync(file, original);
    expect(check(file, original.replace("      await expect(badge).toHaveText(String(before + 1));\n", ""))).toMatch(/removes assertions/);
    expect(check(file, original.replace('test("empty cart message"', 'test("cart"'))).toMatch(/renames, adds or removes tests/);
    expect(check(file, original.replace('await page.goto("/cart");', 'await page.goto("/cart");\n      await page.waitForTimeout(500);'))).toMatch(/waitForTimeout/);
  });

  it("leaves hand-written files alone unless --include-manual", () => {
    const manual = join(dir, "tests", "agent", "manual.spec.ts");
    const source = 'import { test, expect } from "@playwright/test";\ntest("x", async ({ page }) => { await expect(page).toHaveURL(/a/); });\n';
    writeFileSync(manual, source);
    expect(check(manual, source.replace("/a/", "/b/"))).toMatch(/written by a person/);
    expect(healerContentCheck(ctx, true)(manual, source.replace("/a/", "/b/"))).toBeUndefined();
  });
});
