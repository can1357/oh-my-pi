import { describe, expect, it } from "bun:test";
import { AttachmentGuard } from "../../src/tools/browser/relay/attachment-guard";

/** Deterministic timer harness: one pending timer, fired on demand. */
class FakeTimers {
	#next = 1;
	readonly #pending = new Map<number, { fn: () => void; ms: number }>();

	set(fn: () => void, ms: number): number {
		const handle = this.#next++;
		this.#pending.set(handle, { fn, ms });
		return handle;
	}

	clear(handle: number): void {
		this.#pending.delete(handle);
	}

	get pendingCount(): number {
		return this.#pending.size;
	}

	/** Fire every currently-scheduled timer (each fires at most once). */
	flush(): void {
		const due = [...this.#pending.values()];
		this.#pending.clear();
		for (const { fn } of due) fn();
	}
}

function makeGuard(graceMs = 5_000) {
	const timers = new FakeTimers();
	const detached: number[][] = [];
	const guard = new AttachmentGuard<number>({
		graceMs,
		setTimer: (fn, ms) => timers.set(fn, ms),
		clearTimer: handle => timers.clear(handle),
		detachAll: tabIds => detached.push(tabIds),
	});
	return { guard, timers, detached };
}

describe("AttachmentGuard", () => {
	it("detaches orphaned tabs after the grace period when the relay stays down", () => {
		const { guard, timers, detached } = makeGuard();
		guard.track(11);
		guard.track(22);

		guard.onDisconnected();
		expect(timers.pendingCount).toBe(1);
		expect(detached).toEqual([]);

		timers.flush();
		expect(detached).toEqual([[11, 22]]);
		expect(guard.attachedTabIds()).toEqual([]);
	});

	it("cancels the sweep when the relay reconnects within the grace period", () => {
		const { guard, timers, detached } = makeGuard();
		guard.track(7);

		guard.onDisconnected();
		expect(timers.pendingCount).toBe(1);

		guard.onConnected();
		expect(timers.pendingCount).toBe(0);

		timers.flush();
		expect(detached).toEqual([]);
		expect(guard.attachedTabIds()).toEqual([7]);
	});

	it("does not arm a sweep when nothing is attached", () => {
		const { guard, timers, detached } = makeGuard();
		guard.onDisconnected();
		expect(timers.pendingCount).toBe(0);
		expect(detached).toEqual([]);
	});

	it("does not stack multiple pending sweeps across repeated disconnects", () => {
		const { guard, timers, detached } = makeGuard();
		guard.track(1);
		guard.onDisconnected();
		guard.onDisconnected();
		expect(timers.pendingCount).toBe(1);

		timers.flush();
		expect(detached).toEqual([[1]]);
	});

	it("arms a sweep when a new attachment appears after the relay already disconnected", () => {
		const { guard, timers, detached } = makeGuard();
		guard.onDisconnected();
		expect(timers.pendingCount).toBe(0);

		guard.track(5);
		expect(timers.pendingCount).toBe(1);

		timers.flush();
		expect(detached).toEqual([[5]]);
		expect(guard.attachedTabIds()).toEqual([]);
	});

	it("stops tracking a tab that was explicitly detached before the sweep", () => {
		const { guard, timers, detached } = makeGuard();
		guard.track(3);
		guard.track(4);
		guard.untrack(3);

		guard.onDisconnected();
		timers.flush();
		expect(detached).toEqual([[4]]);
	});

	it("detaches immediately on suspend and cancels any pending sweep", () => {
		const { guard, timers, detached } = makeGuard();
		guard.track(9);
		guard.onDisconnected();
		expect(timers.pendingCount).toBe(1);

		guard.onSuspend();
		expect(timers.pendingCount).toBe(0);
		expect(detached).toEqual([[9]]);

		// A late-firing stale timer must not double-detach.
		timers.flush();
		expect(detached).toEqual([[9]]);
	});

	it("cancels a pending sweep when the last tracked attachment disappears", () => {
		const { guard, timers, detached } = makeGuard();
		guard.track(12);
		guard.onDisconnected();
		expect(timers.pendingCount).toBe(1);

		guard.untrack(12);
		expect(timers.pendingCount).toBe(0);

		timers.flush();
		expect(detached).toEqual([]);
	});

	it("suspend with nothing attached is a no-op", () => {
		const { guard, detached } = makeGuard();
		guard.onSuspend();
		expect(detached).toEqual([]);
	});
});
