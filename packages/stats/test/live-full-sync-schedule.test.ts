import { EventEmitter } from "node:events";
import * as fs from "node:fs";
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

	it("restarts the schedule when a requested full sync begins", async () => {
		vi.useFakeTimers();
		const live = new StatsLive();
		let started = 0;
		live.subscribe(status => {
			if (status.sync.phase === "syncing") started++;
		});
		try {
			const initial = nextFullSync(live);
			live.start();
			await initial;

			vi.advanceTimersByTime(4 * 60_000);
			const manual = nextFullSync(live);
			const { promise: running, resolve } = Promise.withResolvers<void>();
			const unsubscribe = live.subscribe(status => {
				if (status.sync.phase === "syncing") resolve();
			});
			live.requestSync();
			await running;
			unsubscribe();
			// The old periodic deadline passes while the requested sync runs.
			vi.advanceTimersByTime(2 * 60_000);
			await manual;
			for (let i = 0; i < 10; i++) await Promise.resolve();
			expect(started).toBe(2);
		} finally {
			live.stop();
		}
	});
});

describe("StatsLive watcher debounce", () => {
	it("syncs pending writes within the max wait while writes keep arriving, whatever the wall clock does", () => {
		vi.useFakeTimers();
		let onChange: ((event: string, filename: string | null) => void) | undefined;
		vi.spyOn(fs, "watch").mockImplementation(((_root: string, _opts: unknown, listener: typeof onChange) => {
			onChange = listener;
			return Object.assign(new EventEmitter(), { close() {} });
		}) as unknown as typeof fs.watch);
		// A clock stepping backwards must not stretch the cap.
		let now = 10_000_000;
		vi.spyOn(Date, "now").mockImplementation(() => (now -= 1_000));
		const live = new StatsLive();
		const requested: (readonly string[] | undefined)[] = [];
		vi.spyOn(live, "requestSync").mockImplementation(files => {
			requested.push(files);
		});
		try {
			live.start();
			for (let elapsed = 0; elapsed < 5_000; elapsed += 500) {
				onChange?.("change", "--tmp--/session.jsonl");
				vi.advanceTimersByTime(500);
			}
			expect(requested.filter(files => files !== undefined)).toHaveLength(1);
		} finally {
			live.stop();
			vi.restoreAllMocks();
		}
	});
});
