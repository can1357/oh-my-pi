/**
 * The pause after a failed automatic Hindsight recall (`hindsight.recallCooldownMs`).
 *
 * While the server does not respond, every prompt would otherwise wait out the recall
 * timeout again. After a failure, no automatic recall runs until the pause ends. The first
 * pause is `recallCooldownMs`. Each further failure in a row doubles it, up to 30 minutes,
 * or up to `recallCooldownMs` when that is longer. `0` or less turns the pause off.
 *
 * An automatic recall that answers ends the pause, and the next pause starts again at
 * `recallCooldownMs`. The `recall` tool neither waits for the pause nor ends it.
 *
 * The pause is kept in memory for the running session state, so a new process starts
 * without one.
 */
import { formatDuration } from "@oh-my-pi/pi-utils";

/** The longest pause, unless `recallCooldownMs` is longer. */
const MAX_PAUSE_MS = 30 * 60 * 1000;

/** Latest epoch ms a date can hold; a later retry cannot be represented, and such a pause never ends anyway. */
const MAX_DATE_MS = 8.64e15;

/** The last failed automatic recall of a state. */
export interface RecallFailure {
	/** When the recall failed, epoch ms. */
	at: number;
	/** Failed automatic recalls in a row, up to this one. */
	failures: number;
	/** The failure's cause, as its notice shows it. */
	error: string;
}

/** An automatic recall the pause holds off. */
export interface RecallSkip {
	failure: RecallFailure;
	/** When automatic recall may run again, epoch ms. */
	retryAt: number;
	/** First skip of this failure: announce it. */
	first: boolean;
}

/** When automatic recall may run again after `failure`, epoch ms. */
function retryAtAfter(failure: RecallFailure, cooldownMs: number): number {
	const pauseMs = Math.min(cooldownMs * 2 ** (failure.failures - 1), Math.max(MAX_PAUSE_MS, cooldownMs));
	return Math.min(failure.at + pauseMs, MAX_DATE_MS);
}

/** Whether `failure`'s pause still runs at `now`; a clock set back before `failure.at` ends it. */
function isWaiting(failure: RecallFailure, cooldownMs: number, now: number): boolean {
	return now >= failure.at && now < retryAtAfter(failure, cooldownMs);
}

/**
 * The record after an automatic recall failed at `now`: `previous` unchanged while its wait
 * still runs (the recall was in flight when another failed), else one more consecutive failure.
 */
function nextFailure(
	previous: RecallFailure | undefined,
	cooldownMs: number,
	now: number,
	error: string,
): RecallFailure {
	if (previous && isWaiting(previous, cooldownMs, now)) return previous;
	return { at: now, failures: (previous?.failures ?? 0) + 1, error };
}

/**
 * Notice for the first automatic recall skipped after a failure; automatic recall may run
 * again at `retryAt`, epoch ms. `cause` must already be cleaned for display.
 */
export function recallSkippedNotice(retryAt: number, cause: string, now: number): string {
	const clock = new Date(retryAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
	return `Memory recall paused until ${clock} (in ${formatDuration(retryAt - now)}) after a failed recall: ${cause}`;
}

/**
 * The last failed automatic recall of one state, kept in memory. A conversation reset or
 * session switch keeps it: the server's health is not conversation state.
 */
export class RecallFailureWait {
	readonly #cooldownMs: number;
	#failure: RecallFailure | undefined;
	/** The failure whose skip was already announced. */
	#announced: RecallFailure | undefined;

	/** `cooldownMs` is `hindsight.recallCooldownMs`, the first pause; `0`, less or `NaN` turns the pause off. */
	constructor(cooldownMs: number) {
		this.#cooldownMs = cooldownMs > 0 ? cooldownMs : 0;
	}

	/** The failure that holds off an automatic recall at `now`; undefined when the recall may run. */
	skip(now: number): RecallSkip | undefined {
		const failure = this.#failure;
		if (!failure || !isWaiting(failure, this.#cooldownMs, now)) return undefined;
		const first = this.#announced !== failure;
		this.#announced = failure;
		return { failure, retryAt: retryAtAfter(failure, this.#cooldownMs), first };
	}

	/**
	 * When automatic recall may run again if a recall fails at `now`, epoch ms; undefined
	 * when `recallCooldownMs` is `0` or less.
	 */
	retryAtAfterFailure(now: number): number | undefined {
		if (this.#cooldownMs <= 0) return undefined;
		return retryAtAfter(nextFailure(this.#failure, this.#cooldownMs, now, ""), this.#cooldownMs);
	}

	/**
	 * Records an automatic recall's outcome. A failure (`failure`, its cause) starts a pause,
	 * or a doubled one when the previous pause has ended. A failure during a running pause
	 * changes nothing. An answered recall (`ok`) ends the pause, also one that a conversation
	 * reset made stale, so the next failure starts again at the first pause. An aborted recall,
	 * or a failure that a reset made stale, has neither and records nothing.
	 */
	record(outcome: { ok: boolean; failure?: string }, now: number): void {
		if (this.#cooldownMs <= 0) return;
		if (outcome.failure !== undefined) {
			this.#failure = nextFailure(this.#failure, this.#cooldownMs, now, outcome.failure);
		} else if (outcome.ok) {
			this.#failure = undefined;
		}
	}
}
