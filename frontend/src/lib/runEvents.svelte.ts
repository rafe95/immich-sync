import { eventsUrl, initialConsole, reconnectDelay, reduceEvents, type ConsoleState, type RunEvent, type RunStatus } from "./runs.ts";
import type { api as Api } from "./session.svelte.ts";

export type Connection = "connecting" | "live" | "reconnecting" | "closed";
export type RunEvents = {
  readonly state: ConsoleState;
  readonly connection: Connection;
  readonly loadError: string | null;
  start(): void;
  stop(): void;
};

/**
 * One event stream per run, shared by the console and the diagram. "live" streams /api/runs/:id/events (SSE,
 * resumes after the last event id); "replay" reads the stored log. Stopping never affects the run.
 */
export function createRunEvents(api: Pick<typeof Api, "getRun" | "getRunLog">, runId: string, mode: "live" | "replay", onend?: (status: RunStatus) => void): RunEvents {
  let state = $state<ConsoleState>(initialConsole());
  let connection = $state<Connection>("connecting");
  let loadError = $state<string | null>(null);

  let buffer: RunEvent[] = [];
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  let es: EventSource | null = null;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let attempt = 0;
  let cursor = 0;

  // Events are buffered and applied in one batch so a fast log doesn't re-render per line.
  function push(events: RunEvent[]) {
    buffer.push(...events);
    flushTimer ??= setTimeout(flush, 100);
  }
  function flush() {
    flushTimer = null;
    if (!buffer.length) return;
    state = reduceEvents(state, buffer);
    buffer = [];
  }
  function finish(status: RunStatus) {
    flush();
    connection = "closed";
    state = { ...state, endStatus: status };
    onend?.(status);
  }

  async function replay() {
    try {
      let after = 0;
      for (;;) {
        const page = await api.getRunLog(runId, after);
        if (stopped) return;
        push(page.events);
        if (page.events.length < 1000 || page.nextAfter === null) break;
        after = page.nextAfter;
      }
      flush();
      connection = "closed";
    } catch (e) {
      loadError = e instanceof Error ? e.message : String(e);
      connection = "closed";
    }
  }

  function connect() {
    if (stopped) return;
    es = new EventSource(eventsUrl(runId, cursor), { withCredentials: true });
    es.onopen = () => {
      connection = "live";
      attempt = 0;
    };
    es.onmessage = (m) => {
      try {
        const e = JSON.parse(m.data) as RunEvent;
        cursor = Math.max(cursor, e.id);
        push([e]);
      } catch {
        /* ignore malformed frame */
      }
    };
    es.addEventListener("end", (m) => {
      let status: RunStatus = "completed";
      try {
        status = (JSON.parse((m as MessageEvent).data) as { status: RunStatus }).status;
      } catch {
        /* keep default; the run record is authoritative */
      }
      es?.close();
      stopped = true;
      finish(status);
    });
    es.onerror = () => {
      // The browser would retry on its own, but a closed source or a lost session needs handling here.
      es?.close();
      if (stopped) return;
      connection = "reconnecting";
      // A 401 is detected by asking the API; the client then flips the app to the login screen.
      api.getRun(runId).catch((e) => {
        if (e && (e as { status?: number }).status === 404) {
          loadError = "This run no longer exists.";
          stopped = true;
          connection = "closed";
        }
      });
      retry = setTimeout(connect, reconnectDelay(attempt++));
    };
  }

  return {
    get state() {
      return state;
    },
    get connection() {
      return connection;
    },
    get loadError() {
      return loadError;
    },
    start() {
      stopped = false;
      if (mode === "replay") void replay();
      else connect();
    },
    stop() {
      stopped = true;
      es?.close();
      if (retry) clearTimeout(retry);
      if (flushTimer) clearTimeout(flushTimer);
      flushTimer = null;
    },
  };
}
