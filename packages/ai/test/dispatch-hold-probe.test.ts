/**
 * A dispatch hold's synchronous probe (`DispatchHold.isClosed`) is what makes
 * the transport's holds a barrier. Awaiting a hold proves only that it was
 * open when it answered; in single-threaded JavaScript a gate can still close
 * in any microtask between that answer and the send. These tests close a
 * probed gate at each of those positions in turn and check that the request
 * never reaches the wire while a probe reads closed.
 */
import { describe, expect, test } from "bun:test";
import type { Api, DispatchHold, FetchImpl, Model, TransportWrapper } from "@oh-my-pi/pi-ai/types";
import { holdBeforeDispatch } from "@oh-my-pi/pi-ai/utils/dispatch-hold";
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
