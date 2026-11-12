import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ProjectPaths } from "../config/resolve";
import { DominionError } from "../errors";
import { type DominionEvent, type DominionEventPayload, EventBus } from "../events";
import { writeFileAtomic } from "../fs";
import type { Redactor } from "../redact";
import { RUN_ID_RE } from "./ids";
import type { RunRecord } from "./types";

/**
 * A run on disk: .dominion/runs/<id>/run.json (state) and events.jsonl (append-only history).
 * Both are redacted before they are written, so a page reload or a restart can rebuild the run.
 */
export class RunHandle {
  readonly bus = new EventBus();
  private seq: number;

  constructor(
    readonly dir: string,
    public record: RunRecord,
    private readonly redactor: Redactor,
  ) {
    const eventsPath = join(dir, "events.jsonl");
    this.seq = existsSync(eventsPath) ? readFileSync(eventsPath, "utf8").split("\n").filter(Boolean).length : 0;
  }

  get id(): string {
    return this.record.id;
  }

  get eventsPath(): string {
    return join(this.dir, "events.jsonl");
  }

  /** Redacts, numbers, persists and broadcasts an event. */
  emit(payload: DominionEventPayload): DominionEvent {
    this.seq += 1;
    const event = this.redactor.redactDeep({
      ...payload,
      seq: this.seq,
      ts: new Date().toISOString(),
      runId: this.record.id,
    }) as DominionEvent;
    appendFileSync(this.eventsPath, `${JSON.stringify(event)}\n`, "utf8");
    this.bus.publish(event);
    return event;
  }

  /** Applies a change to run.json and writes it atomically (redacted). */
  update(mutate: (record: RunRecord) => void): RunRecord {
    mutate(this.record);
    this.record.updatedAt = new Date().toISOString();
    this.save();
    return this.record;
  }

  save(): void {
    writeFileAtomic(join(this.dir, "run.json"), `${JSON.stringify(this.redactor.redactDeep(this.record), null, 2)}\n`);
  }

  /** All persisted events, optionally after a sequence number (for WebSocket replay). */
  events(afterSeq = 0): DominionEvent[] {
    if (!existsSync(this.eventsPath)) return [];
    return readFileSync(this.eventsPath, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as DominionEvent)
      .filter((e) => e.seq > afterSeq);
  }

  /** Absolute path of a file inside the run folder. */
  path(...segments: string[]): string {
    return join(this.dir, ...segments);
  }
}

export class RunStore {
  private readonly open = new Map<string, RunHandle>();

  constructor(
    private readonly paths: Pick<ProjectPaths, "runsDir">,
    readonly redactor: Redactor,
  ) {}

  get runsDir(): string {
    return this.paths.runsDir;
  }

  create(record: RunRecord): RunHandle {
    const dir = join(this.paths.runsDir, record.id);
    if (existsSync(dir)) throw new Error(`Run ${record.id} already exists`);
    mkdirSync(dir, { recursive: true });
    const handle = new RunHandle(dir, record, this.redactor);
    handle.save();
    this.open.set(record.id, handle);
    return handle;
  }

  /** Opens an existing run, reusing the live handle when the run is active in this process. */
  get(runId: string): RunHandle {
    const live = this.open.get(runId);
    if (live) return live;
    if (!RUN_ID_RE.test(runId)) throw new DominionError(`"${runId}" is not a run ID.`, { code: "RUN_NOT_FOUND", hint: "List runs with `npx dominion runs`." });
    const dir = join(this.paths.runsDir, runId);
    const file = join(dir, "run.json");
    if (!existsSync(file)) {
      throw new DominionError(`Run ${runId} was not found.`, { code: "RUN_NOT_FOUND", hint: "List runs with `npx dominion runs`." });
    }
    const handle = new RunHandle(dir, JSON.parse(readFileSync(file, "utf8")) as RunRecord, this.redactor);
    this.open.set(runId, handle);
    return handle;
  }

  /** Every run on disk, newest first. Unreadable runs are skipped. */
  list(): RunRecord[] {
    if (!existsSync(this.paths.runsDir)) return [];
    const records: RunRecord[] = [];
    for (const id of readdirSync(this.paths.runsDir)) {
      const live = this.open.get(id);
      if (live) {
        records.push(live.record);
        continue;
      }
      try {
        records.push(JSON.parse(readFileSync(join(this.paths.runsDir, id, "run.json"), "utf8")) as RunRecord);
      } catch {
        // half-written or foreign folder
      }
    }
    return records.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
}
