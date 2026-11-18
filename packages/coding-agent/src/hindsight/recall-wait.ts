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
 * The pause belongs to a primary session state and to the subagent aliases started from it,
 * on this thread or on a worker: an alias's compaction recall waits it out, and its outcome
 * counts as the primary's would. It is kept in memory, so a new process starts without one.
 */
import { formatDuration } from "@oh-my-pi/pi-utils";

/** The longest pause, unless `recallCooldownMs` is longer. */
const MAX_PAUSE_MS = 30 * 60 * 1000;

/** Latest epoch ms a date can hold; a later retry cannot be represented, and such a pause never ends anyway. */
const MAX_DATE_MS = 8.64e15;

/** The last failed automatic recall of a primary state and its aliases. */
export interface RecallFailure {
	/** A number its {@link RecallFailureWait} gives each new record; each state announces a record's first skip once. */
	id: number;
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
}

/** An automatic recall's outcome as a {@link RecallWait} records it. */
export interface RecallWaitOutcome {
	ok: boolean;
	failure?: string;
}

/**
 * The pause of a primary session state, which its subagent aliases share. The clock is read
 * where the record lives, so a worker alias's calls run on the main thread's clock.
 */
export interface RecallWait {
	/** The failure that holds off an automatic recall now; undefined when the recall may run. */
	skip(): RecallSkip | undefined;
	/**
	 * Records an automatic recall's outcome: `ok` for an answer, `failure` (its cause) for a
	 * failure. Returns when automatic recall may run again after a failure it keeps, epoch ms;
	 * undefined after an answer or with the pause off.
	 */
	record(outcome: RecallWaitOutcome): number | undefined;
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
 * Notice for the first automatic recall skipped after a failure; automatic recall may run
 * again at `retryAt`, epoch ms. `cause` must already be cleaned for display.
 */
export function recallSkippedNotice(retryAt: number, cause: string, now: number): string {
	const clock = new Date(retryAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
	return `Memory recall paused until ${clock} (in ${formatDuration(retryAt - now)}) after a failed recall: ${cause}`;
}

/**
 * The last failed automatic recall of a primary session state, kept in memory and shared with
 * the subagent aliases started from it. A conversation reset or session switch keeps it: the
 * server's health is not conversation state.
 */
export class RecallFailureWait implements RecallWait {
	readonly #cooldownMs: number;
	#failure: RecallFailure | undefined;
	/** The number of the last failure record. */
	#lastId = 0;

	/** `cooldownMs` is `hindsight.recallCooldownMs`, the first pause; `0`, less or `NaN` turns the pause off. */
	constructor(cooldownMs: number) {
		this.#cooldownMs = cooldownMs > 0 ? cooldownMs : 0;
	}

	skip(): RecallSkip | undefined {
		const failure = this.#failure;
		if (!failure || !isWaiting(failure, this.#cooldownMs, Date.now())) return undefined;
		return { failure, retryAt: retryAtAfter(failure, this.#cooldownMs) };
	}

	/**
	 * A failure starts a pause, or a doubled one when the previous pause has ended. A failure
	 * during a running pause changes nothing, and the end of that pause is returned. An
	 * answered recall (`ok`) ends the pause, also one that a conversation reset made stale, so
	 * the next failure starts again at the first pause. An aborted recall has neither and
	 * records nothing.
	 */
	record(outcome: RecallWaitOutcome): number | undefined {
		if (this.#cooldownMs <= 0) return undefined;
		if (outcome.failure === undefined) {
			if (outcome.ok) this.#failure = undefined;
			return undefined;
		}
		const now = Date.now();
		const previous = this.#failure;
		// A recall that was in flight when another failed keeps the running pause.
		const failure: RecallFailure =
			previous && isWaiting(previous, this.#cooldownMs, now)
				? previous
				: { id: ++this.#lastId, at: now, failures: (previous?.failures ?? 0) + 1, error: outcome.failure };
		this.#failure = failure;
		return retryAtAfter(failure, this.#cooldownMs);
	}
}
