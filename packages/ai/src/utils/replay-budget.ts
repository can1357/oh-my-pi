import type { AssistantMessage } from "../types";

/**
 * One streaming call's {@link StreamOptions.replayBudgetMs}: decides whether a
 * replay may begin, and remembers a refusal so the result can report it.
 *
 * Measured on the monotonic clock from construction, which every provider does
 * at the start of its call. A nested call (the replay-safe wrapper's attempt)
 * gets its own instance built from {@link remainingMs}, so the two share one
 * deadline.
 */
export class ReplayBudget {
	readonly #deadline: number;
	#refused = false;

	constructor(budgetMs: number) {
		this.#deadline = performance.now() + budgetMs;
	}

	/**
	 * The budget for `budgetMs`, or `undefined` when it is unset or infinite —
	 * which keeps the provider's own ceiling, with no budget consulted at all.
	 * Negative and `NaN` values refuse every replay.
	 */
	static from(budgetMs: number | undefined): ReplayBudget | undefined {
		if (budgetMs === undefined || budgetMs === Number.POSITIVE_INFINITY) return undefined;
		return new ReplayBudget(budgetMs > 0 ? budgetMs : 0);
	}

	/**
	 * Whether a replay that starts after waiting `delayMs` begins inside the
	 * budget. A refusal latches: every later replay in the call is refused too.
	 * Bound, so it can be handed to `fetchWithRetry` as its `retryGate`.
	 */
	readonly admits = (delayMs: number): boolean => {
		if (!this.#refused && performance.now() + delayMs < this.#deadline) return true;
		this.#refused = true;
		return false;
	};

	/** Milliseconds a nested call may still begin replays in; `0` once refused or spent. */
	remainingMs(): number {
		return this.#refused ? 0 : Math.max(0, this.#deadline - performance.now());
	}

	/** Marks `message` as the result of a refused replay, when one was refused. */
	stamp(message: AssistantMessage): void {
		if (this.#refused) message.replayBudgetExhausted = true;
	}
}

/** `true` when no budget governs the call, otherwise whether `budget` admits a replay after `delayMs`. */
export function admitsReplay(budget: ReplayBudget | undefined, delayMs: number): boolean {
	return budget === undefined || budget.admits(delayMs);
}
