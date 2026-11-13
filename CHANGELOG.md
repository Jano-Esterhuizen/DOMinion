# Changelog

All notable changes to DOMinion are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

**Prompt changes count:** a change to a default agent prompt (`src/prompts/`) that alters generated output is at least a minor version and gets its own entry under **Prompts**. Teams that ejected prompts with `dominion prompts eject` should compare their copies after upgrading.

## [Unreleased]

## [0.1.0] - 2026-11-13

First release.

### Added

- **CLI:** `init`, `doctor`, `auth`, `task`, `crawl`, `generate`, `heal`, `run`, `runs`, `prompts` and `ui`. Every command exits non-zero on failure, so each one works in CI.
- **Config:** `dominion.config.ts` with `defineConfig`, validated with clear errors. It is loaded without a build step, and `.env.local` is read for credentials.
- **Authentication:**
  - Strategies: `form` (with TOTP MFA), `manual`, `api`, `existing` and `none`.
  - Sessions are validated against `auth.validate`, refreshed automatically for `form` and `api` roles, and saved to `.auth/<env>-<role>.json`.
  - `api` logins can return cookies, headers or localStorage. Headers are applied everywhere the session is used and redacted like credentials.
- **Task mode:**
  - The planner explores the app through Playwright MCP and writes a Markdown plan, which you approve in the terminal or the UI.
  - The generator writes the spec using verified locators and the test generation rules, and every file is linted before it is saved.
  - DOMinion runs the tests itself, and the healer fixes failures up to an attempt limit. Real application bugs become `test.fixme` with the reason.
- **Crawl mode:**
  - A deterministic same-origin crawl that sends GET requests only, deduplicates URLs by pattern, and stops on session loss or CAPTCHAs.
  - A flow discovery agent that works from the sitemap, with a coverage view, flow selection, and planning two flows at a time.
- **Existing Playwright projects:**
  - Detection and a project profile, plus `playwright.dominion.config.ts` that extends your config without changing it.
  - Generated tests reuse your fixtures, page objects, naming and auth setup.
  - Hand-written files are never edited; changes to them come as proposed diffs. Flows your suite already covers are skipped, and `doctor` checks for profile drift.
- **Setup tab:** `npx dominion ui` works in a project with nothing set up yet, and a Setup checklist covers what `init` and its next steps do:
  - sets up Playwright and creates the DOMinion config, showing the detected layout first for existing suites;
  - edits the app's settings, adds and removes roles, and saves credentials write-only to `.env.local`;
  - writes the login script from a form it fills in by detecting the login page's fields, then runs a test login.

  Minion runner (task and crawl runs) unlocks when the checklist is done. Edits to `dominion.config.ts` only touch plain values and keep comments; computed values are left alone. Running `npx dominion` on its own now says how to get started.
- **Playwright UI tab:** opens Playwright's UI mode (`playwright test --ui`) for the project in its own window, showing every test, generated or not. It uses the project's Playwright and config, with API keys removed from its environment, and closes when `dominion ui` stops.
- **`dominion uninstall`:** removes everything DOMinion added to a project, after showing the list and asking:
  - its config, folders and saved logins;
  - generated tests and plans (`--keep-tests` keeps them);
  - its variables in `.env.local`;
  - its edits to `playwright.config.ts`, which goes back to exactly what it was.

  It then uninstalls the package. Hand-written files and `.gitignore` are left alone. `--dry-run` only lists.
- **License:** DOMinion is proprietary; see [LICENSE](LICENSE). You may install and run the unmodified package, but not copy, modify, reuse or redistribute its code, prompts or templates. Tests and other files it generates in your project are yours.
- **CommonJS projects:** `dominion-playwright` and `dominion-playwright/setup` also ship as CommonJS. Projects without `"type": "module"`, the default for `npm init playwright`, can then run the generated `dominion.setup.ts` in Playwright.
- **Clearer login errors:** when a login fails because `dominion/auth/login.ts` is still the template, the error says so and points to Setup step 6. Test login also warns about this before you run it.
- **Local UI:**
  - Start, Run, Flows, Plan review, Results and Settings screens, with a live event stream that survives a page reload.
  - Binds to 127.0.0.1 and requires a per-start token. Host and Origin headers are checked.
- **Prompt overrides:**
  - Commit `dominion/prompts/<name>.md` to replace a default prompt. `dominion prompts eject` copies defaults to start from.
  - `doctor` flags unknown placeholders and misnamed files.
- **Setting up a new project:** `init` keeps stock Playwright projects (create-playwright's `chromium`) from running the generated tests without DOMinion's session by adding `testIgnore` to them, with your consent.
- **Credentials in existing projects:** `secretEnv` config for credentials an existing suite reads. `init` fills it from the suite's sources, and `.env.local` entries with credential-like names are redacted even when the config doesn't list them.
- **Safety:**
  - Secret redaction across logs, events, reports and run files.
  - A tool guard for agents: no secret files, no shell, origins restricted to `allowedOrigins`, no irreversible actions unless `allowDestructive`.
  - Budgets for turns and USD per run.

### Prompts

- Initial `planner`, `generator`, `healer`, `discovery`, `analysis` and `rules` prompts.

[Unreleased]: https://github.com/Jano-Esterhuizen/DOMinion/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/Jano-Esterhuizen/DOMinion/releases/tag/v0.1.0
