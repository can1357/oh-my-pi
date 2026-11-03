import { describe, expect, it } from "bun:test";
import { PeerCleanups, trackWorkerSubscription } from "../../src/thread/services/support";

/** A listener-holding `off` that is only reachable through the returned WeakRef and `track`'s result. */
function subscribe(track: (off: () => void) => () => void): { unsubscribe: () => void; listener: WeakRef<object> } {
	const listener = { onEvent: () => {} };
	const calls: unknown[] = [];
	const unsubscribe = track(() => calls.push(listener));
	return { unsubscribe, listener: new WeakRef(listener) };
}

describe("worker subscriptions on main", () => {
	it("forget their listener once unsubscribed, though the worker still holds the unsubscribe", () => {
		const subscriptions = new Set<() => void>();
		const tracked = subscribe(off => trackWorkerSubscription(subscriptions, off));
		Bun.gc(true);
		expect(tracked.listener.deref()).toBeDefined();
		tracked.unsubscribe();
		expect(subscriptions.size).toBe(0);
		Bun.gc(true);
		// A held unsubscribe that kept its listener would pin the worker's listener scope through the link.
		expect(tracked.listener.deref()).toBeUndefined();
	});

	it("do the same through PeerCleanups, and run each cleanup once", () => {
		const cleanups = new PeerCleanups("test");
		let runs = 0;
		const tracked = subscribe(off =>
			cleanups.track("w1", () => {
				runs++;
				off();
			}),
		);
		tracked.unsubscribe();
		tracked.unsubscribe();
		cleanups.release("w1");
		expect(runs).toBe(1);
		Bun.gc(true);
		expect(tracked.listener.deref()).toBeUndefined();
	});
});
