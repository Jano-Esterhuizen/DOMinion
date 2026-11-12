import { expect, test } from "./fixtures";

test.describe("Cart", () => {
  test("adds a product to the cart", async ({ productsPage, cartPage }) => {
    await test.step("open the products page", async () => {
      await productsPage.goto();
      await expect(productsPage.heading).toBeVisible();
    });

    await test.step("add the backpack", async () => {
      await productsPage.addToCart("Backpack");
      await expect(productsPage.cartCount).toHaveText("1");
    });

    await test.step("see it in the cart", async () => {
      await cartPage.goto();
      await expect(cartPage.item("Backpack")).toBeVisible();
    });
  });

  test("removes a product from the cart", async ({ productsPage, cartPage }) => {
    await productsPage.goto();
    await productsPage.addToCart("Bike Light");
    await cartPage.goto();
    await cartPage.remove("Bike Light");
    await expect(cartPage.page.getByText("Your cart is empty.")).toBeVisible();
  });
});
