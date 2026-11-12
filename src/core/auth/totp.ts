import { createGuardrails, generateSync } from "otplib";
import { DominionError } from "../errors";

/**
 * otplib v13 rejects secrets under 16 bytes by default, but many apps issue 80-bit (10-byte)
 * secrets, so DOMinion accepts those too.
 */
const guardrails = createGuardrails({ MIN_SECRET_BYTES: 10 });

/**
 * Accepts the forms people paste: a base32 secret with spaces/dashes/lowercase/padding, or an
 * otpauth:// URI (as encoded in a QR code).
 */
export function normalizeTotpSecret(raw: string): string {
  let value = raw.trim();
  if (/^otpauth:\/\//i.test(value)) {
    const secret = new URL(value).searchParams.get("secret");
    if (!secret) {
      throw new DominionError("The TOTP value is an otpauth:// URI without a secret parameter.", {
        code: "TOTP_BAD_SECRET",
        hint: "Set the role's totpEnv variable to the base32 secret (or the full otpauth:// URI) from your MFA setup.",
      });
    }
    value = secret;
  }
  return value.replace(/[\s-]/g, "").replace(/=+$/, "").toUpperCase();
}

/** Current 6-digit TOTP code for a secret. `epochSeconds` is for tests. */
export function generateTotp(rawSecret: string, epochSeconds?: number): string {
  const secret = normalizeTotpSecret(rawSecret);
  try {
    return generateSync({ secret, guardrails, ...(epochSeconds === undefined ? {} : { epoch: epochSeconds }) });
  } catch (error) {
    throw new DominionError("Could not generate a TOTP code from the configured secret.", {
      code: "TOTP_BAD_SECRET",
      cause: error,
      hint: "The totpEnv variable must hold the base32 TOTP secret (letters A-Z and digits 2-7) or an otpauth:// URI.",
    });
  }
}
