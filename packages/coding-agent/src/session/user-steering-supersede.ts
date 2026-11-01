import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { isHiddenUserCompanion, isUserAuthoredQueuedMessage } from "./queued-messages";

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

/**
 * Which person's steer supersedes the dialog, and which messages then go first.
 * - `"arrivals"` (ACP permission requests): one admitted after the dialog opened; a steer
 *   queued before the request was not written in answer to it. The superseding messages move
 *   to the front of the queue, so the agent reads what stopped the call first (#15642).
 * - `"pending"` (`ask`): any still queued and unread; a question shown over an unread message
 *   from the person hides their latest input, so a second question in the same batch closes
 *   too. Every queued person's message moves ahead of agent steering in the order they were
 *   queued ({@link promotePersonSteering}).
 */
export type UserSteeringSupersedeMode = "arrivals" | "pending";

/** A dialog's watch for a person's steer; dispose it when the dialog ends. */
export interface UserSteeringSupersede extends Disposable {
	/** Aborts when a person's steer supersedes the dialog. */
	readonly signal: AbortSignal;
}

/**
 * Move every queued person's message, with its hidden companions, ahead of agent-authored
 * steering, keeping the person's messages in the order they were queued. A message that
 * supersedes a dialog is read before an agent card that reached the batch first, but never
 * before an earlier message from the person. Agent steering keeps its own order. Nothing
 * bounds by count how long a card then waits: it is read once no message moved here is
 * queued. This runs only while a person's message supersedes a dialog the agent itself
 * opened, so a card waits only while the person keeps answering the agent's questions with
 * messages.
 */
export function promotePersonSteering(agent: UserSteeringHost["agent"]): void {
	const person = agent.peekSteeringQueue().filter(m => isUserAuthoredQueuedMessage(m) || isHiddenUserCompanion(m));
	if (person.length > 0) agent.prioritizeSteering(person);
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
 * re-arms on every person's steer, so the watch checks again at each one while
 * the loop signal is down. A direct executor with no loop signal has no policy
 * to consult, and every admission counts.
 *
 * Only a person's steer supersedes: an agent-attributed steer leaves the dialog
 * open, and is not moved ahead.
 *
 * Without a `host` (a tool context with no session queue), only the loop
 * signal's `"user"` reason supersedes.
 */
export function superviseUserSteering(
	loopSteeringSignal: AbortSignal | undefined,
	host?: UserSteeringHost,
	mode: UserSteeringSupersedeMode = "arrivals",
): UserSteeringSupersede {
	const controller = new AbortController();
	// Arrivals before the dialog opened do not count in "arrivals" mode.
	const parkSeq = host && mode === "arrivals" ? host.steeringArrivalSeq() : undefined;
	// "arrivals" mode: every message admitted in this dialog's window, in admission order. Each
	// read drains the channel, so a later read alone would move only its own arrival, ahead of
	// an earlier one.
	const admitted: AgentMessage[] = [];
	/** Whether a person's steer supersedes the dialog now; moves the messages that go first. */
	const supersedes = (): boolean => {
		if (!host) return loopSteeringSignal?.reason === "user";
		if (mode === "pending") {
			if (!host.agent.peekSteeringQueue().some(isUserAuthoredQueuedMessage)) return false;
			promotePersonSteering(host.agent);
			return true;
		}
		admitted.push(...(host.steeringArrivalAdmitted(parkSeq) ?? []));
		if (!admitted.some(isUserAuthoredQueuedMessage)) return false;
		const queued = new Set(host.agent.peekSteeringQueue());
		const promotable = admitted.filter(
			message => queued.has(message) && (isUserAuthoredQueuedMessage(message) || isHiddenUserCompanion(message)),
		);
		if (promotable.length > 0) host.agent.prioritizeSteering(promotable);
		return true;
	};
	// Runs again after the dialog is superseded: a person's message that arrives while it
	// closes (a second one in the same tick, say) moves ahead of agent steering as well, until
	// the dialog's owner disposes the watch.
	const check = (): void => {
		if (loopSteeringSignal && !loopSteeringSignal.aborted) return;
		if (supersedes()) controller.abort();
	};
	let arrivalSignal = host?.steeringArrivalSignal();
	const onArrival = (): void => {
		check();
		if (!host) return;
		// The channel replaces its signal after each admission: follow it.
		arrivalSignal = host.steeringArrivalSignal();
		arrivalSignal.addEventListener("abort", onArrival, { once: true });
	};
	loopSteeringSignal?.addEventListener("abort", check, { once: true });
	arrivalSignal?.addEventListener("abort", onArrival, { once: true });
	if (loopSteeringSignal?.aborted || (!loopSteeringSignal && mode === "pending")) check();
	return {
		signal: controller.signal,
		[Symbol.dispose]: () => {
			loopSteeringSignal?.removeEventListener("abort", check);
			arrivalSignal?.removeEventListener("abort", onArrival);
			if (parkSeq !== undefined) host?.steeringArrivalRelease(parkSeq);
		},
	};
}
