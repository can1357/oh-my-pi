import type { AssistantMessage } from "@oh-my-pi/pi-ai";

/**
 * Prompt→yield wall time for a turn, from pure local timestamps: the user
 * prompt's timestamp to the response's completion time (`completedAt`, stamped
 * by the session at `message_end`). No provider-reported duration is involved —
 * messages persisted before the stamp existed simply have no span.
 * Undefined when either end is unknown (mid-attach or unstamped message).
 */
export function turnElapsedMs(
	turnStartedAt: number | undefined,
	message: { completedAt?: number },
): number | undefined {
	if (turnStartedAt === undefined || message.completedAt === undefined) return undefined;
	const elapsed = message.completedAt - turnStartedAt;
	return elapsed > 0 ? Math.round(elapsed) : undefined;
}

/** A finished turn's totals, the native `omp.turn.usage` line under its last answer. */
export interface TurnUsageSummary {
	/** Prompt→yield wall time; undefined when either end is unknown. */
	readonly elapsedMs: number | undefined;
	/**
	 * Prompt tokens: input, cache writes and orchestration input. Cache reads
	 * re-read the context each request, so they stay out (as in the status
	 * line's total).
	 */
	readonly input: number;
	/** Output tokens, orchestration output included. */
	readonly output: number;
	/** Billed cost in dollars. */
	readonly cost: number;
}

/**
 * Sums the requests of a turn. {@link add} returns the turn's summary on the
 * message that ends the run (any stop but `toolUse`) and starts over.
 */
export class TurnUsageTally {
	#input = 0;
	#output = 0;
	#cost = 0;

	/** Drop a partial turn (a new prompt, a fresh run). */
	reset(): void {
		this.#input = 0;
		this.#output = 0;
		this.#cost = 0;
	}

	add(message: AssistantMessage, turnStartedAt: number | undefined): TurnUsageSummary | undefined {
		const { usage } = message;
		this.#input += usage.input + usage.cacheWrite + (usage.orchestration?.input ?? 0);
		this.#output += usage.output + (usage.orchestration?.output ?? 0);
		this.#cost += usage.cost.total;
		if (message.stopReason === "toolUse") return undefined;
		const summary =
			this.#input + this.#output > 0 || this.#cost > 0
				? {
						elapsedMs: turnElapsedMs(turnStartedAt, message),
						input: this.#input,
						output: this.#output,
						cost: this.#cost,
					}
				: undefined;
		this.reset();
		return summary;
	}
}
