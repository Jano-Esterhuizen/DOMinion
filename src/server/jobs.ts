import { randomBytes } from "node:crypto";
import { DominionError, errorMessage, isDominionError } from "../core/errors";
import { activeRedactor } from "../core/redact";

/** A long Setup task (installing Playwright, recording a login) whose log the UI polls. */
export interface SetupJob {
  id: string;
  kind: string;
  state: "running" | "done" | "failed";
  log: string[];
  error?: string;
  hint?: string;
  startedAt: string;
  finishedAt?: string;
}

const MAX_LOG_LINES = 500;

export class SetupJobs {
  private readonly jobs = new Map<string, SetupJob>();

  /** Starts `work` in the background; one job of each kind at a time. */
  start(kind: string, work: (log: (line: string) => void) => Promise<void>, onDone?: () => Promise<void> | void): SetupJob {
    const running = [...this.jobs.values()].find((j) => j.kind === kind && j.state === "running");
    if (running) throw new DominionError("That is already running.", { code: "JOB_RUNNING", hint: "Wait for it to finish." });
    const job: SetupJob = { id: randomBytes(6).toString("hex"), kind, state: "running", log: [], startedAt: new Date().toISOString() };
    this.jobs.set(job.id, job);
    const log = (line: string) => {
      job.log.push(activeRedactor().redact(line));
      if (job.log.length > MAX_LOG_LINES) job.log.splice(0, job.log.length - MAX_LOG_LINES);
    };
    void work(log)
      .then(async () => {
        await onDone?.();
        job.state = "done";
      })
      .catch((error: unknown) => {
        job.state = "failed";
        job.error = activeRedactor().redact(errorMessage(error));
        job.hint = isDominionError(error) && error.hint ? activeRedactor().redact(error.hint) : undefined;
      })
      .finally(() => {
        job.finishedAt = new Date().toISOString();
      });
    return job;
  }

  get(id: string): SetupJob {
    const job = this.jobs.get(id);
    if (!job) throw new DominionError("No such setup job.", { code: "JOB_NOT_FOUND" });
    return job;
  }

  /** The newest job of a kind, so a reloaded page can pick it up again. */
  latest(kind: string): SetupJob | undefined {
    return [...this.jobs.values()].filter((j) => j.kind === kind).pop();
  }
}
