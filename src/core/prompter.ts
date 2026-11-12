/**
 * User interaction abstraction shared by core functions. The CLI supplies a terminal
 * implementation, the server a UI-backed one, and CI a non-interactive one that returns defaults.
 * Core code never reads stdin directly.
 */
export interface Choice<T extends string> {
  value: T;
  label: string;
}

export interface Prompter {
  /** False in CI, without a TTY, or with --yes. Non-interactive prompters return defaults. */
  readonly interactive: boolean;
  confirm(message: string, defaultValue: boolean): Promise<boolean>;
  input(message: string, defaultValue?: string): Promise<string>;
  select<T extends string>(message: string, choices: ReadonlyArray<Choice<T>>, defaultValue?: T): Promise<T>;
  /** Waits until the user signals they are done (Enter in the terminal, a button in the UI). */
  waitForUser(message: string): Promise<void>;
}

/** Prompter for CI and --yes: always takes the default, never blocks. */
export function nonInteractivePrompter(): Prompter {
  return {
    interactive: false,
    async confirm(_message, defaultValue) {
      return defaultValue;
    },
    async input(_message, defaultValue) {
      return defaultValue ?? "";
    },
    async select(message, choices, defaultValue) {
      const value = defaultValue ?? choices[0]?.value;
      if (value === undefined) throw new Error(`No choices available for: ${message}`);
      return value;
    },
    async waitForUser(message) {
      throw new Error(`Cannot wait for user input in non-interactive mode: ${message}`);
    },
  };
}

export type CommandRunner = (command: string, args: readonly string[], options: { cwd: string }) => Promise<number>;
