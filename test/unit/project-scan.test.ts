import { cpSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { findPlaywrightConfigsInRepo, type ProjectScan, scanProject } from "../../src/core/project/scan";
import { makeTempDir, REPO_ROOT, removeDir } from "../helpers/tmp";

let root: string;
let scan: ProjectScan;

beforeAll(async () => {
  root = makeTempDir("scan");
  cpSync(join(REPO_ROOT, "test", "fixture-existing-suite"), root, { recursive: true });
  scan = await scanProject(root, "playwright.config.ts");
});
afterAll(() => removeDir(root));

describe("existing project scan", () => {
  it("finds every playwright config in a monorepo", () => {
    const mono = makeTempDir("mono");
    try {
      for (const p of ["playwright.config.ts", "apps/web/playwright.config.ts", "apps/admin/playwright.config.js", "node_modules/x/playwright.config.ts"]) {
        mkdirSync(join(mono, p, ".."), { recursive: true });
        writeFileSync(join(mono, p), "export default {};");
      }
      expect(findPlaywrightConfigsInRepo(mono)).toEqual(["playwright.config.ts", "apps/admin/playwright.config.js", "apps/web/playwright.config.ts"]);
    } finally {
      removeDir(mono);
    }
  });

  it("reads testDir, projects, setup project, storage state, baseURL and test id attribute", () => {
    const { config } = scan;
    expect(config.testDir.replace(/\\/g, "/")).toMatch(/\/e2e$/);
    expect(config.baseURL).toBe(process.env.BASE_URL ?? "http://127.0.0.1:4600");
    expect(config.testIdAttribute).toBe("data-testid");
    expect(config.projects.map((p) => [p.name, p.isSetup, p.dependencies, p.storageState])).toEqual([
      ["setup", true, [], undefined],
      ["chromium", false, ["setup"], "playwright/.auth/user.json"],
    ]);
  });

  it("finds custom fixtures, class page objects with methods and locators, and test files", () => {
    const { source } = scan;
    expect(source.fixtures).toEqual([{ file: "e2e/fixtures.ts", exportName: "test", exportsExpect: true, fixtures: ["productsPage", "cartPage"] }]);
    const products = source.pageObjects.find((p) => p.className === "ProductsPage")!;
    expect(products.file).toBe("e2e/pages/ProductsPage.ts");
    expect(products.methods).toEqual(["goto", "product", "addToCart"]);
    expect(products.locators.map((l) => l.name)).toEqual(["heading", "cartCount"]);
    expect(source.pageObjects.map((p) => p.className).sort()).toEqual(["CartPage", "LoginPage", "ProductsPage"]);
    expect(source.naming).toEqual({ spec: 0, test: 3 });
    expect(source.language).toBe("ts");
    expect(source.moduleFormat).toBe("esm");
    const cart = source.testFiles.find((t) => t.file === "e2e/cart.test.ts")!;
    expect(cart.titles).toEqual(["adds a product to the cart", "removes a product from the cart"]);
    expect(cart.steps).toEqual(["open the products page", "add the backpack", "see it in the cart"]);
    expect(source.testFiles.find((t) => t.file === "e2e/search.test.ts")!.urls).toEqual(["/"]);
  });

  it("picks exemplars that use the project's fixtures", () => {
    expect(scan.exemplars.length).toBeGreaterThanOrEqual(2);
    expect(scan.exemplars).toContain("e2e/cart.test.ts");
    expect(scan.exemplars.every((e) => e.endsWith(".test.ts"))).toBe(true);
  });
});
