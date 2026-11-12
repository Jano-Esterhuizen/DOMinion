import { existsSync, readFileSync } from "node:fs";
import { DominionError } from "../errors";
import { writeFileAtomic } from "../fs";
import { explainLaunchError, type PlaywrightTestModule } from "../playwright/resolve";
import { renderTemplate } from "../templates";

/** How the login script finds a field: by its label, its placeholder, or a test id attribute. */
export interface FieldLocator {
  by: "label" | "placeholder" | "testId";
  value: string;
  /** For testId: the attribute (data-testid, data-test, ...). */
  attribute?: string;
}

/** How the login script finds a button: by its accessible name, or a test id attribute. */
export interface ButtonLocator {
  by: "role" | "testId";
  value: string;
  attribute?: string;
}

/** What the login builder needs to write dominion/auth/login.ts for a username/password page. */
export interface LoginFormSpec {
  username: FieldLocator;
  password: FieldLocator;
  submit: ButtonLocator;
  /** Accounts with a one-time code (roles with totpEnv). */
  totp?: {
    field: FieldLocator;
    /** Set when the code is asked on a second screen: the button that submits it. */
    submit?: ButtonLocator;
  };
}

export const BUILDER_MARKER = "// dominion-login-builder: ";

export type LoginScriptKind = "missing" | "template" | "builder" | "custom";

export interface LoginScriptState {
  kind: LoginScriptKind;
  /** The builder's settings, when the script was written by the builder and not edited since. */
  spec?: LoginFormSpec;
}

const q = (value: string) => JSON.stringify(value);

function fieldCode(field: FieldLocator): string {
  if (field.by === "label") return `page.getByLabel(${q(field.value)}, { exact: true })`;
  if (field.by === "placeholder") return `page.getByPlaceholder(${q(field.value)}, { exact: true })`;
  return `page.locator(${q(`[${field.attribute ?? "data-testid"}=${JSON.stringify(field.value)}]`)})`;
}

function buttonCode(button: ButtonLocator): string {
  if (button.by === "role") return `page.getByRole("button", { name: ${q(button.value)}, exact: true })`;
  return `page.locator(${q(`[${button.attribute ?? "data-testid"}=${JSON.stringify(button.value)}]`)})`;
}

function assertSpec(spec: LoginFormSpec): void {
  const fields: Array<[string, FieldLocator | ButtonLocator | undefined]> = [
    ["username field", spec.username],
    ["password field", spec.password],
    ["sign-in button", spec.submit],
    ["one-time code field", spec.totp?.field],
    ["code submit button", spec.totp?.submit],
  ];
  for (const [name, locator] of fields) {
    if (locator === undefined && name.includes("code")) continue;
    if (!locator || !locator.value?.trim() || !["label", "placeholder", "testId", "role"].includes(locator.by)) {
      throw new DominionError(`The ${name} needs a label, placeholder, button name or test id.`, { code: "LOGIN_BUILDER_INCOMPLETE" });
    }
  }
}

/** The login script the builder writes. The spec is kept in a marker comment so it can be re-opened. */
export function renderLoginScript(spec: LoginFormSpec, packageName: string): string {
  assertSpec(spec);
  const totp = spec.totp;
  const lines = [
    "// DOMinion login script, written by the login builder in `npx dominion ui` (Setup tab). Commit this file.",
    "// DOMinion runs it with credentials from the env vars named in dominion.config.ts and saves the session;",
    "// agents and generated tests start from that session and never see a password. Edit it freely: once",
    "// you change it by hand, the builder leaves it alone.",
    `${BUILDER_MARKER}${JSON.stringify(spec)}`,
    `import type { LoginContext } from ${q(packageName)};`,
    "",
    "export default async function login({ page, env, credentials }: LoginContext) {",
    "  await page.goto(env.baseURL + env.auth.loginUrl);",
    `  await ${fieldCode(spec.username)}.fill(credentials.username);`,
    `  await ${fieldCode(spec.password)}.fill(credentials.password);`,
  ];
  if (totp && !totp.submit) {
    lines.push("  if (credentials.totp) {", `    await ${fieldCode(totp.field)}.fill(credentials.totp());`, "  }");
  }
  lines.push(`  await ${buttonCode(spec.submit)}.click();`);
  if (totp?.submit) {
    lines.push(
      "  if (credentials.totp) {",
      `    await ${fieldCode(totp.field)}.fill(credentials.totp());`,
      `    await ${buttonCode(totp.submit)}.click();`,
      "  }",
    );
  }
  lines.push("  // DOMinion then waits until the URL no longer matches auth.validate.loggedOutPattern and saves the session.", "}", "");
  return lines.join("\n");
}

const normalize = (text: string) => text.replace(/\r\n/g, "\n").trim();

/** Whether a login script is missing, still the init template, the builder's own, or hand-written. */
export function readLoginScriptState(path: string, packageName: string): LoginScriptState {
  if (!existsSync(path)) return { kind: "missing" };
  const text = readFileSync(path, "utf8");
  if (normalize(text) === normalize(renderTemplate("login.ts.tmpl", { packageName }))) return { kind: "template" };
  const marker = text.split(/\r?\n/).find((line) => line.startsWith(BUILDER_MARKER));
  if (marker) {
    try {
      const spec = JSON.parse(marker.slice(BUILDER_MARKER.length)) as LoginFormSpec;
      if (normalize(renderLoginScript(spec, packageName)) === normalize(text)) return { kind: "builder", spec };
    } catch {
      // a damaged marker means the file was edited by hand
    }
  }
  return { kind: "custom" };
}

/** Writes the builder's script. A hand-written script is only replaced with `overwrite`. */
export function writeLoginScript(path: string, spec: LoginFormSpec, packageName: string, options: { overwrite?: boolean } = {}): LoginScriptState {
  const content = renderLoginScript(spec, packageName);
  if (readLoginScriptState(path, packageName).kind === "custom" && !options.overwrite) {
    throw new DominionError("This login script was written or edited by hand; saving would replace it.", {
      code: "LOGIN_SCRIPT_CUSTOM",
      hint: "Tick “Replace my login script” to overwrite it, or keep editing it in your editor.",
    });
  }
  writeFileAtomic(path, content);
  return { kind: "builder", spec };
}

interface ElementInfo {
  index: number;
  label: string;
  ariaLabel: string;
  placeholder: string;
  testId: string;
  text: string;
}

interface FormScan {
  url: string;
  password?: ElementInfo;
  username?: ElementInfo;
  submit?: ElementInfo;
}

export interface DetectedLoginForm {
  /** Undefined when the page has no recognisable login form. */
  spec?: LoginFormSpec;
  /** The URL the browser ended up on. */
  url: string;
  notes: string[];
}

/**
 * Opens the login page in a fresh browser (no session) and works out how to find the username and
 * password fields and the sign-in button, preferring labels, then placeholders, then test ids.
 * Each choice is checked to match exactly one element. Nothing is typed or clicked.
 */
export async function detectLoginForm(options: { playwright: PlaywrightTestModule; baseURL: string; loginUrl: string; testIdAttribute: string; timeoutMs?: number }): Promise<DetectedLoginForm> {
  let browser;
  try {
    browser = await options.playwright.chromium.launch({ headless: true });
  } catch (error) {
    throw explainLaunchError(error);
  }
  try {
    const page = await (await browser.newContext({ baseURL: options.baseURL })).newPage();
    try {
      await page.goto(options.loginUrl, { waitUntil: "domcontentloaded", timeout: options.timeoutMs ?? 30_000 });
    } catch (error) {
      throw new DominionError(`Could not open the login page ${options.baseURL}${options.loginUrl}: ${(error as Error).message.split("\n")[0]}`, {
        code: "ENV_UNREACHABLE",
        hint: "Check that the app is running and that the base URL and login page are right.",
      });
    }
    await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => undefined);
    await page.locator("input[type=password]").first().waitFor({ state: "visible", timeout: 5_000 }).catch(() => undefined);

    const scan = await page.evaluate((attr): FormScan => {
      const visible = (el: Element) => {
        const box = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return box.width > 0 && box.height > 0 && style.visibility !== "hidden" && style.display !== "none";
      };
      const all = [...document.querySelectorAll("input, button, [role=button]")];
      const info = (el: Element | undefined): ElementInfo | undefined => {
        if (!el) return undefined;
        const input = el as HTMLInputElement;
        const label = input.labels?.[0]?.innerText.trim() ?? "";
        return {
          index: all.indexOf(el),
          label,
          ariaLabel: el.getAttribute("aria-label")?.trim() ?? "",
          placeholder: el.getAttribute("placeholder")?.trim() ?? "",
          testId: el.getAttribute(attr)?.trim() ?? "",
          text: (el instanceof HTMLInputElement ? el.value : (el as HTMLElement).innerText)?.trim() ?? "",
        };
      };
      const password = all.find((el) => el instanceof HTMLInputElement && el.type === "password" && visible(el)) as HTMLInputElement | undefined;
      if (!password) return { url: location.href };
      const scope = password.form ?? document;
      const textInputs = [...scope.querySelectorAll("input")].filter((el) => ["text", "email", "tel", ""].includes(el.type) && visible(el));
      const before = textInputs.filter((el) => el.compareDocumentPosition(password) & Node.DOCUMENT_POSITION_FOLLOWING);
      const username =
        before.find((el) => /username|email/.test(el.autocomplete)) ??
        before.find((el) => /user|email|login/i.test(`${el.name} ${el.id} ${el.type}`)) ??
        before[before.length - 1];
      const buttons = [...scope.querySelectorAll("button, input[type=submit], [role=button]")].filter(visible);
      const submit =
        buttons.find((el) => (el as HTMLButtonElement).type === "submit") ??
        buttons.find((el) => /log ?in|sign ?in|continue|submit|next/i.test((el as HTMLElement).innerText || (el as HTMLInputElement).value || ""));
      return { url: location.href, password: info(password), username: info(username), submit: info(submit) };
    }, options.testIdAttribute);

    const notes: string[] = [];
    if (!scan.password) {
      notes.push(`No password field on ${scan.url}. Check the login page setting; if login happens on another site (SSO), use a manual role instead.`);
      return { url: scan.url, notes };
    }
    const attr = options.testIdAttribute;
    const unique = async (locator: ReturnType<typeof page.locator>) => (await locator.count().catch(() => 0)) === 1;
    const chooseField = async (el: ElementInfo | undefined, what: string): Promise<FieldLocator | undefined> => {
      if (!el) return undefined;
      const candidates: FieldLocator[] = [
        ...(el.label ? [{ by: "label" as const, value: el.label }] : []),
        ...(el.ariaLabel ? [{ by: "label" as const, value: el.ariaLabel }] : []),
        ...(el.placeholder ? [{ by: "placeholder" as const, value: el.placeholder }] : []),
        ...(el.testId ? [{ by: "testId" as const, value: el.testId, attribute: attr }] : []),
      ];
      for (const candidate of candidates) {
        const locator =
          candidate.by === "label"
            ? page.getByLabel(candidate.value, { exact: true })
            : candidate.by === "placeholder"
              ? page.getByPlaceholder(candidate.value, { exact: true })
              : page.locator(`[${attr}=${JSON.stringify(candidate.value)}]`);
        if (await unique(locator)) return candidate;
      }
      notes.push(`The ${what} has no label, placeholder or ${attr} that identifies it; fill it in yourself.`);
      return undefined;
    };
    const username = await chooseField(scan.username, "username field");
    const password = await chooseField(scan.password, "password field");
    let submit: ButtonLocator | undefined;
    if (scan.submit) {
      const name = scan.submit.ariaLabel || scan.submit.text;
      if (name && (await unique(page.getByRole("button", { name, exact: true })))) submit = { by: "role", value: name };
      else if (scan.submit.testId && (await unique(page.locator(`[${attr}=${JSON.stringify(scan.submit.testId)}]`)))) submit = { by: "testId", value: scan.submit.testId, attribute: attr };
    }
    if (!submit) notes.push("Could not find the sign-in button; fill in its name yourself.");
    if (!username) notes.push("Could not find the username field next to the password field; fill it in yourself.");
    const spec = username && password && submit ? { username, password, submit } : undefined;
    return { spec, url: scan.url, notes };
  } finally {
    await browser.close().catch(() => undefined);
  }
}
