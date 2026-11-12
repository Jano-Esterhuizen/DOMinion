import { expect, test } from "./fixtures";
import { LoginPage } from "./pages/LoginPage";

test.describe("Login", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("rejects a wrong password", async ({ page }) => {
    const login = new LoginPage(page);
    await login.goto();
    await login.signIn("nobody@example.test", "definitely-wrong");
    await expect(login.error).toHaveText("Invalid email or password");
  });
});
