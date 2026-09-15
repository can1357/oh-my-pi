import { authHeaders, CONFIG, saveReplayToken, storedReplayToken } from "./config";
import type {
  BrowseResponse,
  CancelResponse,
  LogsResponse,
  StatusResponse,
  TriggerResponse,
} from "./types";

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = "ApiError";
  }
}

function extractDetail(body: unknown): string | null {
  if (body == null || typeof body !== "object") return null;
  const detail = (body as Record<string, unknown>).detail;
  if (typeof detail === "string") return detail;
  const message = (body as Record<string, unknown>).message;
  if (typeof message === "string") return message;
  return null;
}

async function unwrap<T>(resp: Response): Promise<T> {
  let body: unknown = null;
  try {
    body = await resp.json();
  } catch {
    // Endpoint returned non-JSON. For 2xx that's still valid for callers that
    // expect an empty body; we only surface the parse failure on errors.
  }
  if (!resp.ok) {
    const detail = extractDetail(body) ?? resp.statusText ?? `HTTP ${resp.status}`;
    throw new ApiError(resp.status, detail);
  }
  return body as T;
}

// ──────────────────────────────────────────────────────────────────────────
// Boot-time auth. The token never ships in the page HTML; when the server
// has replay auth on, the operator types the token once, we verify it
// against the token-gated `/api/config`, and sessionStorage keeps it for
// the tab. On a 401 we prompt once more, then give up — subsequent
// requests fail with the server's 401 and the UI shows the error.
// ──────────────────────────────────────────────────────────────────────────

interface ReplayConfig {
  replayEnabled: boolean;
  replayToken: string;
}

async function fetchReplayConfig(token: string): Promise<ReplayConfig | null> {
  try {
    const resp = await fetch("/api/config", {
      headers: { "X-Robomp-Replay-Token": token },
    });
    if (!resp.ok) return null;
    return (await resp.json()) as ReplayConfig;
  } catch {
    return null;
  }
}

/** Resolve and store the replay token before the first authenticated poll. */
export async function ensureReplayToken(): Promise<void> {
  if (!CONFIG.replayEnabled || storedReplayToken() !== null) return;

  let token = window.prompt("robomp replay token:") ?? "";
  if (!token) return;
  let body = await fetchReplayConfig(token);
  if (body === null) {
    token = window.prompt("robomp replay token (rejected — try again):") ?? "";
    if (!token) return;
    body = await fetchReplayConfig(token);
  }
  if (body?.replayToken) saveReplayToken(body.replayToken);
}

export const api = {
  status(signal?: AbortSignal): Promise<StatusResponse> {
    return fetch("/api/status", { headers: authHeaders(), signal }).then(unwrap<StatusResponse>);
  },
  logs(limit = 400, signal?: AbortSignal): Promise<LogsResponse> {
    return fetch(`/api/logs?limit=${limit}`, { headers: authHeaders(), signal }).then(unwrap<LogsResponse>);
  },
  browse(state: string, refresh = false, signal?: AbortSignal): Promise<BrowseResponse> {
    const qs = new URLSearchParams({ state, limit: "50" });
    if (refresh) qs.set("refresh", "1");
    return fetch(`/api/github/issues?${qs.toString()}`, {
      headers: authHeaders(),
      signal,
    }).then(unwrap<BrowseResponse>);
  },
  trigger(body: {
    mode: "triage" | "retry";
    issue?: string;
    delivery_id?: string;
  }): Promise<TriggerResponse> {
    return fetch("/api/trigger", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify(body),
    }).then(unwrap<TriggerResponse>);
  },
  cancel(deliveryId: string): Promise<CancelResponse> {
    return fetch("/api/cancel", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ delivery_id: deliveryId }),
    }).then(unwrap<CancelResponse>);
  },
};
