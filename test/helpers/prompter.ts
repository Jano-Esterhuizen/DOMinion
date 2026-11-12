import type { Choice, Prompter } from "../../src/core/prompter";

export interface ScriptedAnswers {
  confirm?: boolean[];
  input?: string[];
  select?: string[];
}

/** An interactive prompter that replays scripted answers and records every question asked. */
export function scriptedPrompter(answers: ScriptedAnswers = {}) {
  const asked: string[] = [];
  const queues = {
    confirm: [...(answers.confirm ?? [])],
    input: [...(answers.input ?? [])],
    select: [...(answers.select ?? [])],
  };
  const prompter: Prompter = {
    interactive: true,
    async confirm(message, defaultValue) {
      asked.push(`confirm: ${message}`);
      return queues.confirm.length ? queues.confirm.shift()! : defaultValue;
    },
    async input(message, defaultValue) {
      asked.push(`input: ${message}`);
      return queues.input.length ? queues.input.shift()! : (defaultValue ?? "");
    },
    async select<T extends string>(message: string, choices: ReadonlyArray<Choice<T>>, defaultValue?: T) {
      asked.push(`select: ${message}`);
      const next = queues.select.shift();
      return (next as T | undefined) ?? defaultValue ?? choices[0]!.value;
    },
    async waitForUser(message) {
      asked.push(`wait: ${message}`);
    },
  };
  return { prompter, asked };
}
