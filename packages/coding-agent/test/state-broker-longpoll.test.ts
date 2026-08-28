import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { BrokerRouteHandler } from "@oh-my-pi/pi-ai/auth-broker";
import { createStateBrokerRoutes } from "@oh-my-pi/pi-coding-agent/state-broker/server";
import { StateBrokerStore } from "@oh-my-pi/pi-coding-agent/state-broker/store";
import type { StateDeltaResponse } from "@oh-my-pi/pi-coding-agent/state-broker/wire";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

/**
 * White-box coverage for the long-poll GET path's lost-wakeup fix.
 *
 * These drive the *real* store and the *real* route handler in-process — no
 * socket — so the interleave the fix targets can be forced deterministically
 * instead of chased with sleeps. The race is a push landing between the
 * handler's empty `store.delta(...)` read and the subscription that
 * `waitForAdvance` installs; the network integration harness in
 * `state-broker-server.test.ts` cannot pin that window, but a spy on
 * `store.delta` can reproduce it exactly.
 *
 * No timers are needed to sequence these: the handler runs synchronously up to
 * the single `await waitForAdvance(...)`, so its subscription is installed by
 * the time the handler's promise is returned. A push or abort issued after that
 * call always lands on a live subscriber — the outcome is deterministic, not
 * timing-dependent.
 */
describe("state broker long-poll lost-wakeup", () => {
	let tempDir = "";
	let store: StateBrokerStore | undefined;
	let handler: BrokerRouteHandler;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "state-broker-longpoll-"));
		store = StateBrokerStore.open(path.join(tempDir, "state.db"));
		handler = createStateBrokerRoutes(store);
	});

	afterEach(async () => {
		// Restore every spy before closing so a wrapped method cannot outlive the
		// store instance it was patched onto.
		mock.restore();
		store?.close();
		store = undefined;
		await removeWithRetries(tempDir);
	});

	function get(query: string, signal?: AbortSignal): Promise<Response | null> {
		const url = new URL(`http://broker/v1/state/history?${query}`);
		const req = new Request(url.href, signal ? { signal } : undefined);
		return Promise.resolve(handler(req, url, { peer: "test" }));
	}

	async function body(res: Response | null): Promise<StateDeltaResponse> {
		expect(res).not.toBeNull();
		return (await res!.json()) as StateDeltaResponse;
	}

	test("a push landing in the former race window wakes the waiter immediately, not after the window", async () => {
		// Reproduce the exact interleave: the handler's first delta read is empty,
		// and a push lands *before* the subscription is installed. The spy fires
		// the push synchronously inside the empty read, i.e. after the handler has
		// sampled the baseline sequence but before `waitForAdvance` subscribes.
		const realDelta = store!.delta.bind(store!);
		let injected = false;
		spyOn(store!, "delta").mockImplementation((domain, since, limit) => {
			const result = realDelta(domain, since, limit);
			if (!injected && result.entries.length === 0) {
				injected = true;
				store!.push(domain, [{ key: "k", rev: 42, value: "hi" }]);
			}
			return result;
		});

		// A 30s ceiling: pre-fix this parks for the whole window on the wakeup it
		// dropped; post-fix the baseline re-check settles it at once. The await
		// resolving at all — rather than the test itself timing out — is the proof.
		const delta = await body(await get("since=0&wait=30000"));

		expect(delta.entries).toEqual([{ key: "k", rev: 42, value: "hi" }]);
		expect(delta.seq).toBe(1);
	});

	test("an expired window returns an empty delta at the caller's cursor", async () => {
		store!.push("history", [{ key: "k", rev: 1, value: 1 }]);
		// Cursor at the head, no push arrives: the window elapses and the handler
		// returns the (empty) delta at the caller's cursor rather than hanging.
		const delta = await body(await get("since=1&wait=40"));

		expect(delta.entries).toHaveLength(0);
		expect(delta.seq).toBe(1);
	});

	test("an aborted long-poll yields 499", async () => {
		const controller = new AbortController();
		// No data + a long window means the request parks; the handler's abort
		// listener is registered synchronously by the time `get` returns, so
		// aborting now must map to the 499 client-closed status, not an empty 200.
		const pending = get("since=0&wait=30000", controller.signal);
		controller.abort();
		const res = await pending;

		expect(res).not.toBeNull();
		expect(res!.status).toBe(499);
	});

	test("repeated waits leave no subscription behind on any exit path", async () => {
		// Balance check across all three exit paths (changed, expired, aborted):
		// every wait that subscribes must unsubscribe. A leak here is how a
		// long-lived broker accumulates dead resolvers.
		const realSubscribe = store!.subscribe.bind(store!);
		let live = 0;
		spyOn(store!, "subscribe").mockImplementation((domain, cb) => {
			live += 1;
			const unsubscribe = realSubscribe(domain, cb);
			return () => {
				live -= 1;
				unsubscribe();
			};
		});

		// Expired.
		await body(await get("since=0&wait=40"));
		expect(live).toBe(0);

		// Changed: a real concurrent push wakes the parked waiter. The push runs
		// after the subscription is installed, so it always hits a live listener.
		const parked = get("since=0&wait=30000");
		store!.push("history", [{ key: "k", rev: 7, value: "x" }]);
		await body(await parked);
		expect(live).toBe(0);

		// Aborted (cursor ahead of head so the immediate read is empty and it parks).
		const controller = new AbortController();
		const pending = get("since=99&wait=30000", controller.signal);
		controller.abort();
		await pending;
		expect(live).toBe(0);
	});
});
