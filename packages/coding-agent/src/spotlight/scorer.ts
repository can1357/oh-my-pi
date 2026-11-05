import type { SpotlightRequestParams } from "@oh-my-pi/pi-tui/chat/spotlight";
import { logger } from "@oh-my-pi/pi-utils";
import type { SpotlightClient, SpotlightRequest } from "./client";
import { SpotlightError } from "./client";
import { SHAPE_PROBE } from "./shape";
import type { CallContext, Scorer, SpotlightThinking } from "./types";

/** Prompt tokens one request may spend on its items; Spotlight takes ≤32,768 per question, state included. */
const REQUEST_ITEM_TOKENS = 28_000;
/** Conservative chars per token for code and logs (prose runs ~4). */
const CHARS_PER_TOKEN = 3;
/** Tokens Spotlight spends framing each item. */
const ITEM_OVERHEAD_TOKENS = 2;
/** Request bodies stay under Spotlight's 1 MiB cap with room for JSON escaping. */
const REQUEST_BODY_CHARS = 512 * 1024;

/** The score-free coin's scorer: answers null without asking Spotlight, so the no-score rules decide the cut. */
export const SCORE_FREE_SCORER: Scorer = { scoreFree: true, score: async () => null };

/** What a {@link RecordingScorer} spent, for the session journal. */
export interface ScorerUsage {
	/** Requests sent. */
	calls: number;
	/** Requests that failed (no credential, timeout, HTTP error); the caller fell back to unranked rules. */
	failures: number;
	/** Wall time of the requests, summed. */
	ms: number;
	/** Prompt tokens Spotlight billed. */
	tokens: number;
	costUsd: number;
}

/**
 * A {@link Scorer} over {@link SpotlightClient} for one tool result: scores every item's relevance, splits
 * items that would overflow one request's token or body cap into several requests, and records what it spent and
 * what it asked.
 */
export class RecordingScorer implements Scorer {
	readonly usage: ScorerUsage = { calls: 0, failures: 0, ms: 0, tokens: 0, costUsd: 0 };
	/** What its requests sent besides the items (the same for every request of one result); unset until one is sent. */
	params: SpotlightRequestParams | undefined;
	readonly #client: SpotlightClient;
	readonly #thinking: SpotlightThinking;

	constructor(client: SpotlightClient, thinking: SpotlightThinking) {
		this.#client = client;
		this.#thinking = thinking;
	}

	async score(items: readonly string[], ctx: CallContext, signal?: AbortSignal): Promise<number[] | null> {
		if (items.length === 0) return [];
		const state = { task: ctx.task, commands: ctx.commands, said: ctx.said, intent: ctx.intent };
		this.params ??= {
			...state,
			source: ctx.source,
			probe: SHAPE_PROBE,
			model: this.#client.model,
			thinking: this.#thinking,
		};
		const stateChars = ctx.task.length + ctx.said.length + ctx.intent.length + ctx.source.length;
		const itemChars = Math.max(
			CHARS_PER_TOKEN * 256,
			Math.min(REQUEST_ITEM_TOKENS * CHARS_PER_TOKEN, REQUEST_BODY_CHARS) -
				stateChars -
				ctx.commands.join("").length,
		);
		const batches: string[][] = [];
		let batch: string[] = [];
		let batchChars = 0;
		for (const raw of items) {
			const item = raw.length > itemChars ? raw.slice(0, itemChars) : raw;
			const cost = item.length + ITEM_OVERHEAD_TOKENS * CHARS_PER_TOKEN;
			if (batch.length > 0 && batchChars + cost > itemChars) {
				batches.push(batch);
				batch = [];
				batchChars = 0;
			}
			batch.push(item);
			batchChars += cost;
		}
		batches.push(batch);

		const replies = await Promise.all(
			batches.map(async batchItems => {
				const request: SpotlightRequest = {
					state,
					source: ctx.source,
					items: batchItems,
					questions: { line: SHAPE_PROBE },
					thinking: this.#thinking,
				};
				this.usage.calls++;
				try {
					const reply = await this.#client.rank(request, signal);
					this.usage.ms += reply.ms;
					this.usage.tokens += reply.inputTokens;
					this.usage.costUsd += reply.costUsd;
					return reply.scores.line;
				} catch (error) {
					if (!(error instanceof SpotlightError)) throw error;
					this.usage.failures++;
					logger.debug("spotlight ranking failed", {
						status: error.status,
						code: error.code,
						error: error.message,
					});
					// After a timeout or transport failure, wake the endpoint for the next call.
					if (error.status === 0 && error.code !== "no_credential" && !signal?.aborted) this.#client.warm();
					return null;
				}
			}),
		);
		const scores: number[] = [];
		for (const reply of replies) {
			if (!reply) return null;
			scores.push(...reply);
		}
		return scores;
	}
}
