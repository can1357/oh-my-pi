import * as AIError from "../error";
import type { DispatchHold } from "../types";
import { raceWithSignal } from "./abort";

/**
 * Await a caller's dispatch hold immediately before one request-producing
 * transport operation, and let a cancellation interrupt it.
 *
 * Every site that puts bytes on the wire for an inference request funnels
 * through this: the provider-dispatch chokepoint, the one transport fetch, and
 * each transport whose request is not an HTTP fetch (the Codex websocket, the
 * Cursor HTTP/2 stream, the GitLab Duo workflow socket). Call it *after* that
 * site's own asynchronous preparation — a handshake, a payload build, a
 * request-debug dump — so no await of ours can still follow the hold.
 *
 * An indefinite hold is legitimate (`/pause` holds until a human resumes); an
 * indefinite hold after the request was cancelled is not. `signal` therefore
 * ends the wait with the caller's own abort reason, which fails that attempt
 * like any other dispatch error and lets its caller release whatever it holds
 * (a provider in-flight permit, a socket). The hold itself keeps running — it
 * is the caller's shared gate, not this request's — and stays observed, so a
 * later rejection is never unhandled.
 */
export async function holdBeforeDispatch(hold: DispatchHold | undefined, signal?: AbortSignal | null): Promise<void> {
	if (!hold) return;
	if (signal?.aborted) throw signal.reason ?? new AIError.AbortError("Request aborted before dispatch");
	const pending = hold();
	if (pending) await raceWithSignal(pending, signal ?? undefined);
	if (signal?.aborted) throw signal.reason ?? new AIError.AbortError("Request aborted before dispatch");
}

/**
 * How many passes {@link holdAllBeforeDispatch} makes before it gives up. Only
 * a park keeps the barrier going round: a gate parks while it is closed, so a
 * few passes cover every pause a human engages while another hold waits. A
 * hold that parks every time it is asked (a pacing delay, a hold that always
 * awaits I/O) never lets a pass finish, so it is not a gate another hold can
 * be checked against.
 */
export const MAX_DISPATCH_HOLD_PASSES = 8;

/**
 * How a hold after the first answered: `now` when what it returned had
 * already settled, `late` when its promise was still pending but settled in
 * the microtasks that followed, `parked` when the event loop turned first.
 */
type HoldAnswer = "now" | "late" | "parked";

/**
 * Await several dispatch holds as one barrier: the request may go out only
 * when none of them is closed at the same moment.
 *
 * Awaiting them one after another is not that. A hold already awaited may
 * close again while a later one waits — a `/pause` engaged then would still
 * send — so every answer before a hold that made the barrier wait is stale.
 * The holds are awaited in order, and when one after the first parks, the
 * pass starts again from the first. One that answers late has given the
 * earlier holds time to change too, if less of it; that pass is confirmed by
 * one more, in which only a park starts again, so a hold that always awaits
 * something on its way to answering costs two passes, not an endless loop. A
 * pass in which every hold after the first answers at once proves they were
 * all open together, as does a confirming pass with no park.
 *
 * The first hold has nothing before it to go stale, so however long it parks
 * the pass goes on, and a single hold is exactly {@link holdBeforeDispatch}:
 * one call, no re-check. A barrier still going round after
 * {@link MAX_DISPATCH_HOLD_PASSES} passes fails the attempt rather than loop
 * forever or send under a hold nobody verified.
 */
export async function holdAllBeforeDispatch(
	holds: readonly DispatchHold[],
	signal?: AbortSignal | null,
): Promise<void> {
	let confirming = false;
	for (let pass = 1; ; pass++) {
		await holdBeforeDispatch(holds[0], signal);
		let worst: HoldAnswer = "now";
		// Indexed, not iterated over a copy: a hold added to a live transport
		// while this request waits gates it too.
		for (let i = 1; i < holds.length && worst !== "parked"; i++) {
			const answer = await askHold(holds[i]!, signal);
			if (answer !== "now") worst = answer;
		}
		if (worst === "now" || (worst === "late" && confirming)) return;
		if (pass >= MAX_DISPATCH_HOLD_PASSES) {
			throw new AIError.ProviderResponseError(
				`Dispatch holds did not open together in ${MAX_DISPATCH_HOLD_PASSES} passes: a hold after the first parks every time it is asked, so it cannot gate a request alongside another hold`,
				{ kind: "runtime" },
			);
		}
		confirming = worst === "late";
	}
}

/** Await one hold after the first, and report how it answered. */
async function askHold(hold: DispatchHold, signal: AbortSignal | null | undefined): Promise<HoldAnswer> {
	let late = false;
	let parked = false;
	const marker = setImmediate(() => {
		parked = true;
	});
	// The marker only observes the hold; it must not keep a process alive.
	marker.unref();
	try {
		await holdBeforeDispatch(() => {
			const pending = hold();
			late = pending !== undefined && Bun.peek.status(pending) === "pending";
			return pending;
		}, signal);
	} finally {
		clearImmediate(marker);
	}
	return parked ? "parked" : late ? "late" : "now";
}
