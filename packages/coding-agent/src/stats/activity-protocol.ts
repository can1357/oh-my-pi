/**
 * Wire types between the `/usage` dashboard and the one-shot stats activity
 * subprocess. `bun:sqlite` is synchronous, so the daily-activity aggregate
 * (a scan over every `messages` row in the heatmap window) and the session
 * sync that precedes its refresh run in a child process — on a multi-GB stats
 * database each query stalls the event loop for seconds, which froze the TUI
 * for the whole load when it ran inline. See `activity-client.ts` for the
 * spawn/kill glue.
 */
import type { DailyActivityPoint } from "@oh-my-pi/omp-stats/shared-types";
import type { WorkerLogMessage } from "../subprocess/worker-client";

/** Hidden CLI selector that boots the worker in the spawned subprocess (dispatched in `cli.ts`). */
export const STATS_ACTIVITY_WORKER_ARG = "__omp_worker_stats_activity";

export type StatsActivityWorkerInbound =
	| { type: "ping"; id: string }
	/** Push cached activity, run an incremental session sync, push again, then `done`. */
	| { type: "load"; id: string };

export type StatsActivityWorkerOutbound =
	| { type: "pong"; id: string }
	| { type: "activity"; id: string; points: DailyActivityPoint[] }
	| { type: "done"; id: string }
	| { type: "error"; id: string; error: string }
	| WorkerLogMessage;

export interface StatsActivityTransport {
	send(message: StatsActivityWorkerOutbound): void;
	onMessage(handler: (message: StatsActivityWorkerInbound) => void): () => void;
}
