/**
 * Stats activity worker thread. Spawned by `activity-client.ts` as a Bun
 * `Worker` (re-entered through the agent CLI's hidden
 * `__omp_worker_stats_activity` selector, or loaded directly outside a CLI
 * host). Owns the stats DB handle for the `/usage` heatmap load so the
 * synchronous SQLite work never runs on the TUI thread; the parent terminates
 * the worker once `done` arrives.
 */
import { parentPort } from "node:worker_threads";
import { syncAllSessions } from "@oh-my-pi/omp-stats/aggregator";
import { getDailyActivity, readDailyActivity } from "@oh-my-pi/omp-stats/db";
import type { DailyActivityPoint } from "@oh-my-pi/omp-stats/shared-types";
import { consumeWorkerInbox } from "@oh-my-pi/pi-utils/worker-host";
import type { StatsActivityWorkerInbound, StatsActivityWorkerOutbound } from "./activity-protocol";

if (!parentPort) throw new Error("stats activity worker: missing parentPort");

const port = parentPort;

function send(message: StatsActivityWorkerOutbound): void {
	port.postMessage(message);
}

/**
 * The stored rows, read through a connection that never writes so another
 * process mid-write cannot hold back or fail the heatmap. Null when nothing is
 * readable yet (no database, or a read that fails on a schema this build does
 * not know); the sync's own open migrates it before the paint that follows.
 */
function readStoredActivity(): DailyActivityPoint[] | null {
	try {
		return readDailyActivity();
	} catch (error) {
		send({
			type: "log",
			level: "debug",
			msg: "stats activity cached paint skipped",
			meta: { error: error instanceof Error ? error.message : String(error) },
		});
		return null;
	}
}

async function handleLoad(id: string): Promise<void> {
	try {
		// The stored rows paint first; the incremental sync then converges the
		// heatmap on fresh session data.
		const cached = readStoredActivity();
		if (cached) send({ type: "activity", id, points: cached });
		await syncAllSessions();
		send({ type: "activity", id, points: await getDailyActivity() });
		send({ type: "done", id });
	} catch (error) {
		send({ type: "error", id, error: error instanceof Error ? error.message : String(error) });
	}
}

function handle(data: unknown): void {
	const message = data as StatsActivityWorkerInbound;
	switch (message.type) {
		case "ping":
			send({ type: "pong", id: message.id });
			return;
		case "load":
			void handleLoad(message.id);
			return;
	}
}

const inbox = consumeWorkerInbox();
if (inbox) inbox.bind(handle);
else port.on("message", handle);
