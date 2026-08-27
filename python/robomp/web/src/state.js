import { createResource, createSignal } from "solid-js";
import { ApiError, api } from "./api";
import { POLL_INTERVAL_MS } from "./config";
// ──────────────────────────────────────────────────────────────────────────
// The dashboard polls two endpoints in lockstep every 3s. Each component
// reads from these resources directly so re-renders stay narrow.
// ──────────────────────────────────────────────────────────────────────────
const statusFetcher = () => api.status();
const logsFetcher = () => api.logs(400);
const statusTuple = createResource(statusFetcher);
const logsTuple = createResource(logsFetcher);
export const statusResource = statusTuple[0];
export const logsResource = logsTuple[0];
const refetchStatus = statusTuple[1].refetch;
const refetchLogs = logsTuple[1].refetch;
const [lastTickAt, setLastTickAt] = createSignal(Date.now());
const [lastTickError, setLastTickError] = createSignal(null);
const [isFetching, setIsFetching] = createSignal(false);
export { isFetching, lastTickAt, lastTickError };
let pollHandle = null;
async function tick() {
    setIsFetching(true);
    try {
        await Promise.all([refetchStatus(), refetchLogs()]);
        setLastTickAt(Date.now());
        setLastTickError(null);
    }
    catch (err) {
        setLastTickError(err instanceof Error ? err.message : String(err));
    }
    finally {
        setIsFetching(false);
    }
}
export function startPolling() {
    if (pollHandle != null)
        return;
    void tick();
    pollHandle = window.setInterval(() => {
        void tick();
    }, POLL_INTERVAL_MS);
}
export function stopPolling() {
    if (pollHandle != null) {
        window.clearInterval(pollHandle);
        pollHandle = null;
    }
}
const [triggerStatus, setTriggerStatus] = createSignal({
    kind: "idle",
    text: "",
});
export { triggerStatus };
export async function runTrigger(input) {
    setTriggerStatus({ kind: "pending", text: "queuing…" });
    try {
        const data = await api.trigger(input);
        setTriggerStatus({
            kind: "ok",
            text: `queued ${data.mode ?? input.mode}: ${data.delivery}`,
        });
    }
    catch (err) {
        const detail = err instanceof ApiError ? err.message : String(err);
        const status = err instanceof ApiError ? `error ${err.status}` : "error";
        setTriggerStatus({ kind: "err", text: `${status}: ${detail}` });
    }
    void tick();
}
export async function runCancel(deliveryId) {
    setTriggerStatus({ kind: "pending", text: `cancelling ${deliveryId.slice(0, 8)}…` });
    try {
        const data = await api.cancel(deliveryId);
        setTriggerStatus({
            kind: "ok",
            text: `cancel signaled: ${deliveryId.slice(0, 8)} (fired=${data.fired})`,
        });
    }
    catch (err) {
        const detail = err instanceof ApiError ? err.message : String(err);
        const status = err instanceof ApiError ? `cancel ${err.status}` : "cancel";
        setTriggerStatus({ kind: "err", text: `${status}: ${detail}` });
    }
    void tick();
}
