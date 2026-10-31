/**
 * A shared flight is work one caller starts and every caller shares. Its own signal aborts only once
 * no caller is still waiting: one caller's abort ends that caller's wait, never the work, and a caller
 * that joins later keeps it alive. A held caller starts none, but may join one in flight.
 */
import { describe, expect, it } from "bun:test";
import { requestHoldScopes } from "@oh-my-pi/pi-utils/request-hold-scope";
import { fetchKey, SharedFlight } from "@oh-my-pi/pi-utils/shared-flight";

/** Work that settles when the test says so and records its own signal, once the work has started. */
async function controlledWork<T>() {
	const result = Promise.withResolvers<T>();
	const started = Promise.withResolvers<AbortSignal>();
	const flight = SharedFlight.start<T>(undefined, signal => {
		started.resolve(signal);
		return result.promise;
	});
	if (flight instanceof Promise) throw new Error("an unheld caller starts the flight");
	return { flight, result, signal: await started.promise };
}

/** Run `fn` in a hold scope whose owner began disposing; `end()` is that owner finishing. */
function heldScope() {
	const held = new AbortController();
	const ended = new AbortController();
	held.abort();
	return {
		run: <T>(fn: () => T): T =>
			requestHoldScopes.run({ held: held.signal, ended: ended.signal, parent: undefined }, fn),
		end: () => ended.abort(),
	};
}

const abortedWith = (reason: string) => (signal: AbortSignal) => new Error(`${reason}: ${String(signal.reason)}`);

describe("SharedFlight", () => {
	it("ends only the leaving caller's wait when one caller of two aborts", async () => {
		const { flight, result, signal } = await controlledWork<string>();
		const first = new AbortController();
		const firstWait = flight.join(first.signal, abortedWith("first"));
		const secondWait = flight.join(new AbortController().signal);

		first.abort("first left");

		await expect(firstWait).rejects.toThrow("first: first left");
		expect({ workAborted: signal.aborted, abandoned: flight.abandoned }).toEqual({
			workAborted: false,
			abandoned: false,
		});
		result.resolve("shared value");
		expect(await secondWait).toBe("shared value");
	});

	it("cancels the work once every caller has stopped waiting", async () => {
		const { flight, signal } = await controlledWork<string>();
		const first = new AbortController();
		const second = new AbortController();
		const waits = [flight.join(first.signal), flight.join(second.signal)].map(wait => wait.catch(() => "left"));

		first.abort();
		expect(signal.aborted).toBe(false);
		second.abort();

		expect({ workAborted: signal.aborted, abandoned: flight.abandoned }).toEqual({
			workAborted: true,
			abandoned: true,
		});
		expect(await Promise.all(waits)).toEqual(["left", "left"]);
	});

	it("is kept alive by a caller that joins after the first one", async () => {
		const { flight, result, signal } = await controlledWork<number>();
		const first = new AbortController();
		const later = new AbortController();
		const firstWait = flight.join(first.signal).catch(() => "left");
		const laterWait = flight.join(later.signal);

		first.abort();
		await firstWait;
		expect(signal.aborted).toBe(false);
		result.resolve(7);
		expect(await laterWait).toBe(7);
	});

	it("is pinned by a caller that brings no signal", async () => {
		const { flight, result, signal } = await controlledWork<string>();
		const leaving = new AbortController();
		const leavingWait = flight.join(leaving.signal).catch(() => "left");
		const pinned = flight.join();

		leaving.abort();
		await leavingWait;
		expect(signal.aborted).toBe(false);
		result.resolve("done");
		expect(await pinned).toBe("done");
	});

	it("refuses a caller whose signal already aborted, cancelling work no one else waits for", async () => {
		const { flight, signal } = await controlledWork<string>();
		const gone = AbortSignal.abort("gone");

		await expect(flight.join(gone, abortedWith("late"))).rejects.toThrow("late: gone");
		expect({ workAborted: signal.aborted, abandoned: flight.abandoned }).toEqual({
			workAborted: true,
			abandoned: true,
		});
	});

	it("passes the work's own rejection to every caller still waiting", async () => {
		const { flight, result } = await controlledWork<string>();
		const waits = [flight.join(new AbortController().signal), flight.join()];

		result.reject(new Error("upstream failed"));

		for (const wait of waits) await expect(wait).rejects.toThrow("upstream failed");
	});

	it("settles without rejecting once abandoned work rejects, so no rejection goes unhandled", async () => {
		const { flight, result } = await controlledWork<string>();
		const caller = new AbortController();
		const wait = flight.join(caller.signal).catch(() => "left");
		caller.abort();
		await wait;

		result.reject(new Error("cancelled by its own signal"));

		expect(await flight.settled).toBeUndefined();
	});

	it("does not abandon work that already settled when a caller aborts afterwards", async () => {
		const { flight, result, signal } = await controlledWork<string>();
		const caller = new AbortController();
		const wait = flight.join(caller.signal);
		result.resolve("value");
		expect(await wait).toBe("value");

		caller.abort();

		expect({ workAborted: signal.aborted, abandoned: flight.abandoned }).toEqual({
			workAborted: false,
			abandoned: false,
		});
	});

	it("starts nothing for a held caller, refusing it once its scope ends", async () => {
		const scope = heldScope();
		let started = false;

		const outcome = scope.run(() =>
			SharedFlight.start(undefined, async () => {
				started = true;
				return "never";
			}),
		);
		expect(outcome).toBeInstanceOf(Promise);
		const refusal = (outcome as Promise<never>).catch((error: unknown) => error);
		scope.end();

		expect({ started, refusal: ((await refusal) as Error).name }).toEqual({ started: false, refusal: "AbortError" });
	});

	it("lets a held caller join work already in flight", async () => {
		const { flight, result } = await controlledWork<string>();
		const scope = heldScope();

		const heldWait = scope.run(() => flight.join(new AbortController().signal));
		result.resolve("shared value");

		expect(await heldWait).toBe("shared value");
		scope.end();
	});

	it("counts its starter as waiting before the work's first step runs", async () => {
		const starter = new AbortController();
		let abortedAtFirstStep: boolean | undefined;
		const flight = SharedFlight.start(starter.signal, async signal => {
			// The starter leaves while the work's first synchronous step runs, as a refresh's lease does.
			starter.abort();
			abortedAtFirstStep = signal.aborted;
			return "unused";
		});
		if (flight instanceof Promise) throw new Error("an unheld caller starts the flight");
		const wait = flight.join(starter.signal).catch(() => "left");
		await flight.settled;

		expect({ abortedAtFirstStep, wait: await wait }).toEqual({ abortedAtFirstStep: true, wait: "left" });
	});
});

describe("fetchKey", () => {
	it("keys each transport apart, and the default transport as 0", () => {
		const first = () => Promise.resolve(new Response());
		const second = () => Promise.resolve(new Response());

		expect({
			same: fetchKey(first) === fetchKey(first),
			distinct: fetchKey(first) !== fetchKey(second),
			defaultTransport: fetchKey(undefined),
		}).toEqual({ same: true, distinct: true, defaultTransport: 0 });
	});
});
