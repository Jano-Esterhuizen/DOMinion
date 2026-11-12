import type { Locator, Page } from "@playwright/test";

export class ProductsPage {
  readonly heading: Locator;
  readonly cartCount: Locator;

  constructor(readonly page: Page) {
    this.heading = page.getByRole("heading", { name: "Products", exact: true });
    this.cartCount = page.getByTestId("cart-count");
  }

  async goto() {
    await this.page.goto("/products");
  }

  product(name: string): Locator {
    return this.page.getByRole("listitem").filter({ hasText: name });
  }

  async addToCart(name: string) {
    await this.product(name).getByRole("button", { name: "Add to cart" }).click();
  }
}
