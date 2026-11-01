/**
 * A dispatch hold's synchronous probe (`DispatchHold.isClosed`) is what makes
 * the transport's holds a barrier. Awaiting a hold proves only that it was
 * open when it answered; in single-threaded JavaScript a gate can still close
 * in any microtask between that answer and the send. These tests close a
 * probed gate at each of those positions in turn and check that the request
 * never reaches the wire while a probe reads closed. The request's own
 * cancellation can land in the same positions, and the cancellation tests
 * check that a cancelled request never reaches the wire either.
 */
import { describe, expect, test } from "bun:test";
import type { Api, DispatchHold, FetchImpl, Model, TransportWrapper } from "@oh-my-pi/pi-ai/types";
import { dispatchWhenOpen, holdBeforeDispatch } from "@oh-my-pi/pi-ai/utils/dispatch-hold";
import { transportFetch, withoutDispatchHold } from "@oh-my-pi/pi-ai/utils/transport-fetch";

const ENDPOINT = "https://example.invalid/v1/messages";

/** Deep enough to reach past every microtask between a hold's answer and the send. */
const MAX_DEPTH = 24;

function model(): Model<Api> {
	return {
		id: "probe-model",
		name: "Probe Model",
		api: "dispatch-hold-probe-test" as Api,
		provider: "probe-provider",
		contextWindow: 1000,
		maxTokens: 100,
	} as Model<Api>;
}

/** One turn of the event loop: long enough for a held request to show it parked. */
function loopTurn(): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setImmediate(resolve);
	return promise;
}

/** Whether `pending` settled within one turn of the event loop. */
async function heldForATurn(pending: Promise<unknown>): Promise<boolean> {
	const outcome = await Promise.race([
		pending.then(
			() => "settled",
			() => "settled",
		),
		loopTurn().then(() => "held"),
	]);
	return outcome === "held";
}

/** Runs `fn` `depth` microtasks from now. */
function afterMicrotasks(depth: number, fn: () => void): void {
	queueMicrotask(() => (depth <= 1 ? fn() : afterMicrotasks(depth - 1, fn)));
}

/**
 * A gate with a probe, as `/pause` builds one: open, its hold answers at once;
 * closed, it parks until reopened, and its probe says so.
 */
function probedGate() {
	let closed = false;
	let reopened = Promise.withResolvers<void>();
	const hold: DispatchHold = () => (closed ? reopened.promise : undefined);
	hold.isClosed = () => closed;
	return {
		hold,
		get closed() {
			return closed;
		},
		close() {
			if (closed) return;
			closed = true;
			reopened = Promise.withResolvers<void>();
		},
		open() {
			closed = false;
			reopened.resolve();
		},
	};
}

describe("dispatch hold probe", () => {
	// The holds were awaited and the request sent a few microtasks later, so a
	// gate that closed in between was never seen: nothing re-read it.
	test("never sends while a probed gate reads closed, wherever after its answer it closes", async () => {
		const sentWhileClosed: number[] = [];
		const heldAt: number[] = [];
		for (let depth = 1; depth <= MAX_DEPTH; depth++) {
			const gate = probedGate();
			let armed = true;
			const hold: DispatchHold = () => {
				if (armed) {
					armed = false;
					afterMicrotasks(depth, () => gate.close());
				}
				return gate.hold();
			};
			hold.isClosed = gate.hold.isClosed;
			const base = (async () => {
				if (gate.closed) sentWhileClosed.push(depth);
				return new Response("{}", { status: 200 });
			}) satisfies FetchImpl;

			const sent = transportFetch(model(), base, hold)(ENDPOINT, { method: "POST" });
			if (await heldForATurn(sent)) {
				heldAt.push(depth);
				gate.open();
			}
			await sent;
		}

		expect(sentWhileClosed).toEqual([]);
		// Not vacuous: some depth closed the gate before the send and was held.
		expect(heldAt.length).toBeGreaterThan(0);
	});

	// With two wrapped layers, a later hold that answered asynchronously was
	// asked once more to confirm, and the gate closing during that confirming
	// answer still sent: the pass had already been accepted.
	test("re-reads an earlier probed gate at the send, whichever answer of a later hold it closes during", async () => {
		const sentWhileClosed: number[] = [];
		const heldAt: number[] = [];
		for (const closeOnCall of [1, 2, 3]) {
			const gate = probedGate();
			let calls = 0;
			const base = (async () => {
				if (gate.closed) sentWhileClosed.push(closeOnCall);
				return new Response("{}", { status: 200 });
			}) satisfies FetchImpl;
			const later = async () => {
				calls += 1;
				await Promise.resolve();
				if (calls === closeOnCall) gate.close();
			};
			const passThrough: TransportWrapper = inner => inner;
			const first = transportFetch(model(), base, gate.hold, passThrough);
			const fetch = transportFetch(model(), first, later, inner => inner);

			const sent = fetch(ENDPOINT, { method: "POST" });
			if (await heldForATurn(sent)) {
				heldAt.push(closeOnCall);
				gate.open();
			}
			await sent;
		}

		expect(sentWhileClosed).toEqual([]);
		expect(heldAt).toContain(1);
	});

	// A hold joined to a live transport after the pass that asked the others
	// was never awaited: the request went out past it.
	test("awaits a hold that joins a live transport at any microtask before the send", async () => {
		const skipped: number[] = [];
		let joinedBeforeSend = 0;
		for (let depth = 1; depth <= MAX_DEPTH; depth++) {
			const events: string[] = [];
			const base = (async () => {
				events.push("request");
				return new Response("{}", { status: 200 });
			}) satisfies FetchImpl;
			let armed = true;
			// Asked only once `live` exists: the hold runs when the request does.
			const first: DispatchHold = () => {
				if (!armed) return;
				armed = false;
				afterMicrotasks(depth, () => {
					events.push("joined");
					transportFetch(model(), live, () => {
						events.push("late");
					});
				});
			};
			const live = transportFetch(model(), base, first, inner => inner);

			await live(ENDPOINT, { method: "POST" });
			await loopTurn();

			const joined = events.indexOf("joined");
			const request = events.indexOf("request");
			if (joined === -1 || joined > request) continue;
			joinedBeforeSend += 1;
			const late = events.indexOf("late");
			if (late === -1 || late > request) skipped.push(depth);
		}

		expect(skipped).toEqual([]);
		expect(joinedBeforeSend).toBeGreaterThan(0);
	});

	// A site that awaits the hold itself (a websocket send, a stream request)
	// got control back after the hold's answer even when its gate had closed
	// again by the time the await resumed.
	test("holdBeforeDispatch does not return while a probed hold reads closed", async () => {
		const gate = probedGate();
		let asked = 0;
		const hold: DispatchHold = () => {
			asked += 1;
			if (asked > 1) return gate.hold();
			const answered = Promise.resolve();
			void answered.then(() => gate.close());
			return answered;
		};
		hold.isClosed = gate.hold.isClosed;

		const done = holdBeforeDispatch(hold);
		expect(await heldForATurn(done)).toBe(true);
		gate.open();
		await done;
		expect(asked).toBe(2);
	});

	// A probe-carrying hold before a later one that parks needs no re-asking:
	// its probe is read at the send. Only a plain function's answer can go
	// stale unseen.
	test("asks a probed hold once when a later hold parks behind it", async () => {
		const calls: string[] = [];
		const gate = probedGate();
		const first: DispatchHold = () => {
			calls.push("first");
			return gate.hold();
		};
		first.isClosed = gate.hold.isClosed;
		const base = (async () => {
			calls.push("request");
			return new Response("{}", { status: 200 });
		}) satisfies FetchImpl;
		const fetch = transportFetch(model(), transportFetch(model(), base, first), async () => {
			calls.push("second");
			await loopTurn();
		});

		await fetch(ENDPOINT, { method: "POST" });

		expect(calls).toEqual(["first", "second", "request"]);
	});
});

/** One request's barrier: its holds, and the preparation it redoes after each wait. */
interface Barrier {
	holds: DispatchHold | readonly DispatchHold[] | undefined;
	prepare?: () => Promise<void>;
}

/** Every shape of barrier a cancellation has to end, each built fresh for one request. */
const BARRIERS: Record<string, () => Barrier> = {
	"no hold": () => ({ holds: undefined }),
	"an empty hold list": () => ({ holds: [] }),
	"one probed hold": () => ({ holds: probedGate().hold }),
	"two probed holds": () => ({ holds: [probedGate().hold, probedGate().hold] }),
	"a hold without a probe": () => ({ holds: () => {} }),
	"a hold that answers late": () => ({
		holds: async () => {
			await Promise.resolve();
		},
	}),
	"a probed hold and a preparation": () => ({
		holds: probedGate().hold,
		prepare: async () => {
			await Promise.resolve();
			await Promise.resolve();
		},
	}),
	"a preparation and no hold": () => ({ holds: undefined, prepare: async () => {} }),
};

describe("dispatch cancellation", () => {
	// The request's signal was read only when a hold was asked, so with no hold
	// to ask, a request cancelled before its dispatch went out anyway.
	test("sends nothing and prepares nothing for a request already cancelled, with no hold to wait on", async () => {
		for (const holds of [undefined, [] as DispatchHold[]]) {
			const abort = new AbortController();
			const reason = new Error("cancelled before dispatch");
			abort.abort(reason);
			let sent = 0;
			let prepared = 0;

			await expect(dispatchWhenOpen(holds, abort.signal, () => sent++)).rejects.toBe(reason);
			await expect(
				dispatchWhenOpen(
					holds,
					abort.signal,
					() => sent++,
					async () => {
						prepared += 1;
					},
				),
			).rejects.toBe(reason);

			expect({ sent, prepared }).toEqual({ sent: 0, prepared: 0 });
		}
	});

	// The signal was read when each hold was asked and when it answered, not
	// when the request went out: a cancellation in the microtasks after the
	// last answer still reached the send.
	test("never sends a cancelled request, wherever before the send the cancellation lands", async () => {
		const sentCancelled: string[] = [];
		const otherOutcome: string[] = [];
		const cancelledFirst = new Set<string>();
		for (const [shape, build] of Object.entries(BARRIERS)) {
			for (let depth = 1; depth <= MAX_DEPTH; depth++) {
				const { holds, prepare } = build();
				const abort = new AbortController();
				const reason = new Error(`cancelled ${depth} microtasks in`);
				afterMicrotasks(depth, () => abort.abort(reason));

				const outcome = await dispatchWhenOpen(
					holds,
					abort.signal,
					() => {
						if (abort.signal.aborted) sentCancelled.push(`${shape} at ${depth}`);
						return "sent";
					},
					prepare,
				).catch((error: unknown) => error);

				if (outcome === reason) cancelledFirst.add(shape);
				else if (outcome !== "sent") otherOutcome.push(`${shape} at ${depth}`);
				await loopTurn();
			}
		}

		expect(sentCancelled).toEqual([]);
		// A cancelled request fails with the caller's own reason, nothing else.
		expect(otherOutcome).toEqual([]);
		// Not vacuous: in every shape some cancellation landed before the send.
		expect([...cancelledFirst].sort()).toEqual(Object.keys(BARRIERS).sort());
	});

	// Cancelling one request ends its own wait and nothing else: the gate it
	// waited on is shared, stays closed, and keeps holding every other request.
	test("ends only the cancelled request's wait, with its own reason, leaving the gate and other waiters alone", async () => {
		const gate = probedGate();
		gate.close();
		const abort = new AbortController();
		const reason = new Error("this request cancelled");
		let sent = 0;

		const cancelled = dispatchWhenOpen(gate.hold, abort.signal, () => sent++);
		const other = dispatchWhenOpen(gate.hold, undefined, () => sent++);
		await loopTurn();
		abort.abort(reason);

		await expect(cancelled).rejects.toBe(reason);
		expect(gate.closed).toBe(true);
		expect(await heldForATurn(other)).toBe(true);
		gate.open();
		await other;
		expect(sent).toBe(1);
	});

	// The preparation was awaited, not raced: a request cancelled while its
	// preparation (a credential refresh, which other requests may share) was
	// pending stayed pending until that work ended, and kept its caller's
	// in-flight permit all that time.
	test("ends a pending preparation on cancellation with the caller's reason, leaving that work to its other waiters", async () => {
		const refresh = Promise.withResolvers<void>();
		let refreshes = 0;
		// One refresh every request that needs it shares, as a credential cache shares it.
		const prepare = () => {
			refreshes += 1;
			return refresh.promise;
		};
		const abort = new AbortController();
		const reason = new Error("cancelled while its key refreshed");
		let sent = 0;

		const cancelled = dispatchWhenOpen(probedGate().hold, abort.signal, () => sent++, prepare);
		const other = dispatchWhenOpen(probedGate().hold, undefined, () => sent++, prepare);
		await loopTurn();
		expect(refreshes).toBe(2);
		abort.abort(reason);

		const outcome = await Promise.race([
			cancelled.catch((error: unknown) => error),
			loopTurn().then(() => "still preparing"),
		]);
		expect(outcome).toBe(reason);
		expect(Bun.peek.status(refresh.promise)).toBe("pending");
		expect(await heldForATurn(other)).toBe(true);
		refresh.resolve();
		await other;
		expect(sent).toBe(1);
	});

	// Raced, the preparation is no longer awaited by the request that gave up
	// on it; it must still be observed, or its later failure goes unhandled.
	test("keeps observing a cancelled request's preparation, so its late failure is never unhandled", async () => {
		const unhandled: unknown[] = [];
		const onUnhandled = (error: unknown) => {
			unhandled.push(error);
		};
		process.on("unhandledRejection", onUnhandled);
		try {
			const refresh = Promise.withResolvers<void>();
			const abort = new AbortController();
			const reason = new Error("cancelled while its key refreshed");
			let sent = 0;

			const cancelled = dispatchWhenOpen(
				undefined,
				abort.signal,
				() => sent++,
				() => refresh.promise,
			);
			await loopTurn();
			abort.abort(reason);
			await expect(cancelled).rejects.toBe(reason);
			refresh.reject(new Error("refresh failed after the request was cancelled"));
			await loopTurn();
			await loopTurn();

			expect(unhandled).toEqual([]);
			expect(sent).toBe(0);
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
	});
});

describe("unheld transport", () => {
	// Deriving the unheld transport ran the caller's wrapper factory again, so
	// cleanup traffic got a counterfeit copy of the inference request's wrapper
	// with a fresh attempt count. The wrapper is that request's alone.
	test("keeps the caller's wrapper off the unheld transport and builds it once", async () => {
		let builds = 0;
		const calls: string[] = [];
		const wrap: TransportWrapper = inner => {
			builds += 1;
			let attempts = 0;
			return async (input, init) => {
				attempts += 1;
				calls.push("wrap");
				if (attempts > 1) throw new Error("attempt budget spent");
				return inner(input, init);
			};
		};
		const base = (async () => {
			calls.push("request");
			return new Response("{}", { status: 200 });
		}) satisfies FetchImpl;
		const observed = transportFetch(model(), base, undefined, wrap);
		await observed(ENDPOINT, { method: "POST" });
		await expect(observed(ENDPOINT, { method: "POST" })).rejects.toThrow("attempt budget spent");

		const cleanup = withoutDispatchHold(observed);
		calls.length = 0;
		await cleanup("https://example.invalid/v1/workflows/1", { method: "PATCH" });

		expect(builds).toBe(1);
		expect(calls).toEqual(["request"]);
	});
});
