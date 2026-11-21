import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it, vi } from "bun:test";
import { StatsLive } from "@oh-my-pi/omp-stats/live";
import type { LiveStatus } from "@oh-my-pi/omp-stats/shared-types";
import { getStatsDbPath } from "@oh-my-pi/pi-utils";
import { installStatsTestIsolation } from "./helpers/temp-agent";

installStatsTestIsolation("@pi-stats-live-external-");

afterEach(() => {
	vi.useRealTimers();
});

/** Run one full sync and resolve with the status emitted when it finishes. */
async function syncOnce(live: StatsLive): Promise<LiveStatus> {
	const { promise, resolve } = Promise.withResolvers<LiveStatus>();
	const before = live.status().sync.lastSyncedAt;
	const unsubscribe = live.subscribe(status => {
		if (status.sync.phase === "idle" && status.sync.lastSyncedAt !== before) resolve(status);
	});
	try {
		live.requestSync();
		return await promise;
	} finally {
		unsubscribe();
	}
}

/** Sync, then fire any pending (throttled) version bump. */
async function syncAndFlush(live: StatsLive): Promise<number> {
	await syncOnce(live);
	vi.advanceTimersByTime(5_000);
	return live.status().version;
}

describe("StatsLive external writes", () => {
	it("bumps the version only when another connection committed since the last sync", async () => {
		vi.useFakeTimers();
		// Distinct lastSyncedAt per sync while the clock is frozen.
		let now = 1_000_000;
		vi.spyOn(Date, "now").mockImplementation(() => (now += 10_000));
		const live = new StatsLive();
		try {
			const baseline = await syncAndFlush(live);

			expect(await syncAndFlush(live)).toBe(baseline);

			const other = new Database(getStatsDbPath());
			other.run("INSERT OR REPLACE INTO meta (key, value) VALUES ('external-writer-probe', '1')");
			other.close();

			expect(await syncAndFlush(live)).toBe(baseline + 1);
			expect(await syncAndFlush(live)).toBe(baseline + 1);
		} finally {
			live.stop();
			vi.restoreAllMocks();
		}
	});
});
