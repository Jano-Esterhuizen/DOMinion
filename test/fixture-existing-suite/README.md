# fixture-existing-suite

A hand-written Playwright suite for the fixture shop (`../fixture-app`), used to test DOMinion's
existing-project support (spec: "Existing projects"). It deliberately differs from DOMinion's
defaults: `testDir` is `e2e/`, tests use custom fixtures (`e2e/fixtures.ts`) and class-based page
objects (`e2e/pages/`), auth comes from a setup project (`auth.setup.ts` writing
`playwright/.auth/user.json`), and files are named `*.test.ts`.

`cart.test.ts` already covers adding a product to the cart, so DOMinion should skip that flow.
Tests copy this folder into `test/.tmp/` before use; never run DOMinion against it in place.
