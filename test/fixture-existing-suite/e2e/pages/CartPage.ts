import type { Locator, Page } from "@playwright/test";

export class CartPage {
  readonly heading: Locator;
  readonly total: Locator;
  readonly checkoutLink: Locator;

  constructor(readonly page: Page) {
    this.heading = page.getByRole("heading", { name: "Your cart" });
    this.total = page.getByTestId("cart-total");
    this.checkoutLink = page.getByRole("link", { name: "Checkout" });
  }

  async goto() {
    await this.page.goto("/cart");
  }

  item(name: string): Locator {
    return this.page.getByRole("listitem").filter({ hasText: name });
  }

  async remove(name: string) {
    await this.item(name).getByRole("button", { name: "Remove" }).click();
  }
}
