/**
 * Stats activity worker. Loaded inside the subprocess spawned by
 * `activity-client.ts` (re-entered through the agent CLI's hidden
 * `__omp_worker_stats_activity` selector). Owns the stats DB handle for the
 * `/usage` heatmap load so the synchronous SQLite work never runs on the TUI
 * thread; the parent SIGKILLs the child once `done` arrives.
 */
import { syncAllSessions } from "@oh-my-pi/omp-stats/aggregator";
import { getDailyActivity } from "@oh-my-pi/omp-stats/db";
import type { StatsActivityTransport, StatsActivityWorkerInbound } from "./activity-protocol";

async function handleLoad(
	transport: StatsActivityTransport,
	message: Extract<StatsActivityWorkerInbound, { type: "load" }>,
): Promise<void> {
	try {
		// Whatever the DB already has paints first; the incremental sync then
		// converges the heatmap on fresh session data.
		transport.send({ type: "activity", id: message.id, points: await getDailyActivity() });
		await syncAllSessions();
		transport.send({ type: "activity", id: message.id, points: await getDailyActivity() });
		transport.send({ type: "done", id: message.id });
	} catch (error) {
		transport.send({
			type: "error",
			id: message.id,
			error: error instanceof Error ? error.message : String(error),
		});
	}
}

export function startStatsActivityWorker(transport: StatsActivityTransport): void {
	transport.onMessage(message => {
		switch (message.type) {
			case "ping":
				transport.send({ type: "pong", id: message.id });
				return;
			case "load":
				void handleLoad(transport, message);
				return;
		}
	});
}
