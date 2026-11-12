import { expect, test as setup } from "@playwright/test";
import { LoginPage } from "./pages/LoginPage";

const authFile = "playwright/.auth/user.json";

setup("authenticate", async ({ page }) => {
  const login = new LoginPage(page);
  await login.goto();
  await login.signIn(process.env.E2E_USER ?? "", process.env.E2E_PASS ?? "");
  await expect(page.getByRole("heading", { name: "Your account" })).toBeVisible();
  await page.context().storageState({ path: authFile });
});
