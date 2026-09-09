import { createResource, createSignal, type ResourceReturn } from "solid-js";

import { ApiError, api } from "./api";
import { POLL_INTERVAL_MS } from "./config";
import type { LogsResponse, StatusResponse } from "./types";

// ──────────────────────────────────────────────────────────────────────────
// The dashboard polls two endpoints in lockstep every 3s. Each component
// reads from these resources directly so re-renders stay narrow.
// ──────────────────────────────────────────────────────────────────────────

const statusFetcher = (): Promise<StatusResponse> => api.status();
const logsFetcher = (): Promise<LogsResponse> => api.logs(400);

const statusTuple: ResourceReturn<StatusResponse> = createResource(statusFetcher);
const logsTuple: ResourceReturn<LogsResponse> = createResource(logsFetcher);

export const statusResource = statusTuple[0];
export const logsResource = logsTuple[0];

const refetchStatus = statusTuple[1].refetch;
const refetchLogs = logsTuple[1].refetch;

const [lastTickAt, setLastTickAt] = createSignal<number>(Date.now());
const [lastTickError, setLastTickError] = createSignal<string | null>(null);
const [isFetching, setIsFetching] = createSignal<boolean>(false);

export { isFetching, lastTickAt, lastTickError };

let pollHandle: number | null = null;

async function tick(): Promise<void> {
  setIsFetching(true);
  try {
    await Promise.all([refetchStatus(), refetchLogs()]);
    setLastTickAt(Date.now());
    setLastTickError(null);
  } catch (err) {
    setLastTickError(err instanceof Error ? err.message : String(err));
  } finally {
    setIsFetching(false);
  }
}

export function startPolling(): void {
  if (pollHandle != null) return;
  void tick();
  pollHandle = window.setInterval(() => {
    void tick();
  }, POLL_INTERVAL_MS);
}

export function stopPolling(): void {
  if (pollHandle != null) {
    window.clearInterval(pollHandle);
    pollHandle = null;
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Trigger + cancel — shared status surface so every entry point (form,
// retry buttons, browse list) feeds the same status line.
// ──────────────────────────────────────────────────────────────────────────

export type TriggerStatusKind = "idle" | "pending" | "ok" | "err";

export interface TriggerStatus {
  kind: TriggerStatusKind;
  text: string;
}

const [triggerStatus, setTriggerStatus] = createSignal<TriggerStatus>({
  kind: "idle",
  text: "",
});

export { triggerStatus };

export interface TriggerInput {
  mode: "triage" | "retry";
  issue?: string;
  delivery_id?: string;
}

export async function runTrigger(input: TriggerInput): Promise<void> {
  setTriggerStatus({ kind: "pending", text: "queuing…" });
  try {
    const data = await api.trigger(input);
    setTriggerStatus({
      kind: "ok",
      text: `queued ${data.mode ?? input.mode}: ${data.delivery}`,
    });
  } catch (err) {
    const detail = err instanceof ApiError ? err.message : String(err);
    const status = err instanceof ApiError ? `error ${err.status}` : "error";
    setTriggerStatus({ kind: "err", text: `${status}: ${detail}` });
  }
  void tick();
}

export async function runCancel(deliveryId: string): Promise<void> {
  setTriggerStatus({ kind: "pending", text: `cancelling ${deliveryId.slice(0, 8)}…` });
  try {
    const data = await api.cancel(deliveryId);
    setTriggerStatus({
      kind: "ok",
      text: `cancel signaled: ${deliveryId.slice(0, 8)} (fired=${data.fired})`,
    });
  } catch (err) {
    const detail = err instanceof ApiError ? err.message : String(err);
    const status = err instanceof ApiError ? `cancel ${err.status}` : "cancel";
    setTriggerStatus({ kind: "err", text: `${status}: ${detail}` });
  }
  void tick();
}
