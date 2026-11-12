import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { inspectStorageState } from "../../src/core/auth/session";
import { generateTotp, normalizeTotpSecret } from "../../src/core/auth/totp";
import { DominionError } from "../../src/core/errors";
import { makeTempDir, removeDir, writeFiles } from "../helpers/tmp";

describe("TOTP", () => {
  it("generates the known code for a fixed time", () => {
    expect(generateTotp("JBSWY3DPEHPK3PXP", 1_700_000_000)).toBe("324550");
  });

  it("accepts pasted variants of the same secret", () => {
    for (const variant of ["jbswy3dpehpk3pxp", "JBSW Y3DP EHPK 3PXP", "JBSW-Y3DP-EHPK-3PXP", "JBSWY3DPEHPK3PXP===="]) {
      expect(normalizeTotpSecret(variant)).toBe("JBSWY3DPEHPK3PXP");
      expect(generateTotp(variant, 1_700_000_000)).toBe("324550");
    }
    expect(normalizeTotpSecret("otpauth://totp/Fixture:a@example.test?secret=JBSWY3DPEHPK3PXP&issuer=Fixture")).toBe(
      "JBSWY3DPEHPK3PXP",
    );
  });

  it("explains invalid secrets without echoing them", () => {
    expect(() => generateTotp("not base32 1!")).toThrow(DominionError);
    try {
      generateTotp("NOTBASE32!!");
    } catch (error) {
      expect((error as DominionError).message).not.toContain("NOTBASE32");
    }
    expect(() => normalizeTotpSecret("otpauth://totp/x?issuer=y")).toThrow(/without a secret/);
  });
});

describe("inspectStorageState", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) removeDir(dir);
    dir = undefined;
  });

  it("flags unreadable files and fully expired cookies", () => {
    dir = makeTempDir("storage");
    const now = 1_800_000_000;
    writeFiles(dir, {
      "bad.json": "{nope",
      "expired.json": JSON.stringify({ cookies: [{ expires: now - 10 }, { expires: now - 5 }] }),
      "session-cookie.json": JSON.stringify({ cookies: [{ expires: -1 }] }),
      "mixed.json": JSON.stringify({ cookies: [{ expires: now - 10 }, { expires: now + 1000 }] }),
      "empty.json": JSON.stringify({ cookies: [], origins: [] }),
    });
    expect(inspectStorageState(join(dir, "bad.json"), now).ok).toBe(false);
    expect(inspectStorageState(join(dir, "expired.json"), now)).toEqual({ ok: false, detail: "every cookie in the session has expired" });
    expect(inspectStorageState(join(dir, "session-cookie.json"), now).ok).toBe(true);
    expect(inspectStorageState(join(dir, "mixed.json"), now).ok).toBe(true);
    expect(inspectStorageState(join(dir, "empty.json"), now).ok).toBe(true);
  });
});
