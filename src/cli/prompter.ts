import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import type { Choice, Prompter } from "../core/prompter";
import { nonInteractivePrompter } from "../core/prompter";
import { color } from "./output";

/** True when the CLI may ask questions: a TTY on both ends, not CI, and no --yes. */
export function canPrompt(yes?: boolean): boolean {
  return !yes && Boolean(stdin.isTTY) && Boolean(stdout.isTTY) && !process.env.CI;
}

async function ask(question: string): Promise<string> {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

/** Terminal prompter. Falls back to defaults (never blocks) when prompting is not possible. */
export function terminalPrompter(options: { yes?: boolean } = {}): Prompter {
  if (!canPrompt(options.yes)) return nonInteractivePrompter();
  return {
    interactive: true,
    async confirm(message, defaultValue) {
      const suffix = defaultValue ? "[Y/n]" : "[y/N]";
      for (;;) {
        const answer = (await ask(`${color.cyan("?")} ${message} ${color.gray(suffix)} `)).trim().toLowerCase();
        if (!answer) return defaultValue;
        if (["y", "yes"].includes(answer)) return true;
        if (["n", "no"].includes(answer)) return false;
      }
    },
    async input(message, defaultValue) {
      const suffix = defaultValue ? ` ${color.gray(`(${defaultValue})`)}` : "";
      const answer = (await ask(`${color.cyan("?")} ${message}${suffix} `)).trim();
      return answer || defaultValue || "";
    },
    async select<T extends string>(message: string, choices: ReadonlyArray<Choice<T>>, defaultValue?: T) {
      stdout.write(`${color.cyan("?")} ${message}\n`);
      choices.forEach((choice, index) => stdout.write(`  ${index + 1}) ${choice.label}\n`));
      const defaultIndex = Math.max(0, choices.findIndex((c) => c.value === defaultValue));
      for (;;) {
        const answer = (await ask(`  ${color.gray(`choose 1-${choices.length} (${defaultIndex + 1})`)} `)).trim();
        if (!answer) return choices[defaultIndex]!.value;
        const index = Number(answer) - 1;
        if (Number.isInteger(index) && choices[index]) return choices[index]!.value;
      }
    },
    async waitForUser(message) {
      await ask(`${color.cyan("?")} ${message} ${color.gray("(press Enter)")} `);
    },
  };
}
