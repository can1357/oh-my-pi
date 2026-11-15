import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { closeDb, initDb, insertMessageStats } from "@oh-my-pi/omp-stats/db";
import type { MessageStats } from "@oh-my-pi/omp-stats/types";
import { getStatsDbPath } from "@oh-my-pi/pi-utils";
import { installStatsTestIsolation } from "../../stats/test/helpers/temp-agent";
import type { StatsActivityWorkerInbound, StatsActivityWorkerOutbound } from "../src/stats/activity-protocol";
import { startStatsActivityWorker } from "../src/stats/activity-worker";

installStatsTestIsolation("@omp-stats-activity-lock-");

function request(timestamp: number): MessageStats {
	return {
		sessionFile: "/tmp/activity-lock.jsonl",
		entryId: "activity-lock",
		folder: "/work/a",
		model: "model-x",
		provider: "prov",
		api: "openai-responses",
		timestamp,
		duration: 2000,
		ttft: 300,
		stopReason: "stop",
		errorMessage: null,
		usage: {
			input: 100,
			output: 40,
			cacheRead: 60,
			cacheWrite: 0,
			totalTokens: 200,
			cost: { input: 0.01, output: 0.02, cacheRead: 0.001, cacheWrite: 0, total: 0.031 },
		},
		agentType: "main",
	};
}

describe("/usage activity load", () => {
	it("paints the stored history while another process holds the write lock", async () => {
		await initDb();
		insertMessageStats([request(Date.now() - 60 * 60_000)]);
		// The worker runs in a fresh process: no connection of its own is open yet.
		closeDb();
		const writer = new Database(getStatsDbPath());
		writer.run("BEGIN IMMEDIATE");
		writer.run("INSERT OR REPLACE INTO meta (key, value) VALUES ('activity-lock-test', 'held')");
		try {
			let receive: ((message: StatsActivityWorkerInbound) => void) | undefined;
			const events: StatsActivityWorkerOutbound[] = [];
			const settled = Promise.withResolvers<void>();
			startStatsActivityWorker({
				onMessage(handler) {
					receive = handler;
					return () => {};
				},
				send(message) {
					events.push(message);
					if (message.type === "done" || message.type === "error") settled.resolve();
				},
			});
			receive!({ type: "load", id: "load" });
			await settled.promise;

			const first = events[0];
			expect(first?.type).toBe("activity");
			const points = first?.type === "activity" ? first.points : [];
			expect(points.reduce((sum, point) => sum + point.requests, 0)).toBe(1);
			// The sync behind the paint cannot write while the lock is held; the
			// dashboard keeps the painted rows and marks them stale.
			expect(events.at(-1)).toMatchObject({ type: "error", error: expect.stringContaining("locked") });
		} finally {
			writer.run("ROLLBACK");
			writer.close();
		}
	}, 30_000);
});
