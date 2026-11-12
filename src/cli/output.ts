import { DominionError, errorMessage } from "../core/errors";
import { redactText } from "../core/redact";

const colorEnabled = (() => {
  if (process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR && process.env.FORCE_COLOR !== "0") return true;
  return Boolean(process.stdout.isTTY);
})();

const wrap = (open: number, close: number) => (text: string) =>
  colorEnabled ? `\u001b[${open}m${text}\u001b[${close}m` : text;

export const color = {
  bold: wrap(1, 22),
  dim: wrap(2, 22),
  red: wrap(31, 39),
  green: wrap(32, 39),
  yellow: wrap(33, 39),
  blue: wrap(34, 39),
  cyan: wrap(36, 39),
  gray: wrap(90, 39),
};

export function line(text = ""): void {
  process.stdout.write(`${text}\n`);
}

export function warn(text: string): void {
  process.stderr.write(`${color.yellow("warning")} ${text}\n`);
}

/** Prints an error for the user and returns the exit code the CLI should use. */
export function reportCliError(error: unknown): number {
  if (error instanceof DominionError) {
    process.stderr.write(`${color.red("error")} ${redactText(error.message)}\n`);
    if (error.hint) process.stderr.write(`${color.gray("  ->")} ${redactText(error.hint)}\n`);
    if (process.env.DOMINION_DEBUG && error.stack) process.stderr.write(`${color.gray(error.stack)}\n`);
    return error.exitCode;
  }
  process.stderr.write(`${color.red("error")} ${redactText(errorMessage(error))}\n`);
  if (error instanceof Error && error.stack) {
    process.stderr.write(
      process.env.DOMINION_DEBUG
        ? `${color.gray(redactText(error.stack))}\n`
        : `${color.gray("  -> set DOMINION_DEBUG=1 for the stack trace")}\n`,
    );
  }
  return 1;
}
