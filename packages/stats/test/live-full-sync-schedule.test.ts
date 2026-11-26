import { afterEach, describe, expect, it, vi } from "bun:test";
import { StatsLive } from "@oh-my-pi/omp-stats/live";
import type { LiveStatus } from "@oh-my-pi/omp-stats/shared-types";
import { installStatsTestIsolation } from "./helpers/temp-agent";

installStatsTestIsolation("@pi-stats-live-schedule-");

afterEach(() => {
	vi.useRealTimers();
});

/** Resolve on the next full sync that finishes. */
function nextFullSync(live: StatsLive): Promise<LiveStatus> {
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

describe("StatsLive full sync schedule", () => {
	it("spaces full syncs from the end of the previous one", async () => {
		vi.useFakeTimers();
		let now = 1_000_000;
		vi.spyOn(Date, "now").mockImplementation(() => (now += 1_000));
		const live = new StatsLive();
		let started = 0;
		live.subscribe(status => {
			if (status.sync.phase === "syncing") started++;
		});
		try {
			const initial = nextFullSync(live);
			live.start();
			// The initial sync outlasts the interval: the next one must still wait a full interval after it ends.
			vi.advanceTimersByTime(5 * 60_000);
			await initial;
			// Let the drain loop pick up anything queued while the initial sync ran.
			for (let i = 0; i < 10; i++) await Promise.resolve();
			expect(started).toBe(1);

			const periodic = nextFullSync(live);
			vi.advanceTimersByTime(5 * 60_000);
			await periodic;
			expect(started).toBe(2);
		} finally {
			live.stop();
			vi.restoreAllMocks();
		}
	});
});
