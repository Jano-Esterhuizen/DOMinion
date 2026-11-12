import { expect, test } from "./fixtures";

test("finds products by name", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Search products").fill("Bike");
  await page.getByRole("button", { name: "Search" }).click();
  await expect(page).toHaveURL(/\/search\?q=Bike/);
  await expect(page.getByRole("list", { name: "Search results" }).getByRole("listitem")).toHaveCount(1);
});
