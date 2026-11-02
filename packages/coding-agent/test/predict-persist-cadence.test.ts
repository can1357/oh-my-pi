import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { PersistCadence } from "../src/predict/daemon";

const DEBOUNCE_MS = 5 * 60_000;
const MAX_DIRTY_MS = 15 * 60_000;

describe("text-predict persist cadence", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("persists at most once per debounce window while typing", () => {
		const flush = vi.fn();
		const cadence = new PersistCadence(DEBOUNCE_MS, MAX_DIRTY_MS, flush);
		// Feedback/sync every 5 s for 10 minutes: the old 30 s cadence wrote ~20 snapshots.
		for (let elapsed = 0; elapsed < 10 * 60_000; elapsed += 5_000) {
			cadence.touch();
			vi.advanceTimersByTime(5_000);
		}
		expect(flush).not.toHaveBeenCalled();
		vi.advanceTimersByTime(DEBOUNCE_MS);
		expect(flush).toHaveBeenCalledTimes(1);
	});

	it("caps how long a continuous stream of changes stays unpersisted", () => {
		const flush = vi.fn();
		const cadence = new PersistCadence(DEBOUNCE_MS, MAX_DIRTY_MS, flush);
		const flushedAt: number[] = [];
		flush.mockImplementation(() => flushedAt.push(Date.now()));
		const start = Date.now();
		for (let elapsed = 0; elapsed < 40 * 60_000; elapsed += 10_000) {
			cadence.touch();
			vi.advanceTimersByTime(10_000);
		}
		expect(flushedAt.map(at => at - start)).toEqual([MAX_DIRTY_MS, 2 * MAX_DIRTY_MS]);
		for (let i = 1; i < flushedAt.length; i++) {
			expect(flushedAt[i]! - flushedAt[i - 1]!).toBeGreaterThanOrEqual(DEBOUNCE_MS);
		}
	});

	it("drops the pending flush on cancel so stop can persist synchronously", () => {
		const flush = vi.fn();
		const cadence = new PersistCadence(DEBOUNCE_MS, MAX_DIRTY_MS, flush);
		cadence.touch();
		cadence.cancel();
		vi.advanceTimersByTime(MAX_DIRTY_MS);
		expect(flush).not.toHaveBeenCalled();
	});
});
