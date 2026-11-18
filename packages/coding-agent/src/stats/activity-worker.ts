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
import { getDailyActivity } from "@oh-my-pi/omp-stats/db";
import { consumeWorkerInbox } from "@oh-my-pi/pi-utils/worker-host";
import type { StatsActivityWorkerInbound, StatsActivityWorkerOutbound } from "./activity-protocol";

if (!parentPort) throw new Error("stats activity worker: missing parentPort");

const port = parentPort;

function send(message: StatsActivityWorkerOutbound): void {
	port.postMessage(message);
}

async function handleLoad(id: string): Promise<void> {
	try {
		// Whatever the DB already has paints first; the incremental sync then
		// converges the heatmap on fresh session data.
		send({ type: "activity", id, points: await getDailyActivity() });
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
