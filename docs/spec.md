# DOMinion: build spec

Nov 11, 2026 · @Jano

> Transcribed from "DOMinion build spec.pdf". This file is the source of truth for the build; section names are referenced from code comments and tests.

## Overview

Build **DOMinion**, an npm package that adds AI-driven test authoring to any Playwright project. A team installs it into their own repo, points it at an environment of their app, and gets reviewed, runnable Playwright tests committed to that repo. DOMinion is the display name; because npm package names must be lowercase, the package, CLI command, config file and folders all use `dominion`.

It has two features that share one pipeline:

1. **Crawl mode:** explore a whole site, discover its critical user flows (login, search, add to cart, checkout), and generate tests for each flow.
2. **Task mode:** take a natural-language request such as "write tests for the add to cart workflow" and generate tests for just that flow.

### Goals

- Locators are verified against the live app before they are written, never guessed.
- Every test asserts on meaningful outcomes (URL, cart count, confirmation text), not just that clicks succeeded.
- Works on apps behind a login, including multiple user roles and MFA via TOTP.
- Runs locally through a browser UI and a CLI, and in CI through the CLI alone.
- The consuming repo owns every app-specific file; the package owns only reusable machinery.

### Non-goals for v1

- A hosted SaaS version.
- Visual regression, performance or load testing.
- Bypassing CAPTCHAs or bot detection. If one is detected, the run pauses and tells the user.
- Native mobile apps.

### Terms used in this spec

- **Framework repo:** this repository, published as `@yourorg/dominion` (swap yourorg for your npm scope).
- **Consumer repo:** any codebase that installs the package.
- **Environment:** a deployed instance of the consumer's app, such as staging or QA, with a base URL.
- **Role:** a type of logged-in user in an environment, such as customer or admin.
- **Flow:** one user journey to test, such as guest checkout.
- **Plan:** a Markdown description of a flow's scenarios, steps and expected outcomes, written before any code.
- **Run:** one execution of the pipeline, with its own ID, logs and artifacts.

## How a consuming team uses it

A team goes from install to first generated test in five commands, and every UI action maps to a CLI command so the same work runs in CI.

```sh
npm install -D @yourorg/dominion
npx dominion init                            # scaffold config, folders, .gitignore entries, .env.local template
# fill in .env.local with test-account credentials and ANTHROPIC_API_KEY
npx dominion auth staging --role customer    # log in once, save the session
npx dominion ui                              # open the local UI
```

In the UI, the user:

1. Picks an environment and a role. A status badge shows whether credentials are present and the saved session is valid.
2. Chooses **Crawl** or **Task**. Task mode shows a text box for the natural-language request.
3. Starts the run and watches agent progress stream in live.
4. In crawl mode, reviews the list of discovered flows and selects which to pursue.
5. Reviews each Markdown plan, edits it if needed, then approves or rejects it. Nothing is generated before approval.
6. Watches generation and the first test run, including any healing.
7. Sees the new and changed files as a diff, plus pass, fail and fixme results, then commits through their normal git workflow.

After `init`, the consumer repo contains:

```
their-app/
├── dominion.config.ts     # committed: environments, roles, env var names, options
├── dominion/
│   ├── auth/login.ts      # committed: their login steps
│   └── prompts/           # committed, optional: overrides for the default agent prompts
├── specs/                 # committed: approved Markdown plans
├── tests/agent/           # committed: generated Playwright tests and page objects
├── .env.local             # gitignored: credentials, ANTHROPIC_API_KEY
├── .auth/                 # gitignored: saved session files
└── .dominion/             # gitignored: run logs, crawl output, traces
```

## Architecture and package layout

The package is a single TypeScript project with four layers: a CLI, a local web server with a React UI, a core library that does the real work, and default prompts. The CLI and the server are thin; both call the same core functions, so behaviour is identical whether a run starts from the terminal or the UI.

- **CLI** (`src/cli`): parses commands with `commander`, loads config, calls core.
- **Server** (`src/server`): Fastify on `127.0.0.1`, REST endpoints plus a WebSocket that streams run events. Serves the prebuilt UI as static files.
- **UI** (`src/ui`): React + Vite, built to `dist/ui` at publish time so consumers never build it.
- **Core** (`src/core`): config loading and validation, auth, crawler, run orchestrator, agent wrappers, Playwright config patching, event bus.
- **Agents:** run through the Claude Agent SDK (`query()`), each with the Playwright MCP server attached so the model drives a real browser through the accessibility tree. The planner, generator and healer prompts are adapted from what `npx playwright init-agents` produces, which is a good reference to read before writing them.

```
dominion/                     # framework repo
├── package.json              # bin: { "dominion": "dist/cli/index.js" }
├── src/
│   ├── cli/
│   │   ├── index.ts
│   │   └── commands/         # init, ui, auth, crawl, task, generate, heal, run, doctor
│   ├── server/
│   │   ├── index.ts          # Fastify app, static UI, auth token check
│   │   ├── routes/           # REST: envs, runs, plans, flows, files
│   │   └── ws.ts             # run event stream
│   ├── ui/                   # React + Vite source
│   ├── core/
│   │   ├── config/           # defineConfig, zod schema, loader (jiti for .ts config)
│   │   ├── auth/             # strategies: form, manual, api, none; session validation
│   │   ├── crawler/          # deterministic BFS crawler, URL normalizer, sitemap writer
│   │   ├── agents/           # planner.ts, generator.ts, healer.ts, flowDiscovery.ts
│   │   ├── orchestrator/     # Run state machine, budgets, approvals
│   │   ├── playwright/       # patch consumer playwright.config, run tests, parse JSON report
│   │   ├── mcp/              # build Playwright MCP args and config per run
│   │   ├── events.ts         # typed event bus shared by CLI and server
│   │   └── redact.ts         # strips secret values from logs and events
│   ├── prompts/              # default planner.md, generator.md, healer.md, discovery.md
│   └── index.ts              # public API: defineConfig and types
├── templates/                # files written by `init`
├── test/                     # vitest unit tests + an e2e fixture app
└── tsup.config.ts
```

Run state lives on disk in the consumer repo under `.dominion/runs/<runId>/` (`run.json`, `events.jsonl`, `sitemap.json`, traces), so the UI can reload a run after a restart and the CLI can resume one.

## Configuration and init

All app-specific settings live in `dominion.config.ts` in the consumer repo, validated with a zod schema at load time. The config names environment variables; it never holds secret values.

```ts
import { defineConfig } from "@yourorg/dominion";

export default defineConfig({
  model: "claude-sonnet-5-5",          // overridable per command with --model
  testDir: "tests/agent",
  specsDir: "specs",
  pageObjects: true,                   // generate page objects for pages used by 2+ flows
  testIdAttribute: "data-testid",

  environments: {
    staging: {
      baseURL: "https://staging.myapp.com",
      allowedOrigins: ["https://staging.myapp.com", "https://auth.staging.myapp.com"],
      allowDestructive: false,         // if false, agents stop before final submit/pay/delete actions
      auth: {
        loginUrl: "/login",
        loginScript: "./dominion/auth/login.ts",
        validate: { url: "/account", loggedOutPattern: "/login" },
      },
      roles: {
        guest:    { strategy: "none" },
        customer: { strategy: "form", userEnv: "STAGING_CUSTOMER_USER", passEnv: "STAGING_CUSTOMER_PASS" },
        admin:    { strategy: "form", userEnv: "STAGING_ADMIN_USER", passEnv: "STAGING_ADMIN_PASS",
                    totpEnv: "STAGING_ADMIN_TOTP" },
      },
    },
    qa: {
      baseURL: "https://qa.myapp.com",
      roles: { sso_user: { strategy: "manual" } },
    },
  },

  crawl: {
    maxPages: 200,
    maxDepth: 4,
    exclude: ["/logout", "/signout", "/account/delete", "**/admin/users/*/delete"],
    keepQueryParams: ["category", "q"],
  },

  budgets: { maxTurnsPerAgent: 80, maxUsdPerRun: 10, maxHealAttempts: 3 },
});
```

### What `init` does

1. Detects the package manager and an existing `playwright.config.ts`. If none exists, it offers to run `npm init playwright@latest` first.
2. Writes `dominion.config.ts` with one example environment, asking for the base URL interactively (or `--base-url`).
3. Creates `dominion/auth/login.ts` from a template with clearly marked selectors to adjust.
4. Creates `.env.local` from a template listing every env var the config references, with empty values.
5. Appends `.env.local`, `.auth/` and `.dominion/` to `.gitignore` if they are missing.
6. Creates `specs/` and `tests/agent/`.
7. Never overwrites an existing file. It prints what it skipped.

The loader reads `.env.local` with `dotenv`, then process environment variables, which take precedence so CI secrets win.

## Existing projects

DOMinion adopts an existing Playwright suite's conventions instead of imposing its own. The folder layout in this spec is only the default for projects with no Playwright setup; when one exists, generated tests must look like a teammate wrote them.

### Detection during `init`

`init` scans the repo deterministically before writing anything:

1. Finds every `playwright.config.*`. If there are several (monorepos), it asks which one to use, or accepts `--playwright-config`.
2. Loads the chosen config with Playwright's own loader and records `testDir`, projects, `baseURL`, `testIdAttribute`, `globalSetup`, setup projects and `storageState` paths.
3. Runs `npx playwright test --list --reporter=json` to inventory every existing test: file, title, tags and project.
4. Detects file naming (`.spec.ts` or `.test.ts`), TypeScript or JavaScript, and ESM or CommonJS.
5. Uses `ts-morph` to find custom fixtures (files calling `test.extend`), page objects (classes whose constructor takes a `Page`), and helper modules, and to extract their exported names, methods and locators.
6. Picks two or three representative tests as style exemplars (recently modified, typical length, using the detected fixtures).

A short analysis agent then reads the exemplars and fixture files and summarises conventions the scan cannot infer: page object style, tagging style, use of `test.step`, assertion habits.

### Project profile

The results become a `project` section in `dominion.config.ts`. `init` shows it to the user to confirm or edit before anything is generated. When a value cannot be detected, `init` uses the default and asks rather than guessing.

```ts
project: {
  playwrightConfig: "apps/web/playwright.config.ts",
  testDir: "apps/web/e2e",
  outputDir: "apps/web/e2e/generated",          // where DOMinion writes new specs
  fileNaming: "{flow}.test.ts",
  language: "ts",
  testImport: 'import { test, expect } from "../fixtures"',
  pageObjects: { dir: "apps/web/e2e/pages", style: "class", reuse: true },
  exemplars: ["apps/web/e2e/checkout.test.ts", "apps/web/e2e/login.test.ts"],
  auth: { strategy: "existing", setupProject: "setup", storageState: "playwright/.auth/user.json" },
  modifyExisting: false,
}
```

`dominion doctor` re-runs detection and warns when the profile has drifted from the repo, for example a moved `testDir` or a renamed fixture file.

### How generation adapts

- The generator prompt includes the exemplar files as the style reference and the `testImport` line as the required import.
- A page object index (class, file, methods, locators) is built from the scan and given to the generator. It must call an existing method when one covers a step, such as `CheckoutPage.fillShipping()`, instead of writing a duplicate.
- Output uses the detected naming, language and module format, and goes to `outputDir`.

### Auth reuse

A new `existing` auth strategy points DOMinion at the project's current setup project or `globalSetup` and its storage state file. DOMinion runs that setup when a session is missing or expired and never creates a second login mechanism. The `form` and `manual` strategies remain for projects with nothing in place.

### Playwright config

For existing projects, DOMinion does not patch the user's config. It writes `playwright.dominion.config.ts`, which imports their config and extends it with anything DOMinion needs. Generated tests live inside their `testDir` and carry the `@dominion` tag, so existing CI runs them automatically and anyone can include or exclude them with `--grep`. The managed-block patching described in the Authentication section applies only to new projects.

### Ownership

- Generated files carry the DOMinion header comment; the framework treats only those files as its own.
- The healer modifies only DOMinion-generated files unless the user runs `dominion heal --include-manual`.
- With `modifyExisting: false` (the default), any change the generator wants to make to an existing page object, fixture or helper is produced as a separate proposed diff for approval in the UI or CLI, never written directly.

### Coverage awareness

The test inventory is matched to flows by title, `test.step` names and URLs visited. The planner is told which flows already have tests so it does not duplicate them, and crawl mode shows a coverage gap view in the Flows screen: each discovered flow is marked covered, partly covered or not covered, with links to the existing tests.

### Testing this feature

Add a second fixture under `test/fixture-existing-suite/`: the fixture app plus a hand-written Playwright suite with a non-default `testDir`, custom fixtures, class-based page objects, a setup project for auth and `.test.ts` naming. It is the reference for detection, style matching and the ownership rules.

## Authentication

The agent never logs in and never sees a password. Deterministic Playwright code logs in first and saves a `storageState` file; agents and generated tests both start from that saved session.

### Strategies

| Strategy | When to use | How it works |
|---|---|---|
| `form` | Standard username and password login, optionally with TOTP MFA | Runs the consumer's `loginScript` with credentials read from the env vars named in config. TOTP codes come from `otplib` using `totpEnv`. |
| `manual` | SSO, hardware keys, push MFA, anything hard to automate | Opens a headed browser at `loginUrl`. The user logs in by hand, then clicks Done in the UI or presses Enter in the CLI. The session is saved. |
| `api` | Apps with a login endpoint or token flow (v1.1) | Calls a consumer-provided function that returns cookies or headers, which are written into the storage state. |
| `none` | Guest flows | No session file. Agents start in a fresh context. |

The login script contract:

```ts
// dominion/auth/login.ts
import type { LoginContext } from "@yourorg/dominion";

export default async function login({ page, env, credentials }: LoginContext) {
  await page.goto(env.baseURL + env.auth.loginUrl);
  await page.getByLabel("Email").fill(credentials.username);
  await page.getByLabel("Password").fill(credentials.password);
  if (credentials.totp) {
    await page.getByLabel("Authentication code").fill(credentials.totp());
  }
  await page.getByRole("button", { name: /sign in/i }).click();
  // the framework waits until the URL no longer matches loggedOutPattern, then saves storageState
}
```

### Session lifecycle

1. Sessions are saved to `.auth/<env>-<role>.json`.
2. Before any run, the framework validates the session: it opens `validate.url` with the saved state and fails validation if the browser lands on a URL matching `loggedOutPattern`.
3. If the session is missing or invalid, `form` and `api` re-authenticate automatically. `manual` prompts the user and pauses the run.
4. The UI shows one badge per role: credentials missing, session valid, session expired, or never logged in. It never displays credential values.

### Writing the login script for a new app

`init` writes a template. The UI also offers two helpers. **Record login** opens `npx playwright codegen` at the login URL so the user can click through once and paste the result. **Generate login** lets an agent write the script: the framework launches Playwright MCP with a temporary dotenv file passed through `--secrets`, which keeps those values out of the tool responses the model sees, and instructs the agent to write code that reads `credentials.*` only.

### How agents get the session

For each run the framework builds the Playwright MCP launch arguments:

```ts
args: [
  "@playwright/mcp@<pinned version>",
  "--isolated",
  `--storage-state=.auth/${env}-${role}.json`,
  "--config=.dominion/runs/<runId>/mcp.json",   // network.allowedOrigins from env config, testIdAttribute
]
```

### How generated tests get the session

The framework adds or updates a clearly delimited block in the consumer's `playwright.config.ts`: one setup project per env and role that calls the same login logic, and one test project that depends on it.

```ts
// --- dominion:start (managed, do not edit by hand) ---
{ name: "dominion-setup-staging-customer", testMatch: /dominion\.setup\.ts/,
  metadata: { env: "staging", role: "customer" } },
{ name: "dominion-staging-customer", testDir: "tests/agent",
  use: { baseURL: "https://staging.myapp.com", storageState: ".auth/staging-customer.json" },
  dependencies: ["dominion-setup-staging-customer"], grep: /@role:customer/ },
// --- dominion:end ---
```

If the config file is too unusual to patch safely (for example, projects built dynamically), the framework prints the snippet and asks the user to add it rather than editing the file.

### Secrets rules

- Credential values come only from environment variables. Never from config, UI storage or prompts.
- `src/core/redact.ts` replaces any configured secret value with `[REDACTED]` in every log line, event and file the framework writes.
- `.auth/` files are live sessions and are treated as secrets: gitignored, never uploaded, never included in prompts.

## CLI

Every capability is a CLI command; the UI calls the same core functions. Commands exit non-zero on failure so they work in CI.

| Command | Purpose | Key flags |
|---|---|---|
| `dominion init` | Scaffold config, folders, templates, gitignore entries | `--base-url`, `--yes` |
| `dominion doctor` | Check Node and Playwright versions, config validity, env vars present, session validity, API key | `--env` |
| `dominion auth <env>` | Log in and save a session | `--role`, `--headed`, `--force` |
| `dominion ui` | Start the local server and open the browser | `--port` (default 4555), `--no-open` |
| `dominion task <env> "<request>"` | Task mode: plan, then generate, then run and heal | `--role`, `--auto-approve`, `--plan-only`, `--model` |
| `dominion crawl <env>` | Crawl mode: crawl, discover flows, then plan each selected flow | `--role`, `--max-pages`, `--flows <ids>`, `--auto-approve`, `--plan-only` |
| `dominion generate <spec.md>` | Generate tests from an existing approved plan | `--env`, `--role` |
| `dominion heal [file]` | Run tests and heal failures | `--env`, `--role`, `--max-attempts` |
| `dominion run` | Run generated tests through the consumer's Playwright config | passes extra args to `playwright test` |
| `dominion runs` | List past runs with status and cost | `--json` |

Without `--auto-approve`, the CLI stops after planning, prints the plan paths, and waits for the user to approve in the terminal (y/n/edit). In CI, `--auto-approve` is required and `--plan-only` is the recommended default for scheduled discovery jobs.

## Local UI

The UI is a single-page React app served by the local Fastify server. It has five screens and no state of its own beyond what the server returns, so a page reload never loses a run.

### Screens

1. **Start:** environment dropdown, role dropdown with an auth status badge and a Log in button, mode toggle (Crawl or Task), a multi-line text box for the task request, and a Start button. Shows the estimated budget cap from config.
2. **Run:** a live, stage-by-stage timeline (crawl, discover, plan, generate, run, heal), a streaming log of agent actions ("navigated to /cart", "verified locator getByRole('button', { name: 'Checkout' })"), the latest browser screenshot when available, running cost, and a Stop button.
3. **Flows** (crawl mode only): the discovered flows as a checklist with name, priority, start URL and description. The user selects flows and clicks Plan selected.
4. **Plan review:** a Markdown editor showing each plan, with Approve, Reject and Regenerate with feedback. Generation for a flow starts only after its plan is approved.
5. **Results:** generated and changed files as a diff, test results (passed, failed, fixme with the healer's reason), links to Playwright traces, and a copy-ready commit message.

A read-only **Settings** panel shows the loaded config and which env vars are set or missing, never their values.

### Server API

- `GET /api/config`: parsed config with secret values omitted.
- `GET /api/envs/:env/roles/:role/status`: credentials present, session state.
- `POST /api/envs/:env/roles/:role/login`: trigger auth; for `manual`, opens a headed browser and waits for `POST .../login/done`.
- `POST /api/runs`: start a run `{ mode, env, role, request? }`; returns `runId`.
- `GET /api/runs`, `GET /api/runs/:id`: run list and detail.
- `POST /api/runs/:id/stop`.
- `POST /api/runs/:id/flows/select { flowIds }`.
- `GET /api/runs/:id/plans/:planId`, `PUT` to save edits, `POST .../approve`, `POST .../reject { feedback }`.
- `GET /api/runs/:id/diff`: changed files with unified diffs.
- `WS /api/runs/:id/events`: streams typed events from `events.ts`, replaying past events from `events.jsonl` on connect.

### Server security

The server binds to `127.0.0.1` only. On start it generates a random token, opens the browser at `http://127.0.0.1:4555/?token=...`, and rejects any request without that token (header or cookie). It never serves files outside the consumer repo.

## Agent pipeline

A run is a state machine: `created → (crawling → discovering → awaiting_flow_selection) → planning → awaiting_approval → generating → running → healing → done | failed | stopped`. Crawl-mode stages are skipped in task mode; after flow selection, each selected flow follows the task-mode path independently, with up to two flows in parallel.

### Planner

- **Input:** environment, role, base URL, the task request (task mode) or a discovered flow (crawl mode), plus a seed test that opens the app logged in.
- **Tools:** Playwright MCP browser tools only. No file writes except the plan file.
- **Behaviour:** explores only as much of the app as the flow needs, recording real page names, field labels, button text and observed outcomes.
- **Output:** `specs/<flow-slug>.md` with YAML frontmatter (`env`, `role`, `flow`, `runId`, `createdAt`, `status: draft`) and numbered scenarios. Each scenario has a precondition, steps, and expected outcomes stated as observable facts. The happy path comes first, then key negative and edge cases (empty cart, invalid coupon, required field missing).
- When `allowDestructive` is false, the plan must end any scenario before the irreversible action and state that it does.

### Generator

- **Input:** an approved plan file, the rules in the Test generation rules section, and any existing page objects in `testDir`.
- **Tools:** Playwright MCP browser tools plus file Read, Write and Edit restricted to `testDir`.
- **Behaviour:** replays each scenario in the browser step by step. Before writing a locator it confirms the locator resolves to exactly one visible element. Before writing an assertion it confirms the assertion holds at that point.
- **Output:** `tests/agent/<area>/<flow-slug>.spec.ts`, plus page objects under `tests/agent/pages/` when enabled. Each file starts with a header comment linking its plan file.

### Runner and healer

- The framework, not an agent, runs the new tests with `npx playwright test <files> --project=dominion-<env>-<role> --reporter=json`, and parses the report.
- Each failing test goes to the healer with the error, the trace path and the current page snapshot.
- The healer may change locators, waits and assertions, but must not change what a test checks. If the app's behaviour itself looks broken, it marks the test `test.fixme()` with a comment explaining why.
- Up to `maxHealAttempts` per test. After that the test is marked fixme and reported.

### Flow discovery (crawl mode)

A separate agent call with no browser tools: it reads `sitemap.json` and returns JSON matching a zod schema: `{ flows: [{ id, name, priority: "critical" | "high" | "medium", startUrl, pagesInvolved, description, destructive: boolean }] }`. Validate the response and retry once on schema failure.

### Agent SDK usage

Each agent is one `query()` call from `@anthropic-ai/claude-agent-sdk` with a system prompt from `src/prompts/` (or the consumer's override in `dominion/prompts/<name>.md`), the MCP server config from the Authentication section, an `allowedTools` list scoped as above, `maxTurns` from budgets, and a working directory of the consumer repo root. The orchestrator converts SDK messages into framework events, tracks cost from result messages, and stops the run when `maxUsdPerRun` is reached.

### Events

Define a typed union in `src/core/events.ts`, for example `run.stage_changed`, `agent.tool_call`, `agent.message`, `browser.screenshot`, `plan.ready`, `test.result`, `heal.attempt`, `cost.updated`, `run.error`. Every event is redacted, appended to `events.jsonl`, and broadcast over WebSocket.

## Crawl mode

The crawl is deterministic Playwright code, not an agent: it is faster, cheaper and reproducible. The LLM only sees its compact output.

### Phase 1: crawl

1. Start at `baseURL` with the role's storage state.
2. Breadth-first over same-origin links (`a[href]` plus elements with `role=link`), up to `maxPages` and `maxDepth`.
3. Only follow GET navigations. Never submit forms or click buttons during the crawl.
4. Skip any URL matching `crawl.exclude`, and any link whose text matches a built-in deny list (log out, sign out, delete, remove account, unsubscribe).
5. Normalize URLs into patterns before deduplicating: drop the hash, drop query params not in `keepQueryParams`, and replace numeric IDs, UUIDs and long slugs in path segments with `:id`. Visit at most 2 concrete URLs per pattern.
6. For each visited page, capture: URL, pattern, title, HTTP status, `page.locator("body").ariaSnapshot()` truncated to a size limit, counts of forms, inputs and buttons, the names of visible buttons and headings, and a small screenshot thumbnail.
7. Stop and report if the session is lost (redirect to `loggedOutPattern`) or a CAPTCHA or bot challenge is detected.

Output: `.dominion/runs/<runId>/sitemap.json`, an array of page-pattern records with the links between them.

### Phase 2: discover and plan

1. The flow discovery agent classifies page types (listing, product detail, cart, checkout, login, account, search, admin) and proposes flows as JSON.
2. The UI shows the flows for selection, or the CLI uses `--flows` or selects all `critical` flows when `--auto-approve` is set.
3. Each selected flow enters the planner exactly as a task-mode request would, with its description and start URL as the request.

This is why both features share everything downstream of discovery: crawl mode is task mode with machine-written requests.

## Test generation rules

These rules go into the generator and healer prompts, and the cheap-to-check ones are also enforced in code by a lint step that runs on every generated file before it is saved.

### Locators

1. Priority order: `getByRole` with an accessible name, `getByLabel`, `getByPlaceholder`, `getByText` (exact where possible), `getByTestId` using `testIdAttribute`, then CSS as a last resort.
2. Never XPath. Never auto-generated class names or DOM-position selectors.
3. Every locator is verified live to match exactly one element before it is written.
4. Use `.nth()` or `.first()` only when the plan intends position (for example, "the first product in the list") and say so in a comment.
5. Scope locators inside a container when names repeat: `page.getByRole("listitem").filter({ hasText: "Backpack" }).getByRole("button", { name: "Add to cart" })`.

### Assertions

1. Use web-first assertions only: `toBeVisible`, `toHaveText`, `toContainText`, `toHaveURL`, `toHaveCount`, `toHaveValue`, `toBeEnabled`.
2. Every meaningful action is followed by at least one assertion on its outcome: URL change, count change, new text, a confirmation message, or a changed value.
3. Prefer assertions about relationships over hardcoded volatile values. Assert the cart badge increased by one and the cart total equals the sum of line items, not a specific price.
4. No `waitForTimeout`. No manual sleeps. Wait on locators or URLs.

### Structure

- One `test.describe` per flow, one `test` per plan scenario, `test.step` per plan step using the plan's step wording.
- Tags in the title: `@dominion`, `@flow:<slug>`, `@role:<role>`, plus `@destructive` if the test performs irreversible actions.
- Tests are independent: each sets up its own state and does not rely on another test's leftovers.
- Page objects (when enabled) for any page used by two or more flows: one class per page under `tests/agent/pages/`, locators as readonly properties, actions as methods, no assertions inside page objects.
- Each spec file starts with a header comment: generated by DOMinion, source plan path, run ID, date.

### Example of the expected output

```ts
// Generated by DOMinion from specs/add-to-cart.md (run 2026-11-11-a1b2)
import { test, expect } from "@playwright/test";

test.describe("Add to cart @dominion @flow:add-to-cart @role:customer", () => {
  test("adds a product from the listing page", async ({ page }) => {
    await test.step("Open the products page", async () => {
      await page.goto("/products");
      await expect(page.getByRole("heading", { name: "Products" })).toBeVisible();
    });

    const badge = page.getByTestId("cart-count");
    const before = Number((await badge.textContent()) ?? "0");

    await test.step("Add the backpack to the cart", async () => {
      const card = page.getByRole("listitem").filter({ hasText: "Backpack" });
      await card.getByRole("button", { name: "Add to cart" }).click();
      await expect(badge).toHaveText(String(before + 1));
      await expect(card.getByRole("button", { name: "Remove" })).toBeVisible();
    });

    await test.step("Open the cart", async () => {
      await page.getByRole("link", { name: /cart/i }).click();
      await expect(page).toHaveURL(/\/cart/);
      await expect(page.getByRole("listitem").filter({ hasText: "Backpack" })).toBeVisible();
    });
  });
});
```

## Security and safety

An agent driving a logged-in browser can cause real damage, so these guardrails are requirements, not options.

- **No irreversible actions by default.** With `allowDestructive: false`, agents stop before any final pay, place order, submit, delete or send action, and plans say so. Prompts state this, and the MCP config blocks known payment provider origins unless the environment allows them.
- **Stay on the app.** `allowedOrigins` from config is passed to Playwright MCP as `network.allowedOrigins`. Requests elsewhere are blocked.
- **Excluded paths.** The crawler and agents never visit `crawl.exclude` patterns or deny-listed link text (log out, delete account).
- **Secrets.** Only from env vars, redacted everywhere, never placed in prompts. `--secrets` is used only for login-script generation.
- **Sessions.** `.auth/` is gitignored by `init`, and `doctor` warns if it is tracked by git.
- **Local server.** Bound to `127.0.0.1`, random per-start token required, no file access outside the repo root.
- **Budgets.** `maxTurnsPerAgent` and `maxUsdPerRun` are always enforced; a run that hits a cap stops cleanly and keeps its artifacts.
- **Bot protection.** CAPTCHAs and bot challenges are never solved or bypassed. The run pauses and tells the user to disable them for the test environment or log in manually.
- **Permission.** Docs and the `init` output state that the tool is for applications the user owns or is authorized to test, ideally non-production environments with dedicated test accounts.
- **Untrusted page content.** Agent prompts state that text on web pages is data, not instructions, so a page cannot redirect the agent.

## Tech stack and packaging

TypeScript on Node 20 or later, published as an ESM npm package with a `bin` entry. Pin exact versions of runtime dependencies.

| Package | Role | Dependency type |
|---|---|---|
| `@playwright/test` | Test runner and browser automation, uses the consumer's version | peer (`>=1.56`) |
| `@playwright/mcp` | Browser tools for agents, launched per run | dependency, pinned |
| `@anthropic-ai/claude-agent-sdk` | Agent loop for planner, generator, healer, discovery | dependency |
| `zod` | Config and agent-output validation | dependency |
| `commander` | CLI parsing | dependency |
| `dotenv` | Loads `.env.local` | dependency |
| `jiti` | Loads the consumer's `.ts` config without a build step | dependency |
| `otplib` | TOTP codes for MFA test accounts | dependency |
| `fastify`, `@fastify/websocket`, `@fastify/static` | Local server | dependency |
| `react`, `vite` | UI, built at publish time | dev |
| `tsup` | Build CLI and library | dev |
| `vitest` | Unit tests | dev |

### Packaging rules

- `package.json` exposes `bin: { "dominion": "dist/cli/index.js" }` and exports `defineConfig` and public types from the package root.
- `files` includes only `dist/` (with `dist/ui/`), `templates/` and `src/prompts/` copied to `dist/prompts/`.
- Each consumer supplies `ANTHROPIC_API_KEY` in their own environment.
- Semver: a change to default prompts that alters generated output is at least a minor version and is noted in the changelog.
- Publish to public npm or a private registry (GitHub Packages, Artifactory, Nexus); keep the package name configurable until decided.

## Milestones

Build in this order; each milestone ends with something runnable and tested. Do not start the UI until task mode works end to end from the CLI.

1. **M0 Scaffold.** Repo setup, tsup build, vitest, `bin` entry, `dominion --version`, `init` with templates and gitignore handling. *Done when* `init` in an empty Playwright project produces the expected files and running it twice changes nothing.
2. **M1 Config and auth.** zod schema, `defineConfig`, loader with dotenv and jiti, `form` and `manual` strategies, TOTP, session validation, `auth` and `doctor` commands, redaction utility. *Done when* `auth` logs into the fixture app and a test practice site, writes `.auth/<env>-<role>.json`, and `doctor` reports valid.
3. **M2 Task mode from the CLI.** Event bus, run state on disk, Playwright MCP launcher, planner and generator agents with default prompts, plan approval in the terminal, Playwright config patching. *Done when* `dominion task staging "add a product to the cart"` on the practice site produces a plan and a passing spec that follows the Test generation rules.
4. **M3 Run and heal.** JSON report parsing, healer agent, attempt limits, fixme marking, budgets and stop. *Done when* a deliberately broken locator is healed and a deliberately broken app behaviour is marked fixme with a reason.
5. **M4 Existing projects.** Detection scan in `init`, `--playwright-config` flag, project profile with confirmation, exemplar selection, page object index, `existing` auth strategy, `playwright.dominion.config.ts`, ownership rules, proposed diffs for existing files, coverage matching, profile drift check in `doctor`. *Done when* running `init` and `task` against `test/fixture-existing-suite/` produces tests that use its fixtures, page objects, naming and auth setup, leaves its `playwright.config.ts` and hand-written tests unchanged, and the planner skips a flow that is already covered.
6. **M5 Local UI.** Fastify server with token auth, REST and WebSocket API, the Start, Run, Plan review and Results screens, Settings panel. *Done when* the M2 and M3 scenarios can be done entirely from the UI, and reloading the page mid-run resumes the live view.
7. **M6 Crawl mode.** Crawler, URL normalizer, sitemap output, flow discovery agent, Flows screen, parallel flow planning. *Done when* crawling the practice site discovers at least login, add to cart and checkout flows and generates passing tests for selected flows.
8. **M7 Polish.** Prompt overrides from the consumer repo, `api` auth strategy, `runs` command, README with a CI example (GitHub Actions running `dominion run` and a weekly `crawl --plan-only`), publish pipeline.

## Instructions for Claude Code

Work one milestone at a time. At the start of each milestone, restate the plan for it in a few lines, then build it, write its tests, run them, and summarize what changed before moving on.

### Working rules

- Read the Playwright docs on test agents and authentication, and run `npx playwright init-agents --loop=claude` in a scratch folder to study the generated planner, generator and healer definitions before writing `src/prompts/`.
- Keep the CLI and server thin. All logic lives in `src/core` with unit tests.
- Add an e2e fixture app under `test/fixture-app/`: a tiny Express or Vite app with a login form (one plain user, one TOTP user), a product list, a cart and a checkout that stops at a fake "Place order". Use it for auth and pipeline tests so the suite does not depend on external sites.
- For manual end-to-end checks, a public practice site such as saucedemo.com is fine.
- Ask before adding a dependency not listed in the Tech stack section.
- Never write real credentials into code, tests, fixtures or logs; the fixture app uses obviously fake ones.
- Prefer clear errors over silent fallbacks: missing env vars, an invalid config, or an expired manual session should each produce a message telling the user exactly what to do.

## Acceptance criteria for v1

- [ ] `npm install -D` plus `npx dominion init` works in a fresh Playwright project and in one with an existing config.
- [ ] In a repo with an existing Playwright suite, generated tests match its fixtures, page objects, naming and auth setup, and its config and hand-written tests are left unchanged.
- [ ] Form, manual and TOTP logins produce valid sessions; expired sessions are detected and refreshed or prompted.
- [ ] Task mode produces an approved plan and passing tests that follow every locator and assertion rule.
- [ ] Crawl mode discovers flows on the fixture app and the practice site and generates tests for selected flows.
- [ ] The healer fixes a broken locator and marks broken behaviour as fixme with a reason.
- [ ] Every UI action has an equivalent CLI command; CI can run task, crawl and run non-interactively.
- [ ] No secret value appears in any log, event, prompt, plan or generated file (covered by a test that greps run output for the fixture credentials).
- [ ] Budget caps stop a run cleanly.
- [ ] The UI server is reachable only on 127.0.0.1 and rejects requests without its token.

## Open decisions

- Final package name and registry (public npm or private).
- Default model; the spec assumes a current Claude Sonnet model, overridable in config.
- License, if the package will be public.
