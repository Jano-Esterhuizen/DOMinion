import { describe, expect, it } from "vitest";
import { validateConfig } from "../../src/core/config/loader";
import { REDACTED, Redactor, redactorFromConfig } from "../../src/core/redact";

describe("Redactor", () => {
  const redactor = new Redactor([
    { name: "PASS", value: "p@ss w0rd&<x>" },
    { name: "USER", value: "fixture.user@example.test" },
    { name: "EMPTY", value: "" },
    { name: "UNSET", value: undefined },
    { name: "SHORT", value: "abc" },
  ]);

  it("redacts raw values everywhere they occur", () => {
    expect(redactor.redact("login fixture.user@example.test with p@ss w0rd&<x> twice: p@ss w0rd&<x>")).toBe(
      `login ${REDACTED} with ${REDACTED} twice: ${REDACTED}`,
    );
  });

  it("redacts URL-encoded, form-encoded, JSON-escaped and HTML-escaped forms", () => {
    expect(redactor.redact(`/login?u=${encodeURIComponent("fixture.user@example.test")}`)).toBe(`/login?u=${REDACTED}`);
    expect(redactor.redact("pw=p%40ss+w0rd%26%3Cx%3E")).toBe(`pw=${REDACTED}`);
    expect(redactor.redact(JSON.stringify({ v: 'p@ss w0rd&<x>' }))).toBe(`{"v":"${REDACTED}"}`);
    expect(redactor.redact("<td>p@ss w0rd&amp;&lt;x&gt;</td>")).toBe(`<td>${REDACTED}</td>`);
  });

  it("ignores empty values and records ones too short to redact", () => {
    expect(redactor.size).toBe(2);
    expect(redactor.tooShort).toEqual(["SHORT"]);
    expect(redactor.redact("abc")).toBe("abc");
  });

  it("replaces the longest secret first", () => {
    const r = new Redactor([
      { name: "A", value: "secret" },
      { name: "B", value: "secret-and-more" },
    ]);
    expect(r.redact("x secret-and-more y secret")).toBe(`x ${REDACTED} y ${REDACTED}`);
  });

  it("redacts strings deep inside objects without touching keys or the original", () => {
    const original = {
      message: "typed fixture.user@example.test",
      nested: [{ input: { text: "p@ss w0rd&<x>" } }, 42, null, true],
      "fixture.user@example.test": "key stays",
    };
    const cyclic: any = { self: undefined, note: "p@ss w0rd&<x>" };
    cyclic.self = cyclic;
    const redacted = redactor.redactDeep(original);
    expect(redacted).toEqual({
      message: `typed ${REDACTED}`,
      nested: [{ input: { text: REDACTED } }, 42, null, true],
      "fixture.user@example.test": "key stays",
    });
    expect(original.message).toBe("typed fixture.user@example.test");
    const redactedCycle = redactor.redactDeep(cyclic);
    expect(redactedCycle.note).toBe(REDACTED);
    expect(redactedCycle.self).toBe(redactedCycle);
  });

  it("reports which secrets appear in a text", () => {
    expect(redactor.findSecrets("no secrets here")).toEqual([]);
    expect(redactor.findSecrets("user=fixture.user%40example.test")).toEqual(["USER"]);
  });

  it("is a no-op without secrets", () => {
    const empty = new Redactor();
    expect(empty.redact("anything")).toBe("anything");
    const obj = { a: "b" };
    expect(empty.redactDeep(obj)).toBe(obj);
  });
});

describe("redactorFromConfig", () => {
  it("collects every env var the config references plus API credentials", () => {
    const config = validateConfig(
      {
        environments: {
          s: {
            baseURL: "https://a.example.com",
            roles: { c: { strategy: "form", userEnv: "S_USER", passEnv: "S_PASS", totpEnv: "S_TOTP" } },
          },
        },
      },
      "c",
    );
    const r = redactorFromConfig(config, {
      S_USER: "someone@example.test",
      S_PASS: "correct-horse",
      S_TOTP: "JBSWY3DPEHPK3PXP",
      ANTHROPIC_API_KEY: "sk-ant-test-0000",
      UNRELATED: "visible-value",
    });
    expect(r.redact("someone@example.test correct-horse JBSWY3DPEHPK3PXP sk-ant-test-0000 visible-value")).toBe(
      `${REDACTED} ${REDACTED} ${REDACTED} ${REDACTED} visible-value`,
    );
  });
});
