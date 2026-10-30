import * as AIError from "../error";
import type { DispatchHold } from "../types";
import { raceWithSignal } from "./abort";

/**
 * Await a caller's dispatch hold immediately before one request-producing
 * transport operation, and let a cancellation interrupt it.
 *
 * Every site that puts bytes on the wire for an inference request funnels
 * through this or {@link dispatchWhenOpen}: the provider-dispatch chokepoint,
 * the one transport fetch, and each transport whose request is not an HTTP
 * fetch (the Codex websocket, the Cursor HTTP/2 stream, the GitLab Duo
 * workflow socket). Call it *after* that site's own asynchronous preparation —
 * a handshake, a payload build, a request-debug dump — so no await of ours can
 * still follow the hold.
 *
 * An indefinite hold is legitimate (`/pause` holds until a human resumes); an
 * indefinite hold after the request was cancelled is not. `signal` therefore
 * ends the wait with the caller's own abort reason, which fails that attempt
 * like any other dispatch error and lets its caller release whatever it holds
 * (a provider in-flight permit, a socket). The hold itself keeps running — it
 * is the caller's shared gate, not this request's — and stays observed, so a
 * later rejection is never unhandled.
 *
 * It returns once the hold has answered and its probe, if it has one
 * ({@link DispatchHold.isClosed}), reads open, asking the hold again while the
 * probe reads closed. That still leaves the microtasks between this return and
 * the caller's send, in which a gate can close. A site whose send is one
 * synchronous call is exact only through {@link dispatchWhenOpen}, which reads
 * the probe in the same step as the send.
 */
export async function holdBeforeDispatch(hold: DispatchHold | undefined, signal?: AbortSignal | null): Promise<void> {
	if (hold) await dispatchWhenOpen(hold, signal, () => {});
}

/**
 * Await every hold on one request, then call `send` in the same synchronous
 * step as the last check that none of them is closed, and return what it
 * returns.
 *
 * That last check is what makes the holds a barrier, and it can only be made
 * for a hold that carries a probe ({@link DispatchHold.isClosed}). Awaiting a
 * hold proves it was open when it answered, not that it still is: a gate can
 * close in any microtask between that answer and the send. So once every hold
 * has answered, every probe is read and `send` runs with nothing awaited in
 * between; a probe that reads closed sends the barrier round again, awaiting
 * every hold afresh. Going round has no limit, because only a closed gate
 * causes it, and a gate that keeps closing is a gate that is closed: waiting
 * on it is the point. A request therefore never reaches `send` while any probe
 * reads closed.
 *
 * A hold without a probe is a plain function, and nothing can re-read it
 * without awaiting it again. For such a hold this guarantees the wait and
 * nothing more: it may close again after it answered and the request still
 * goes out. The re-asking described at {@link MAX_DISPATCH_HOLD_PASSES}
 * narrows that window for one answered before a later hold waited; it does
 * not close it.
 *
 * `send` must put the request on the wire before it awaits anything, or a gate
 * could close in that await too. A hold given to a live transport while this
 * waits is awaited before any probe is read.
 *
 * `signal` is the request's own cancellation, which no hold's probe need
 * encode. It ends the whole wait with the caller's reason, each hold and each
 * round's preparation alike, and it is read once more in the synchronous step
 * that calls `send`, after the probes: a request cancelled in any microtask
 * before its send never reaches it, whether it had holds or none. Neither a
 * hold nor a preparation is settled by that. Both belong to the caller and may
 * be shared with other requests, so they keep running, observed, and a later
 * rejection is never unhandled.
 *
 * `prepare` is work whose result must not be older than the last wait: a
 * signature, a short-lived token. It runs on every round, after the holds have
 * answered and before the probes are read, so a gate that closes while it runs
 * sends the barrier round again and the work is redone after that wait too. It
 * is not started for a request already cancelled.
 */
export async function dispatchWhenOpen<T>(
	hold: DispatchHold | readonly DispatchHold[] | undefined,
	signal: AbortSignal | null | undefined,
	send: () => T | PromiseLike<T>,
	prepare?: () => Promise<void>,
): Promise<T> {
	const holds = hold === undefined ? NO_HOLDS : typeof hold === "function" ? [hold] : hold;
	for (;;) {
		const asked = await awaitHolds(holds, signal);
		if (prepare) {
			throwIfAborted(signal);
			// Raced, not awaited: a refresh the caller shares with other
			// requests need not settle for this one to give up on it.
			await raceWithSignal(prepare(), signal ?? undefined);
		}
		// Synchronous from here to `send`. A hold that joined the live list
		// after the pass that asked the others has never been awaited, so it
		// sends the barrier round as a closed probe does. The signal is read
		// here as well as in the waits: a cancellation can land in the
		// microtasks between any await above and this step.
		if (asked === holds.length && !holds.some(held => held.isClosed?.() === true)) {
			throwIfAborted(signal);
			return send();
		}
	}
}

/**
 * How many passes the best-effort re-check of holds without a probe makes
 * before it gives up. A hold without a probe that answered before a later hold
 * parked may have closed again in the meantime, and nothing can re-read it, so
 * the pass starts again from the first hold. A later hold that answered late
 * gave the earlier ones time to change too, if less of it, and costs one
 * confirming pass in which only a park starts again, so a hold that always
 * awaits something on its way to answering costs two passes, not an endless
 * loop. A hold with a probe never needs any of this: its probe is read at the
 * send. A hold that parks every time it is asked (a pacing delay) behind one
 * without a probe never lets a pass finish, and after this many passes the
 * attempt fails rather than loop forever or send past a hold nobody re-read.
 */
export const MAX_DISPATCH_HOLD_PASSES = 8;

/**
 * How a hold answered: `now` when what it returned had already settled, `late`
 * when its promise was still pending but settled in the microtasks that
 * followed, `parked` when the event loop turned first.
 */
type HoldAnswer = "now" | "late" | "parked";

const NO_HOLDS: readonly DispatchHold[] = [];

/**
 * Await every hold in order, and return how many the finishing pass asked.
 * While every hold before the current one carries a probe, nothing asked so
 * far can go stale unseen, and the current one is simply awaited; after a
 * hold without a probe, each later answer is classified and may restart the
 * pass ({@link MAX_DISPATCH_HOLD_PASSES}).
 */
async function awaitHolds(holds: readonly DispatchHold[], signal: AbortSignal | null | undefined): Promise<number> {
	let confirming = false;
	for (let pass = 1; ; pass++) {
		let worst: HoldAnswer = "now";
		let unprobed = false;
		let asked = 0;
		// Indexed, not iterated over a copy: a hold added to a live transport
		// while this request waits gates it too.
		for (; asked < holds.length && worst !== "parked"; asked++) {
			const hold = holds[asked]!;
			const answer = await askHold(hold, signal, unprobed);
			if (answer !== "now") worst = answer;
			if (!hold.isClosed) unprobed = true;
		}
		if (worst === "now" || (worst === "late" && confirming)) return asked;
		if (pass >= MAX_DISPATCH_HOLD_PASSES) {
			throw new AIError.ProviderResponseError(
				`Dispatch holds did not open together in ${MAX_DISPATCH_HOLD_PASSES} passes: a hold parks every time it is asked behind one without a probe, so that one cannot be re-checked`,
				{ kind: "runtime" },
			);
		}
		confirming = worst === "late";
	}
}

/** Await one hold; when `observe` is set, report how it answered. */
async function askHold(
	hold: DispatchHold,
	signal: AbortSignal | null | undefined,
	observe: boolean,
): Promise<HoldAnswer> {
	throwIfAborted(signal);
	let parked = false;
	const marker = observe
		? setImmediate(() => {
				parked = true;
			})
		: undefined;
	// The marker only observes the hold; it must not keep a process alive.
	marker?.unref();
	try {
		const pending = hold();
		const late = observe && pending !== undefined && Bun.peek.status(pending) === "pending";
		if (pending) await raceWithSignal(pending, signal ?? undefined);
		throwIfAborted(signal);
		return parked ? "parked" : late ? "late" : "now";
	} finally {
		clearImmediate(marker);
	}
}

function throwIfAborted(signal: AbortSignal | null | undefined): void {
	if (signal?.aborted) throw signal.reason ?? new AIError.AbortError("Request aborted before dispatch");
}
