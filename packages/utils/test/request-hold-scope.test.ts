/**
 * `admitSharedStart` is asked right before shared work (a credential refresh, a usage poll, a
 * discovery lookup) starts a new flight. A held caller must not start one: its owner began disposing,
 * so it waits until its own signal or the end of a scope around it, then is refused. A caller that is
 * not held, or that already runs in shared work, may start one.
 *
 * Scopes are entered here through the store itself; `@oh-my-pi/pi-ai`'s `runInRequestHoldScope` is the
 * only production code that enters them, and pi-utils cannot import it.
 */
import { describe, expect, it } from "bun:test";
import {
	admitSharedStart,
	type RequestHoldScope,
	requestHoldScopes,
	runOutsideRequestHold,
} from "../src/request-hold-scope";

function scope(parent?: RequestHoldScope) {
	const held = new AbortController();
	const ended = new AbortController();
	return { held, ended, value: { held: held.signal, ended: ended.signal, parent } };
}

/** How `promise` stands once pending microtasks ran: an admission settles without any timer. */
async function outcome(promise: Promise<unknown>): Promise<string> {
	let state = "pending";
	promise.then(
		() => {
			state = "resolved";
		},
		(error: Error) => {
			state = `rejected: ${error.message}`;
		},
	);
	for (let round = 0; round < 20; round++) await Promise.resolve();
	return state;
}

describe("admitSharedStart", () => {
	it("admits a start outside every scope", () => {
		expect(admitSharedStart()).toBeUndefined();
	});

	it("admits a start in a scope that is not held", () => {
		const { value } = scope();
		expect(requestHoldScopes.run(value, () => admitSharedStart())).toBeUndefined();
	});

	it("holds a start in a held scope until the scope ends, then refuses it", async () => {
		const { held, ended, value } = scope();
		held.abort();
		const refusal = requestHoldScopes.run(value, () => admitSharedStart());
		expect(refusal).toBeInstanceOf(Promise);
		expect(await outcome(refusal!)).toBe("pending");

		ended.abort();

		expect(await outcome(refusal!)).toContain("its owner began disposing");
	});

	it("refuses a held start when the caller's own signal aborts", async () => {
		const { held, value } = scope();
		const request = new AbortController();
		held.abort();
		const refusal = requestHoldScopes.run(value, () => admitSharedStart(request.signal));

		request.abort();

		expect(await outcome(refusal!)).toContain("its owner began disposing");
	});

	it("holds a start in a scope nested inside a held one", async () => {
		const outer = scope();
		const inner = scope(outer.value);
		outer.held.abort();
		const refusal = requestHoldScopes.run(inner.value, () => admitSharedStart());
		expect(await outcome(refusal!)).toBe("pending");

		outer.ended.abort();

		expect(await outcome(refusal!)).toContain("its owner began disposing");
	});

	it("admits a start made from shared work, which no held caller owns", () => {
		const { held, value } = scope();
		held.abort();
		expect(requestHoldScopes.run(value, () => runOutsideRequestHold(() => admitSharedStart()))).toBeUndefined();
	});
});
