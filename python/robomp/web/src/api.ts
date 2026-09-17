import { AUTH_HEADERS } from "./config";
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

function authHeaders(): Record<string, string> {
  return { ...AUTH_HEADERS };
}

function jsonHeaders(): Record<string, string> {
  return { "Content-Type": "application/json", ...AUTH_HEADERS };
}

export const api = {
  status(signal?: AbortSignal): Promise<StatusResponse> {
    return fetch("/api/status", { signal }).then(unwrap<StatusResponse>);
  },
  logs(limit = 400, signal?: AbortSignal): Promise<LogsResponse> {
    return fetch(`/api/logs?limit=${limit}`, { signal }).then(unwrap<LogsResponse>);
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
      headers: jsonHeaders(),
      body: JSON.stringify(body),
    }).then(unwrap<TriggerResponse>);
  },
  cancel(deliveryId: string): Promise<CancelResponse> {
    return fetch("/api/cancel", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ delivery_id: deliveryId }),
    }).then(unwrap<CancelResponse>);
  },
};
