import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getRecentRequests, initDb } from "@oh-my-pi/omp-stats/db";
import { StatsLive } from "@oh-my-pi/omp-stats/live";
import type { LiveStatus } from "@oh-my-pi/omp-stats/shared-types";
import { getSessionsDir } from "@oh-my-pi/pi-utils";
import { installStatsTestIsolation } from "./helpers/temp-agent";

installStatsTestIsolation("@pi-stats-live-watcher-");

function transcript(): string {
	const header = { type: "session", version: 3, id: "01a1dc40-0000-7000-8000-000000000002", cwd: "/tmp" };
	const message = {
		type: "message",
		id: "a1",
		timestamp: "2026-11-26T00:00:00Z",
		message: {
			role: "assistant",
			content: [{ type: "text", text: "ok" }],
			api: "openai-responses",
			provider: "openai",
			model: "gpt-5.4",
			stopReason: "stop",
			timestamp: 0,
			usage: {
				input: 10,
				output: 5,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 15,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		},
	};
	return `${JSON.stringify(header)}\n${JSON.stringify(message)}\n`;
}

/** Resolve on the next sync that finishes, full or targeted. */
function nextSync(live: StatsLive): Promise<LiveStatus> {
	const before = live.status().sync.lastSyncedAt;
	const { promise, resolve } = Promise.withResolvers<LiveStatus>();
	const unsubscribe = live.subscribe(status => {
		if (status.sync.phase === "idle" && status.sync.lastSyncedAt !== before) {
			unsubscribe();
			resolve(status);
		}
	});
	return promise;
}

describe("StatsLive session watcher", () => {
	// Only Linux's recursive watcher reports the denied subtree as an error; root reads every directory anyway.
	it.skipIf(process.platform !== "linux" || process.getuid?.() === 0)(
		"syncs a written transcript while another sessions directory is unreadable",
		async () => {
			const locked = path.join(getSessionsDir(), "-root-only");
			await fs.mkdir(locked, { recursive: true });
			await fs.chmod(locked, 0o000);
			const live = new StatsLive();
			try {
				const initial = nextSync(live);
				live.start();
				await initial;

				const targeted = nextSync(live);
				await Bun.write(path.join(getSessionsDir(), "--tmp--", "session.jsonl"), transcript());
				await targeted;
				await initDb();
				expect(getRecentRequests(10).map(request => request.model)).toEqual(["gpt-5.4"]);
			} finally {
				live.stop();
				await fs.chmod(locked, 0o755);
			}
		},
		30_000,
	);
});
