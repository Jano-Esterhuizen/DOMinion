/**
 * Errors that reach the user. Every DominionError carries a message that says what went wrong
 * and, where possible, a hint that says exactly what to do next ("prefer clear errors over
 * silent fallbacks").
 */
export interface DominionErrorOptions {
  /** One or two sentences telling the user how to fix the problem. */
  hint?: string;
  /** Stable machine-readable code, for tests and the UI. */
  code?: string;
  cause?: unknown;
  /** Process exit code when the error ends a CLI command. Defaults to 1. */
  exitCode?: number;
}

export class DominionError extends Error {
  readonly hint?: string;
  readonly code: string;
  readonly exitCode: number;

  constructor(message: string, options: DominionErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "DominionError";
    this.hint = options.hint;
    this.code = options.code ?? "DOMINION_ERROR";
    this.exitCode = options.exitCode ?? 1;
  }
}

export function isDominionError(value: unknown): value is DominionError {
  return value instanceof DominionError;
}

/** Normalizes anything thrown into a message string without leaking stack traces to users. */
export function errorMessage(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
