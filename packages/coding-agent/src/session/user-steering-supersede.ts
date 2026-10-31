import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { isUserAuthoredQueuedMessage } from "./queued-messages";

/** Session steering-arrival channel and queue access a dialog needs to watch for a person's steer. */
export interface UserSteeringHost {
	/** Aborts on the next user-steering admission; replaced after each one. */
	steeringArrivalSignal(): AbortSignal;
	/** Park snapshot: only arrivals after it belong to the caller's window. */
	steeringArrivalSeq(): number;
	/** Drains the steering groups admitted after `since`, in admission order. */
	steeringArrivalAdmitted(since?: number): readonly AgentMessage[] | undefined;
	/** Releases a park snapshot whose window will not be read again. */
	steeringArrivalRelease(seq: number): void;
	agent: {
		peekSteeringQueue(): readonly AgentMessage[];
		prioritizeSteering(messages: readonly AgentMessage[]): void;
	};
}

/** A dialog's watch for a person's steer; dispose it when the dialog ends. */
export interface UserSteeringSupersede extends Disposable {
	/** Aborts when a person's steer supersedes the dialog. */
	readonly signal: AbortSignal;
}

/**
 * Watch for a person's steer while a dialog blocks a tool call.
 *
 * `loopSteeringSignal` is the tool call's cooperative steering signal. It aborts
 * once per tool batch, for the first queued steer of any source, and never in
 * `interruptMode: "wait"`, so it is the proof that the loop's policy allows an
 * interrupt in this batch, not the answer to "did a person speak". An agent
 * card, a peer message or an aside can spend it first; a person's steer queued
 * after that must still supersede the dialog. The session's arrival channel
 * re-arms on every user-steering admission, so the watch reads it at each one
 * while the loop signal is down. A direct executor with no loop signal has no
 * policy to consult, and every admission counts.
 *
 * Only a person's steer supersedes: an agent-attributed steer leaves the dialog
 * open. The superseding group moves to the front of the steering queue, so the
 * agent reads what stopped the dialog before older queued steering.
 *
 * Without a `host` (a tool context with no session queue), only the loop
 * signal's `"user"` reason supersedes.
 */
export function superviseUserSteering(
	loopSteeringSignal: AbortSignal | undefined,
	host?: UserSteeringHost,
): UserSteeringSupersede {
	const controller = new AbortController();
	// Arrivals before the dialog opened keep their queue position.
	const parkSeq = host?.steeringArrivalSeq();
	const supersede = (arrived: readonly AgentMessage[]): void => {
		if (controller.signal.aborted) return;
		if (host && arrived.length > 0) {
			const queued = new Set(host.agent.peekSteeringQueue());
			const promotable = arrived.filter(message => queued.has(message));
			if (promotable.length > 0) host.agent.prioritizeSteering(promotable);
		}
		controller.abort();
	};
	const readUserArrivals = (): readonly AgentMessage[] => {
		if (!host || parkSeq === undefined) return [];
		const arrived = host.steeringArrivalAdmitted(parkSeq) ?? [];
		return arrived.some(isUserAuthoredQueuedMessage) ? arrived : [];
	};
	const onLoopSteer = (): void => {
		const arrived = readUserArrivals();
		if (arrived.length > 0 || loopSteeringSignal?.reason === "user") supersede(arrived);
	};
	let arrivalSignal = host?.steeringArrivalSignal();
	const onArrival = (): void => {
		if (!loopSteeringSignal || loopSteeringSignal.aborted) {
			const arrived = readUserArrivals();
			if (arrived.length > 0) supersede(arrived);
		}
		if (controller.signal.aborted || !host) return;
		// The channel replaces its signal after each admission: follow it.
		arrivalSignal = host.steeringArrivalSignal();
		arrivalSignal.addEventListener("abort", onArrival, { once: true });
	};
	if (loopSteeringSignal?.aborted) onLoopSteer();
	else loopSteeringSignal?.addEventListener("abort", onLoopSteer, { once: true });
	if (arrivalSignal?.aborted) onArrival();
	else arrivalSignal?.addEventListener("abort", onArrival, { once: true });
	return {
		signal: controller.signal,
		[Symbol.dispose]: () => {
			loopSteeringSignal?.removeEventListener("abort", onLoopSteer);
			arrivalSignal?.removeEventListener("abort", onArrival);
			if (parkSeq !== undefined) host?.steeringArrivalRelease(parkSeq);
		},
	};
}
