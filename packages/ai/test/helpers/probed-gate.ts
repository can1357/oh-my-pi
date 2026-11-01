/**
 * A dispatch hold with a probe (`DispatchHold.isClosed`), and the tools to
 * close it in the window between the hold answering and the send that answer
 * lets through. A site that reads the probe in the same synchronous step as
 * its send never sends while the gate reads closed, wherever in that window
 * the gate closes; one that awaits the hold and sends a few microtasks later
 * does, at some depth.
 */
import type { DispatchHold } from "@oh-my-pi/pi-ai/types";

/** Deep enough to reach past every microtask between a hold's answer and the send it guards. */
export const PROBE_MAX_DEPTH = 24;

/** One turn of the event loop: long enough for a held send to show it parked. */
export function nextTurn(): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setImmediate(resolve);
	return promise;
}

/** Runs `fn` `depth` microtasks from now. */
export function afterMicrotasks(depth: number, fn: () => void): void {
	queueMicrotask(() => (depth <= 1 ? fn() : afterMicrotasks(depth - 1, fn)));
}

/**
 * `/pause` with a probe, as `agentPauseGate` builds one: open, its hold
 * answers at once; closed, it parks until reopened, and its probe says so.
 */
export class ProbedGate {
	closed = false;
	#reopened = Promise.withResolvers<void>();
	/** The gate's hold, probe and all. */
	readonly hold: DispatchHold;

	constructor() {
		this.hold = () => (this.closed ? this.#reopened.promise : undefined);
		this.hold.isClosed = () => this.closed;
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.#reopened = Promise.withResolvers<void>();
	}

	open(): void {
		this.closed = false;
		this.#reopened.resolve();
	}

	/**
	 * This gate's hold, which closes the gate `depth` microtasks after the
	 * first answer it gives while `when` is true: the pause lands between the
	 * hold answering and the send that answer let through.
	 */
	holdClosingAfter(depth: number, when: () => boolean): DispatchHold {
		let armed = true;
		const hold: DispatchHold = () => {
			if (armed && when()) {
				armed = false;
				afterMicrotasks(depth, () => this.close());
			}
			return this.hold();
		};
		hold.isClosed = this.hold.isClosed;
		return hold;
	}
}

/**
 * Waits for `pending`, reopening `gate` each turn it is found closed, as a
 * human resuming would. `held` runs for a closed gate found while `unsent`
 * still says the guarded send has not happened: the barrier caught it.
 */
export async function resumeUntilSettled<T>(
	pending: Promise<T>,
	gate: ProbedGate,
	unsent: () => boolean,
	held: () => void,
): Promise<T> {
	let outcome: { value: T } | { error: unknown } | undefined;
	void pending.then(
		value => {
			outcome = { value };
		},
		(error: unknown) => {
			outcome = { error };
		},
	);
	while (!outcome) {
		await nextTurn();
		if (!gate.closed) continue;
		if (unsent()) held();
		gate.open();
	}
	if ("error" in outcome) throw outcome.error;
	return outcome.value;
}
