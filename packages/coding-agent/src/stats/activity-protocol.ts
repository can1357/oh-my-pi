/**
 * Wire types between the `/usage` dashboard and the one-shot stats activity
 * worker thread. `bun:sqlite` is synchronous, so the daily-activity aggregate
 * (a scan over every `messages` row in the heatmap window) and the session
 * sync that precedes its refresh run on a Bun `Worker` — on a multi-GB stats
 * database each query stalls the event loop for seconds, which froze the TUI
 * for the whole load when it ran inline. See `activity-client.ts` for the
 * spawn/terminate glue.
 */
import type { DailyActivityPoint } from "@oh-my-pi/omp-stats/shared-types";

export { STATS_ACTIVITY_WORKER_ARG } from "../cli/worker-selectors";

/** Push cached activity, run an incremental session sync, push again, then `done`. */
export type StatsActivityWorkerInbound = { type: "load"; id: string };

export type StatsActivityWorkerLog = {
	type: "log";
	level: "debug" | "warn" | "error";
	msg: string;
	meta?: Record<string, unknown>;
};

export type StatsActivityWorkerOutbound =
	| { type: "activity"; id: string; points: DailyActivityPoint[] }
	| { type: "done"; id: string }
	| { type: "error"; id: string; error: string }
	| StatsActivityWorkerLog;
