import type { FastifyInstance } from "fastify";
import type { DominionEvent } from "../core/events";
import type { RunManager } from "../core/runs/manager";

/**
 * WS /api/runs/:id/events: replays events.jsonl (after ?after=<seq>) and then streams live events,
 * so a page reload resumes the live view without gaps or duplicates.
 */
export function registerEventStream(app: FastifyInstance, manager: RunManager): void {
  app.get<{ Params: { id: string }; Querystring: { after?: string } }>("/api/runs/:id/events", { websocket: true }, (socket, request) => {
    const runId = request.params.id;
    let lastSent = Number(request.query.after ?? 0) || 0;
    const send = (event: DominionEvent) => {
      if (event.seq <= lastSent || socket.readyState !== 1) return;
      lastSent = event.seq;
      socket.send(JSON.stringify(event));
    };
    let unsubscribe = () => {};
    try {
      // Subscribe before replaying; replay is synchronous, so nothing is missed in between.
      unsubscribe = manager.subscribe(runId, send);
      for (const event of manager.events(runId, lastSent)) send(event);
      socket.send(JSON.stringify({ type: "stream.ready", live: manager.isLive(runId), lastSeq: lastSent }));
    } catch (error) {
      socket.send(JSON.stringify({ type: "stream.error", error: error instanceof Error ? error.message : String(error) }));
      socket.close(1011, "run not found");
      return;
    }
    socket.on("close", () => unsubscribe());
  });
}
