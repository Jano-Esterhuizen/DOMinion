import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseDotenv } from "dotenv";
import { afterAll, describe, expect, it } from "vitest";
import { loadConfig } from "../../src/core/config/loader";
import { DominionError } from "../../src/core/errors";
import { renderTemplate } from "../../src/core/templates";
import { editConfig } from "../../src/core/setup/config-edit";
import { envVarStates, formatEnvValue, writeEnvValues } from "../../src/core/setup/env-file";
import { type LoginFormSpec, readLoginScriptState, renderLoginScript, writeLoginScript } from "../../src/core/setup/login-builder";
import { addRole, removeRole, updateEnvironment } from "../../src/core/setup/project";
import { getSetupState } from "../../src/core/setup/state";
import { makeTempDir, removeDir, writeFiles } from "../helpers/tmp";

const dirs: string[] = [];
const tmp = (name: string) => {
  const dir = makeTempDir(name);
  dirs.push(dir);
  return dir;
};
afterAll(() => dirs.forEach(removeDir));

async function expectError(promise: Promise<unknown>, code: string): Promise<DominionError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error, `expected ${code}`).toBeInstanceOf(DominionError);
  expect((error as DominionError).code).toBe(code);
  return error as DominionError;
}

/** A project as `dominion init` writes it for a new setup. */
function initProject(name: string): string {
  const root = tmp(name);
  writeFiles(root, {
    "package.json": JSON.stringify({ name: "app", private: true, type: "module" }),
    "playwright.config.ts": 'import { defineConfig } from "@playwright/test";\nexport default defineConfig({ testDir: "./tests" });\n',
    "dominion.config.ts": renderTemplate("dominion.config.ts.tmpl", { packageName: "dominion-playwright", envName: "staging", baseURL: "http://localhost:3000", origin: "http://localhost:3000", envPrefix: "STAGING" }),
  });
  return root;
}

describe(".env.local writer", () => {
  it("writes values dotenv reads back exactly", () => {
    for (const value of ["plain", "with space", "has#hash", "quote'single", 'quote"double', "back\\slash", "multi\nline", "=leading", ""]) {
      expect(parseDotenv(`K=${formatEnvValue(value)}`).K, JSON.stringify(value)).toBe(value);
    }
  });

  it("fixes .gitignore before writing a secret, keeps comments, and updates this process", () => {
    const root = tmp("envfile");
    writeFiles(root, { ".env.local": "# my notes\nSTAGING_CUSTOMER_USER=\nOTHER=keep me\n" });
    const env: NodeJS.ProcessEnv = { STAGING_CUSTOMER_USER: "", SHELL_SET: "from-shell" };
    const result = writeEnvValues(root, { STAGING_CUSTOMER_USER: "alex@example.test", ANTHROPIC_API_KEY: "sk-ant-test 123", SHELL_SET: "from-ui" }, env);
    expect(result.gitignoreAdded).toEqual([".env.local", ".auth/", ".dominion/"]);
    const text = readFileSync(join(root, ".env.local"), "utf8");
    expect(text).toContain("# my notes\nSTAGING_CUSTOMER_USER=alex@example.test\nOTHER=keep me\n");
    expect(parseDotenv(text)).toMatchObject({ ANTHROPIC_API_KEY: "sk-ant-test 123", OTHER: "keep me" });
    expect(env.STAGING_CUSTOMER_USER).toBe("alex@example.test");
    // The shell's value wins over .env.local, as when DOMinion loads it.
    expect(env.SHELL_SET).toBe("from-shell");
    expect(result.shellWins).toEqual(["SHELL_SET"]);
    expect(envVarStates(root, ["STAGING_CUSTOMER_USER", "SHELL_SET", "MISSING"], env)).toEqual([
      { name: "STAGING_CUSTOMER_USER", set: true, inFile: true, fromShell: false },
      { name: "SHELL_SET", set: true, inFile: true, fromShell: true },
      { name: "MISSING", set: false, inFile: false, fromShell: false },
    ]);
    if (process.platform !== "win32") expect(statSync(join(root, ".env.local")).mode & 0o077).toBe(0);
  });

  it("creates .env.local from the template and rejects bad names", () => {
    const root = tmp("envfile-new");
    writeEnvValues(root, { ANTHROPIC_API_KEY: "sk-ant-x" }, {});
    expect(readFileSync(join(root, ".env.local"), "utf8")).toMatch(/never commit it[\s\S]*ANTHROPIC_API_KEY=sk-ant-x/);
    expect(() => writeEnvValues(root, { "BAD NAME": "x" }, {})).toThrow(/Not an environment variable name/);
  });
});

describe("editing dominion.config.ts", () => {
  it("changes the app settings in place and keeps comments", async () => {
    const root = initProject("edit-env");
    const loaded = await updateEnvironment(await loadConfig({ cwd: root }), "staging", {
      baseURL: "http://localhost:4000/",
      loginUrl: "/signin",
      validateUrl: "/products",
      loggedOutPattern: "/signin",
      testIdAttribute: "data-test",
    });
    const text = readFileSync(join(root, "dominion.config.ts"), "utf8");
    expect(text).toContain("// DOMinion configuration. Commit this file.");
    expect(text).toContain('baseURL: "http://localhost:4000"');
    expect(text).toContain('allowedOrigins: ["http://localhost:4000"], // add your auth/SSO origin here');
    expect(text).toContain('loginUrl: "/signin"');
    expect(text).toContain('validate: { url: "/products", loggedOutPattern: "/signin" }');
    expect(text).toContain('testIdAttribute: "data-test"');
    expect(loaded.config.environments.staging!.auth?.validate).toEqual({ url: "/products", loggedOutPattern: "/signin" });
  });

  it("turns session checks off only when both fields are cleared", async () => {
    const root = initProject("edit-validate");
    const loaded = await loadConfig({ cwd: root });
    await expectError(updateEnvironment(loaded, "staging", { validateUrl: "" }), "SETUP_VALIDATE_INCOMPLETE");
    const off = await updateEnvironment(loaded, "staging", { validateUrl: "", loggedOutPattern: "" });
    expect(off.config.environments.staging!.auth?.validate).toBeUndefined();
  });

  it("never overwrites a value computed in code, and rolls back an invalid edit", async () => {
    const root = initProject("edit-computed");
    const path = join(root, "dominion.config.ts");
    writeFileSync(path, readFileSync(path, "utf8").replace('baseURL: "http://localhost:3000"', 'baseURL: process.env.APP_URL ?? "http://localhost:3000"'));
    const loaded = await loadConfig({ cwd: root });
    const error = await expectError(updateEnvironment(loaded, "staging", { baseURL: "http://x.test" }), "CONFIG_NOT_EDITABLE");
    expect(error.message).toContain("environments.staging.baseURL");
    const before = readFileSync(path, "utf8");
    await expectError(
      editConfig(loaded, (doc) => doc.setString(doc.root, "model", "", [])),
      "CONFIG_EDIT_INVALID",
    );
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  it("adds and removes roles with env var names that follow the environment", async () => {
    const root = initProject("edit-roles");
    let loaded = await addRole(await loadConfig({ cwd: root }), "staging", { name: "admin", strategy: "form", totp: true });
    expect(loaded.config.environments.staging!.roles.admin).toEqual({ strategy: "form", userEnv: "STAGING_ADMIN_USER", passEnv: "STAGING_ADMIN_PASS", totpEnv: "STAGING_ADMIN_TOTP" });
    loaded = await addRole(loaded, "staging", { name: "sso", strategy: "manual" });
    await expectError(addRole(loaded, "staging", { name: "admin", strategy: "none" }), "SETUP_ROLE_EXISTS");
    await expectError(addRole(loaded, "staging", { name: "bad name", strategy: "none" }), "SETUP_BAD_ROLE");
    loaded = await removeRole(loaded, "staging", "admin");
    expect(Object.keys(loaded.config.environments.staging!.roles)).toEqual(["guest", "customer", "sso"]);
    const text = readFileSync(join(root, "dominion.config.ts"), "utf8");
    expect(text).toContain("// admin: { strategy: \"form\""); // the commented example stays
  });
});

describe("editing a compact existing-suite config", () => {
  it("adds a missing auth section and roles in the object's own one-line style", async () => {
    const root = tmp("edit-compact");
    writeFiles(root, {
      "package.json": JSON.stringify({ name: "app", private: true, type: "module" }),
      "dominion.config.ts": 'import { defineConfig } from "dominion-playwright";\nexport default defineConfig({\n  environments: {\n    staging: { baseURL: "http://localhost:3000", roles: { user: { strategy: "none" } } },\n  },\n});\n',
    });
    let loaded = await updateEnvironment(await loadConfig({ cwd: root }), "staging", { validateUrl: "/account", loggedOutPattern: "/login" });
    loaded = await addRole(loaded, "staging", { name: "support-agent", strategy: "manual" });
    expect(readFileSync(join(root, "dominion.config.ts"), "utf8")).toContain(
      'staging: { baseURL: "http://localhost:3000", roles: { user: { strategy: "none" }, "support-agent": { strategy: "manual" } }, auth: { validate: { url: "/account", loggedOutPattern: "/login" } } },',
    );
    expect(loaded.config.environments.staging!.roles["support-agent"]).toEqual({ strategy: "manual" });
  });
});

describe("login script builder", () => {
  const spec: LoginFormSpec = {
    username: { by: "label", value: "Username" },
    password: { by: "placeholder", value: "Password" },
    submit: { by: "role", value: "Log in" },
    totp: { field: { by: "testId", value: "otp", attribute: "data-test" }, submit: { by: "role", value: "Verify" } },
  };

  it("writes a script that reads credentials only, and recognises its own output", () => {
    const root = tmp("builder");
    const path = join(root, "dominion", "auth", "login.ts");
    const script = renderLoginScript(spec, "dominion-playwright");
    expect(script).toContain('await page.getByLabel("Username", { exact: true }).fill(credentials.username);');
    expect(script).toContain('await page.getByPlaceholder("Password", { exact: true }).fill(credentials.password);');
    expect(script).toContain('await page.getByRole("button", { name: "Log in", exact: true }).click();');
    expect(script).toContain('await page.locator("[data-test=\\"otp\\"]").fill(credentials.totp());');
    expect(script.indexOf('name: "Log in"')).toBeLessThan(script.indexOf("credentials.totp()")); // code on a second screen

    expect(readLoginScriptState(path, "dominion-playwright")).toEqual({ kind: "missing" });
    writeFiles(root, { "dominion/auth/login.ts": renderTemplate("login.ts.tmpl", { packageName: "dominion-playwright" }) });
    expect(readLoginScriptState(path, "dominion-playwright").kind).toBe("template");
    writeLoginScript(path, spec, "dominion-playwright");
    expect(readLoginScriptState(path, "dominion-playwright")).toEqual({ kind: "builder", spec });

    // Edited by hand: the builder leaves it alone unless told to replace it.
    writeFileSync(path, readFileSync(path, "utf8").replace("page.goto(", "page.goto(/* mine */ "));
    expect(readLoginScriptState(path, "dominion-playwright").kind).toBe("custom");
    expect(() => writeLoginScript(path, spec, "dominion-playwright")).toThrow(/edited by hand/);
    expect(writeLoginScript(path, spec, "dominion-playwright", { overwrite: true }).kind).toBe("builder");
  });

  it("refuses an incomplete form", () => {
    expect(() => renderLoginScript({ ...spec, submit: { by: "role", value: " " } }, "x")).toThrow(/sign-in button/);
  });
});

describe("setup checklist", () => {
  it("starts with Playwright, the API key and the config to do", async () => {
    const root = tmp("state-bare");
    writeFiles(root, { "package.json": JSON.stringify({ name: "bare", private: true }) });
    const state = await getSetupState(root);
    expect(state.items.map((i) => [i.id, i.status])).toEqual(
      expect.arrayContaining([
        ["dominion", "todo"],
        ["api-key", state.apiKey.set ? "done" : "todo"],
      ]),
    );
    expect(state.detection?.mode).toBe("new");
    expect(state.ready).toBe(false);
    expect(JSON.stringify(state)).not.toMatch(/sk-ant-/);
  });

  it("lists credentials, the login script and a first login for a new config", async () => {
    const root = initProject("state-config");
    writeFiles(root, { "dominion/auth/login.ts": renderTemplate("login.ts.tmpl", { packageName: "dominion-playwright" }) });
    const state = await getSetupState(root);
    const byId = Object.fromEntries(state.items.map((i) => [i.id, i]));
    expect(byId.dominion?.status).toBe("done");
    expect(byId["credentials:staging"]).toMatchObject({ status: "todo", detail: "STAGING_CUSTOMER_USER, STAGING_CUSTOMER_PASS not set", env: "staging" });
    expect(byId["login-script:dominion/auth/login.ts"]).toMatchObject({ status: "todo", detail: "dominion/auth/login.ts is still the template" });
    expect(byId["session:staging/customer"]?.status).toBe("optional");
    expect(byId["login:staging"]?.status).toBe("todo");
    expect(byId["app:staging"]?.status).toBe("done");
    expect(state.environments[0]!.roles.find((r) => r.name === "customer")?.loginScript).toMatchObject({ path: "dominion/auth/login.ts", kind: "template" });
    expect(existsSync(join(root, ".env.local"))).toBe(false); // reading state writes nothing
  });
});
