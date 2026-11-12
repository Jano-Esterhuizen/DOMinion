import { test as base, expect } from "@playwright/test";
import { CartPage } from "./pages/CartPage";
import { ProductsPage } from "./pages/ProductsPage";

type Pages = {
  productsPage: ProductsPage;
  cartPage: CartPage;
};

export const test = base.extend<Pages>({
  productsPage: async ({ page }, use) => {
    await use(new ProductsPage(page));
  },
  cartPage: async ({ page }, use) => {
    await use(new CartPage(page));
  },
});

export { expect };
