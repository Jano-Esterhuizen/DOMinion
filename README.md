# DOMinion

AI-driven Playwright test authoring. Describe a flow in plain English, or let DOMinion crawl your app, review the test plan it writes, and get verified, runnable Playwright tests committed to your repo. Generated tests are ordinary Playwright specs that run without DOMinion.

- **Task mode:** `"write tests for the add to cart workflow"` → plan → your approval → spec → run → heal.
- **Crawl mode:** a deterministic crawl of the site → the critical user flows it found → you pick the flows → plans (and tests) for each.
- **Healing:** broken locators, waits and assertions are fixed; real application bugs are marked `test.fixme` with the reason.

Agents never see a password. Deterministic Playwright code logs in, saves a session, and agents and tests both start from it.

> **Only test applications you own or are authorized to test**, ideally a non-production environment with dedicated test accounts. DOMinion never solves CAPTCHAs or bypasses bot protection.

## Requirements

- Node.js 20 or later
- A Playwright project (`@playwright/test` 1.56 or later). DOMinion uses your Playwright version for tests.
- `ANTHROPIC_API_KEY` for the commands that run agents (`task`, `crawl`, `generate`, `heal`, and `init` in an existing suite). `auth`, `doctor`, `run`, `runs` and `ui` work without it.

## Quick start

```sh
npm install -D dominion-playwright && npx dominion ui
```

The package is `dominion-playwright` on npm; the command it installs is `dominion`. The browser UI opens with three tabs:

- **Setup** walks you through everything as a checklist. Each step's button maps to a CLI command:
  1. **Playwright:** sets it up if the project has none (TypeScript or JavaScript, Chromium).
  2. **Claude API key.**
  3. **DOMinion project:** creates `dominion.config.ts`. In a repo with an existing suite, it shows the layout it detected first.
  4. **Your app:** base URL, login page, and the page that proves you are logged in.
  5. **Roles and credentials.**
  6. **Login script:** *Detect from login page* reads your form and writes `dominion/auth/login.ts` for you.
  7. **Test login.**
- **Minion runner** unlocks when nothing is left to do. It starts task and crawl runs, shows them live, and holds plan review, flow selection and results.
- **Playwright UI** opens Playwright's UI mode for the project in its own window, the same as `npx playwright test --ui`. It shows every test: your own and the ones DOMinion generated. In a new setup, generated tests run in the `dominion-<env>-<role>` projects, which log in first. Close it from the tab or by closing its window. It also closes when `dominion ui` stops.

Credentials and the API key are saved to `.env.local`, which Setup adds to `.gitignore` first. They are write-only: the UI shows "saved" or "not set", never the values. The UI only listens on 127.0.0.1 and needs the link `dominion ui` prints, because it carries a per-start token.

Prefer the terminal? The same setup from the CLI:

```sh
npx dominion init --base-url https://staging.example.com
# fill in .env.local, adjust the selectors in dominion/auth/login.ts
npx dominion auth staging
npx dominion task staging "write tests for the add to cart workflow"
npx dominion run
```

### What `init` creates

| Path | Commit it? | Purpose |
|---|---|---|
| `dominion.config.ts` | yes | Environments, roles, crawl settings and budgets. Names env vars, never holds secrets. |
| `dominion/auth/login.ts` | yes | Your login script for `form` roles, with clearly marked selectors. |
| `.env.local` | **no** | Credential values, one line per env var the config names. |
| `specs/` | yes | Markdown test plans written by the planner and approved by you. |
| `tests/agent/` | yes | Generated specs (tagged `@dominion`). |
| `.auth/`, `.dominion/` | **no** | Saved sessions and local run state. `init` adds both to `.gitignore`. |

`init` never overwrites a file; it tells you what it skipped. In a repo without Playwright, it offers to run `npm init playwright@latest` first (`--yes` accepts). If a Playwright project such as create-playwright's `chromium` would also pick up `tests/agent/`, `init` asks to add `testIgnore: "**/tests/agent/**"` to it. Otherwise that project would run the generated tests without DOMinion's session, and plain `npx playwright test` would fail. Run `init` in a repo that already has a Playwright suite and it adopts the suite's conventions instead (see [Existing Playwright projects](#existing-playwright-projects)).

## How a run works

1. **Session.** DOMinion checks the role's saved session (it opens `auth.validate.url` and fails if it lands on `loggedOutPattern`) and logs in again if needed.
2. **Plan.** The planner explores the app in a real browser through [Playwright MCP](https://github.com/microsoft/playwright-mcp) and writes `specs/<flow>.md`.
3. **Approve.** In the terminal (`y` approve, `n` reject, `e` edit, `r` regenerate with feedback) or the UI. Nothing is generated until a plan is approved. In CI, pass `--auto-approve`.
4. **Generate.** The generator writes a spec with verified locators. Every file is linted before it is saved: no `waitForTimeout`, no `page.evaluate`, no env access, web-first assertions only.
5. **Run.** DOMinion, not an agent, runs the new tests with your Playwright and parses the JSON report.
6. **Heal.** Failures go to the healer, up to `budgets.maxHealAttempts` per test. Real application bugs become `test.fixme("…")` with the reason as a comment.

Each run is recorded under `.dominion/runs/<runId>/` (`run.json`, `events.jsonl`, the sitemap, traces). `npx dominion runs` lists runs with their status, test results and cost.

## Configuration

```ts
import { defineConfig } from "dominion-playwright";

export default defineConfig({
  model: "claude-sonnet-5-5",          // overridable per command with --model
  testDir: "tests/agent",
  specsDir: "specs",
  testIdAttribute: "data-testid",
  secretEnv: [],                       // other env vars holding credentials (redacted, hidden from agents)

  environments: {
    staging: {
      baseURL: "https://staging.myapp.com",
      allowedOrigins: ["https://staging.myapp.com", "https://auth.staging.myapp.com"],
      allowDestructive: false,         // agents stop before final submit / pay / delete actions
      auth: {
        loginUrl: "/login",
        loginScript: "./dominion/auth/login.ts",
        validate: { url: "/account", loggedOutPattern: "/login" },
      },
      roles: {
        guest:    { strategy: "none" },
        customer: { strategy: "form", userEnv: "STAGING_CUSTOMER_USER", passEnv: "STAGING_CUSTOMER_PASS" },
        admin:    { strategy: "form", userEnv: "STAGING_ADMIN_USER", passEnv: "STAGING_ADMIN_PASS", totpEnv: "STAGING_ADMIN_TOTP" },
      },
    },
  },

  crawl: { maxPages: 200, maxDepth: 4, exclude: ["/logout", "/account/delete"], keepQueryParams: ["category", "q"] },
  budgets: { maxTurnsPerAgent: 80, maxUsdPerRun: 10, maxHealAttempts: 3 },
});
```

`npx dominion doctor` checks the config, Node and Playwright versions, env vars, sessions, prompt overrides and the API key, and tells you exactly what to fix.

## Authentication

| Strategy | Use it for | How it works |
|---|---|---|
| `form` | Username and password, optionally with TOTP MFA | Runs `dominion/auth/login.ts` with credentials from the env vars the role names. `credentials.totp()` returns a fresh code. |
| `manual` | SSO, hardware keys, push MFA | Opens a browser at `loginUrl`; you log in by hand, then press Enter (CLI) or click Done (UI). Not usable in CI. |
| `api` | Apps with a login endpoint or token | Calls your module with a Playwright request context; the cookies, headers or localStorage it returns become the session. |
| `existing` | Suites that already have a setup project | Runs your setup project and uses its storage state. Set up by `init` for existing suites. |
| `none` | Guest flows | No session. |

Sessions are saved to `.auth/<env>-<role>.json`. `form` and `api` roles log in again automatically when a session expires, before a run and inside Playwright's setup project, so `npx playwright test` refreshes them too.

### The `api` strategy

```ts
// dominion.config.ts
roles: {
  api_user: { strategy: "api", userEnv: "STAGING_API_USER", passEnv: "STAGING_API_PASS", apiLogin: "./dominion/auth/api-login.ts" },
}
```

```ts
// dominion/auth/api-login.ts
import type { ApiLoginContext, ApiLoginResult } from "dominion-playwright";

export default async function login({ request, credentials }: ApiLoginContext): Promise<ApiLoginResult> {
  const response = await request.post("/api/login", {
    data: { email: credentials.username, password: credentials.password },
  });
  if (!response.ok()) throw new Error(`login failed with ${response.status()}`);
  const { token } = await response.json();
  return { headers: { Authorization: `Bearer ${token}` } };
}
```

- `credentials` holds whatever the role names: `userEnv` → `username`, `passEnv` → `password`, `tokenEnv` → `token`, `totpEnv` → `totp()`.
- Return any of `cookies` (`[{ name, value, domain?, path?, expires?, httpOnly?, secure?, sameSite? }]`), `headers`, or `localStorage` (keyed by origin). Cookies the `request` context received, such as a `Set-Cookie` from your login endpoint, are kept even if you return nothing.
- Headers are saved next to the session in `.auth/<env>-<role>.headers.json` and sent by the session check, the crawler, the agents' browser and the role's Playwright project. For the project, DOMinion adds `extraHTTPHeaders: sessionHeaders(...)` and the matching import to its managed block in `playwright.config.ts`. Note that `extraHTTPHeaders` are sent with every request the browser makes, including to other origins.
- Set `auth.apiLogin` on the environment to share one module between roles.

## Crawl mode

```sh
npx dominion crawl staging                       # crawl, then choose flows in the terminal
npx dominion crawl staging --flows login,checkout
npx dominion crawl staging --auto-approve --plan-only   # CI: plan every critical flow, generate nothing
```

The crawler is deterministic: same-origin links only, GET requests only, no forms submitted. Logout, delete and unsubscribe links are skipped, along with anything in `crawl.exclude`. URLs are deduplicated by pattern (`/products/42` → `/products/:id`). It stops and reports if the session is lost or a CAPTCHA appears. The discovery agent proposes flows from the resulting sitemap and marks flows your existing tests already cover. Two flows are planned at a time.

## Existing Playwright projects

Run `init` in a repo that already has a Playwright suite. DOMinion scans it for the test directory, fixtures, page objects, naming, tags and auth setup, shows you the profile, and records it in `dominion.config.ts` once you confirm. After that:

- Your `playwright.config.ts` is never modified. DOMinion writes `playwright.dominion.config.ts`, which extends it.
- Generated tests use your fixtures and page objects and live in your `testDir` with the `@dominion` tag, so your CI runs them. Use `--grep @dominion` or `--grep-invert @dominion` to include or exclude them.
- Hand-written files are never edited. Changes to them are proposed as diffs for you to review.
- The planner skips flows your suite already covers.
- `doctor` warns when the profile drifts from the repo.
- Credentials your suite reads (`process.env.E2E_PASS` in `auth.setup.ts`, for example) are listed as `secretEnv` in `dominion.config.ts` and added to `.env.local`. Their values are redacted from everything DOMinion writes and hidden from its agents, but your setup project and tests still get them.

## CLI

| Command | Purpose |
|---|---|
| `dominion init` | Scaffold config, folders, templates and `.gitignore` entries (`--base-url`, `--yes`, `--playwright-config`) |
| `dominion doctor` | Check everything a run needs (`--env`, `--no-sessions`) |
| `dominion auth <env>` | Log in and save a session (`--role`, `--headed`, `--force`) |
| `dominion ui` | Start the local UI on 127.0.0.1 with a per-start token (`--port`, `--no-open`) |
| `dominion task <env> "<request>"` | Task mode (`--role`, `--auto-approve`, `--plan-only`, `--model`, `--verbose`) |
| `dominion crawl <env>` | Crawl mode (`--role`, `--max-pages`, `--flows`, `--auto-approve`, `--plan-only`, `--model`) |
| `dominion generate <spec.md>` | Generate tests from an existing plan (`--env`, `--role`, `--auto-approve`) |
| `dominion heal [file]` | Run tests and heal failures (`--env`, `--role`, `--max-attempts`, `--include-manual`) |
| `dominion run [args...]` | Run generated tests through your Playwright config; extra args go to `playwright test` |
| `dominion runs` | List past runs with status, test results and cost (`--json`, `--limit`, `--env`, `--status`) |
| `dominion prompts` | Show which agent prompts are overridden; `prompts eject [names...]` copies defaults to edit |

Every command exits non-zero on failure. Without `--auto-approve`, `task` and `crawl` stop after planning and wait for your approval. In CI (when `CI` is set) or without a terminal, they don't wait for input; instead they tell you to pass `--auto-approve`. Set `DOMINION_DEBUG=1` for stack traces.

## CI

Generated tests are plain Playwright tests, so running them needs no API key. Agents (`task`, `crawl`, `heal`) do.

`.github/workflows/e2e.yml` runs the generated tests on every pull request:

```yaml
name: e2e
on: [pull_request]

jobs:
  dominion-tests:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: npx playwright install --with-deps chromium
      - run: npx dominion run
        env:
          STAGING_CUSTOMER_USER: ${{ secrets.STAGING_CUSTOMER_USER }}
          STAGING_CUSTOMER_PASS: ${{ secrets.STAGING_CUSTOMER_PASS }}
      - uses: actions/upload-artifact@v4
        if: failure()
        with:
          name: playwright-report
          path: playwright-report/
```

`.github/workflows/dominion-discovery.yml` re-crawls staging every Monday and opens a pull request with new and updated plans for review. Nothing is generated until a person approves the plans: merge the PR, then run `npx dominion generate specs/<flow>.md` locally or in another job.

```yaml
name: dominion discovery
on:
  schedule:
    - cron: "0 6 * * 1"   # Mondays 06:00 UTC
  workflow_dispatch:

permissions:
  contents: write
  pull-requests: write

jobs:
  crawl:
    runs-on: ubuntu-latest
    timeout-minutes: 60
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: npx playwright install --with-deps chromium
      - run: npx dominion crawl staging --auto-approve --plan-only
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
          STAGING_CUSTOMER_USER: ${{ secrets.STAGING_CUSTOMER_USER }}
          STAGING_CUSTOMER_PASS: ${{ secrets.STAGING_CUSTOMER_PASS }}
      - run: npx dominion runs --limit 1
      - uses: peter-evans/create-pull-request@v7
        with:
          branch: dominion/discovery
          title: "DOMinion: test plans from the weekly crawl"
          body: "Plans for the critical flows found by `dominion crawl`. Review and edit them, then generate tests with `npx dominion generate specs/<flow>.md`."
          add-paths: specs/
```

Notes for CI:

- `budgets.maxUsdPerRun` caps what a scheduled job can spend. A run that hits the cap stops cleanly and keeps its artifacts.
- Use `form` or `api` roles in CI; `manual` roles need a person.
- Upload `specs/` and Playwright reports, but don't upload `.auth/` or the whole `.dominion/` folder. Run folders are redacted, but they are local state, not reports.

## Customizing agent prompts

The planner, generator, healer and discovery agents use prompts shipped in the package. Override any of them by committing `dominion/prompts/<name>.md`:

```sh
npx dominion prompts              # which prompts are overridden, and their placeholders
npx dominion prompts eject planner   # copy the default planner prompt to dominion/prompts/planner.md
```

| Prompt | Placeholders |
|---|---|
| `planner`, `generator`, `healer` | `{{testIdAttribute}}`, `{{rules}}` |
| `rules` (shared test generation rules, inserted at `{{rules}}`) | `{{testIdAttribute}}` |
| `discovery`, `analysis` | none |

`doctor` flags overrides with unknown placeholders or misspelled file names. Default prompts change between versions, and changes that alter generated output are listed in the [changelog](CHANGELOG.md). Re-check ejected copies after upgrading.

## Security model

- **Credentials** come only from environment variables. They never appear in config, prompts or UI storage. Every log line, event, report and file DOMinion writes is redacted. That covers the role env vars, `secretEnv`, `.env.local` entries with credential-like names (`*PASS*`, `*TOKEN*`, `*SECRET*`, `*KEY*` and so on) and session header tokens.
- **Agents** cannot read `.env*`, `.auth/`, `.dominion/` or `.git`. They cannot write outside the test and spec folders, run shell commands, or browse outside `allowedOrigins`. Generated code is linted for env access, Node built-ins, raw network calls and page scripts before it is saved.
- **Tests DOMinion runs** get an environment without credentials or API keys.
- **Page content is data, not instructions.** Prompts tell agents to ignore instructions found on web pages.
- **Irreversible actions** (pay, place order, delete, send) are off unless `allowDestructive: true` for that environment.
- **The local UI** binds to 127.0.0.1, needs the per-start token, and checks `Host` and `Origin` headers.
- **Budgets** (`maxTurnsPerAgent`, `maxUsdPerRun`) are always enforced.

## Troubleshooting

- Start with `npx dominion doctor`; every error comes with the fix.
- **Login fails:** run `npx dominion auth <env> --role <role> --headed --force` to watch it. A masked screenshot is saved under `.dominion/auth/`. `npx playwright codegen <baseURL>/login` helps you write selectors.
- **Session keeps "expiring":** `auth.validate.url` must be a page only logged-in users can open, and `loggedOutPattern` must match where logged-out users end up.
- **CAPTCHA or bot challenge:** turn bot protection off for the test environment or allowlist the machine. DOMinion stops instead of solving it.
- **`playwright.config.ts` could not be patched:** DOMinion prints the project block to add by hand. This happens when `projects` is built dynamically or the config is CommonJS.

## Development

```sh
npm install
npm run build       # tsup (CLI and library) + vite (UI)
npm run typecheck
npm test            # unit + e2e; e2e uses a local fixture app and real Chromium
```

Tests never call the Claude API: agents are replaced by scripted runners that go through the same tool guard. `test/fixture-app/` is the shop the e2e tests run against. Releases are described in [RELEASING.md](RELEASING.md).

## License

DOMinion is proprietary software; see [LICENSE](LICENSE). You may install the `dominion-playwright` package from npm and run it unmodified to test applications you own or are authorized to test.

You may not copy, modify, reuse or redistribute its source code, prompts or templates, even though the code is visible here and in the package. The tests, plans and other files DOMinion generates in your project are yours.
