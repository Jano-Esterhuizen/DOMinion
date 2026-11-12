import { createRequire } from "node:module";
import type { DominionEvent } from "../../src/core/events";

const require = createRequire(import.meta.url);
// `ws` ships with @fastify/websocket; Node's global WebSocket cannot send custom headers.
const WebSocketWs = require("ws") as new (url: string, options?: { headers?: Record<string, string> }) => {
  on(event: "message", listener: (data: Buffer) => void): void;
  on(event: "open" | "close", listener: () => void): void;
  on(event: "error", listener: (error: Error) => void): void;
  close(): void;
};

export async function http(base: string, token: string | undefined, path: string, init: { method?: string; json?: unknown; headers?: Record<string, string> } = {}) {
  const response = await fetch(`${base}${path}`, {
    method: init.method ?? "GET",
    redirect: "manual",
    headers: {
      ...(token ? { "x-dominion-token": token } : {}),
      ...(init.json !== undefined ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
    body: init.json !== undefined ? JSON.stringify(init.json) : undefined,
  });
  const text = await response.text();
  let body: any = text;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    // not JSON
  }
  return { status: response.status, body, headers: response.headers };
}

/** Polls until `check` returns a truthy value or the timeout passes. */
export async function waitFor<T>(check: () => Promise<T | undefined | false>, timeoutMs = 120_000, label = "condition"): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

/** Collects events from the run event stream until `stream.ready` (replay complete). */
export function readEventStream(base: string, token: string, runId: string, after = 0): Promise<{ events: DominionEvent[]; ready: { live: boolean } }> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocketWs(`${base.replace("http", "ws")}/api/runs/${runId}/events?after=${after}`, { headers: { "x-dominion-token": token } });
    const events: DominionEvent[] = [];
    socket.on("message", (data) => {
      const message = JSON.parse(data.toString());
      if (message.type === "stream.ready") {
        socket.close();
        resolve({ events, ready: message });
      } else if (message.type === "stream.error") {
        socket.close();
        reject(new Error(message.error));
      } else events.push(message);
    });
    socket.on("error", reject);
  });
}

export function openSocket(base: string, headers: Record<string, string>, runId: string): Promise<"open" | number> {
  return new Promise((resolve) => {
    const socket = new WebSocketWs(`${base.replace("http", "ws")}/api/runs/${runId}/events`, { headers });
    socket.on("open", () => {
      socket.close();
      resolve("open");
    });
    socket.on("error", (error) => resolve(Number(/(\d{3})/.exec(error.message)?.[1] ?? 0)));
  });
}
