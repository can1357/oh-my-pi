/**
 * Stats activity worker. Loaded inside the subprocess spawned by
 * `activity-client.ts` (re-entered through the agent CLI's hidden
 * `__omp_worker_stats_activity` selector). Owns the stats DB handle for the
 * `/usage` heatmap load so the synchronous SQLite work never runs on the TUI
 * thread; the parent SIGKILLs the child once `done` arrives.
 */
import { syncAllSessions } from "@oh-my-pi/omp-stats/aggregator";
import { getDailyActivity, readDailyActivity } from "@oh-my-pi/omp-stats/db";
import type { DailyActivityPoint } from "@oh-my-pi/omp-stats/shared-types";
import type { StatsActivityTransport, StatsActivityWorkerInbound } from "./activity-protocol";

/**
 * The stored rows, read through a connection that never writes so another
 * process mid-write cannot hold back or fail the heatmap. Null when nothing is
 * readable yet: a database whose schema predates this build fails the read,
 * and the sync's own open migrates it before the paint that follows.
 */
function readStoredActivity(): DailyActivityPoint[] | null {
	try {
		return readDailyActivity();
	} catch {
		return null;
	}
}

async function handleLoad(
	transport: StatsActivityTransport,
	message: Extract<StatsActivityWorkerInbound, { type: "load" }>,
): Promise<void> {
	try {
		// The stored rows paint first; the incremental sync then converges the
		// heatmap on fresh session data.
		const cached = readStoredActivity();
		if (cached) transport.send({ type: "activity", id: message.id, points: cached });
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
