import { useCallback, useEffect, useRef, useState } from "react";
import type { DominionEvent } from "../core/events";
import type { RunRecord } from "../core/orchestrator/types";
import type { DetectedLoginForm, LoginFormSpec, LoginScriptState } from "../core/setup/login-builder";
import type { EnvironmentSetup, RoleSetup, SetupItem, SetupState } from "../core/setup/state";
import type { SetupJob } from "../server/jobs";
import type { PlaywrightUiStatus } from "../server/playwright-ui";

export type { DetectedLoginForm, DominionEvent, EnvironmentSetup, LoginFormSpec, LoginScriptState, PlaywrightUiStatus, RoleSetup, RunRecord, SetupItem, SetupJob };

/** GET /api/setup: the Setup tab's whole state (never contains a secret value). */
export type SetupResponse = SetupState & { jobs: { playwright: SetupJob | null } };

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly hint?: string,
  ) {
    super(message);
  }
}

/** Fetches JSON from the local server; the token travels in the HttpOnly cookie. */
export async function api<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { json, ...rest } = init;
  const response = await fetch(path, {
    ...rest,
    credentials: "same-origin",
    headers: { ...(json !== undefined ? { "content-type": "application/json" } : {}), ...(rest.headers ?? {}) },
    body: json !== undefined ? JSON.stringify(json) : rest.body,
  });
  const text = await response.text();
  const body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  if (!response.ok) throw new ApiError(String(body.error ?? response.statusText), response.status, body.hint as string | undefined);
  return body as T;
}

export interface PublicConfig {
  config: {
    model: string;
    testDir: string;
    specsDir: string;
    environments: Record<string, { baseURL: string; allowDestructive: boolean; roles: Record<string, { strategy: string }> }>;
    budgets: { maxUsdPerRun: number; maxTurnsPerAgent: number; maxHealAttempts: number };
    crawl: { maxPages: number; maxDepth: number };
    project?: Record<string, unknown>;
  } & Record<string, unknown>;
  root: string;
  configPath: string;
  envVars: Array<{ name: string; set: boolean }>;
  apiCredential: string | null;
  version: string;
}

export type LoginState =
  | { state: "running"; strategy: string }
  | { state: "waiting_for_user"; strategy: string; message: string }
  | { state: "done"; strategy: string; action: string }
  | { state: "failed"; strategy: string; error: string; hint?: string }
  | null;

export interface RoleStatusResponse {
  env: string;
  role: string;
  strategy: string;
  missingEnvVars: string[];
  session: string;
  badge: string;
  savedAt?: string;
  detail?: string;
  login: LoginState;
}

export interface RunSummary {
  id: string;
  mode: string;
  env: string;
  role: string;
  request?: string;
  status: string;
  createdAt: string;
  costUsd: number;
  live: boolean;
  flows: Array<{ id: string; name: string; status: string }>;
}

export interface DiffResponse {
  files: Array<{ path: string; kind: "added" | "modified"; diff: string }>;
  proposals: Array<{ id: string; path: string; status: string; diff: string }>;
}

export interface PlanFile {
  path: string;
  content: string;
  frontmatter: Record<string, string>;
}

/**
 * Live run state: the run record from the server plus the event stream (replayed from
 * events.jsonl, then live). Reloading the page rebuilds exactly the same view.
 */
export function useRun(runId: string) {
  const [run, setRun] = useState<RunRecord>();
  const [live, setLive] = useState(false);
  const [events, setEvents] = useState<DominionEvent[]>([]);
  const [error, setError] = useState<string>();
  const [connected, setConnected] = useState(false);
  const lastSeq = useRef(0);
  const refetchTimer = useRef<number | undefined>(undefined);

  const refresh = useCallback(async () => {
    try {
      const body = await api<{ run: RunRecord; live: boolean }>(`/api/runs/${runId}`);
      setRun(body.run);
      setLive(body.live);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [runId]);

  useEffect(() => {
    setEvents([]);
    lastSeq.current = 0;
    void refresh();
    let socket: WebSocket | undefined;
    let closed = false;
    let retry: number | undefined;
    const connect = () => {
      const protocol = location.protocol === "https:" ? "wss" : "ws";
      socket = new WebSocket(`${protocol}://${location.host}/api/runs/${runId}/events?after=${lastSeq.current}`);
      socket.onopen = () => setConnected(true);
      socket.onmessage = (message) => {
        const data = JSON.parse(String(message.data)) as DominionEvent | { type: "stream.ready" | "stream.error"; error?: string };
        if (data.type === "stream.error") {
          setError((data as { error?: string }).error);
          return;
        }
        if (data.type === "stream.ready") return;
        const event = data as DominionEvent;
        if (event.seq <= lastSeq.current) return;
        lastSeq.current = event.seq;
        setEvents((prev) => [...prev, event]);
        // Coalesce run.json refreshes while events stream in.
        window.clearTimeout(refetchTimer.current);
        refetchTimer.current = window.setTimeout(() => void refresh(), 150);
      };
      socket.onclose = () => {
        setConnected(false);
        if (!closed) retry = window.setTimeout(connect, 1500);
      };
    };
    connect();
    return () => {
      closed = true;
      window.clearTimeout(retry);
      window.clearTimeout(refetchTimer.current);
      socket?.close();
    };
  }, [runId, refresh]);

  return { run, live, events, error, connected, refresh };
}

/** Polls a GET endpoint (for login state while a person logs in by hand). */
export function usePoll<T>(path: string | undefined, intervalMs: number, enabled: boolean) {
  const [data, setData] = useState<T>();
  useEffect(() => {
    if (!path || !enabled) return;
    let alive = true;
    const tick = async () => {
      try {
        const value = await api<T>(path);
        if (alive) setData(value);
      } catch {
        // keep polling
      }
    };
    void tick();
    const timer = window.setInterval(() => void tick(), intervalMs);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [path, intervalMs, enabled]);
  return data;
}
