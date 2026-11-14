/**
 * A {@link Scorer} that ranks shaped tool output with the session's `judge` role instead of Spotlight.
 *
 * Spotlight scores a whole output in one listwise request. A judge answers one question per state, so the items are
 * split into chunks and each chunk becomes one `noul` question per line over a state that carries the lines, the
 * call's context, and the relevance rubric. `noul` probabilities are absolute, so chunks are comparable with each
 * other and the merged ranking needs no rescaling.
 *
 * The chunk size is measured, not tuned here: 48 lines per request keeps the relevant lines at the top, while 96
 * flattens every score to the same prior on a 900-line read.
 */
import type { JsonValue, Judge, NoulQuestion } from "@oh-my-pi/pi-ai";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { judgeQuestions, renderQuestion } from "@oh-my-pi/pi-ai";
import type { SpotlightRequestParams } from "@oh-my-pi/pi-tui/chat/spotlight";
import { logger } from "@oh-my-pi/pi-utils";
import questionFile from "../prompts/judge/shape.json" with { type: "json" };
import type { JudgeDeps } from "../judgment";
import { journalJudgmentUsage, resolveJudge } from "../judgment";
import { sharedJudgmentCache } from "../judgment/cache";

import type { CallContext, Scorer, ScorerUsage } from "./types";

/** The one template this scorer sends; its rubric rides in the state's `criteria`. */
const QUESTIONS = judgeQuestions(questionFile);

/** Items one judge request ranks: 48 keeps a cut sharp, 96 scores every line the same. */
export const JUDGE_CHUNK_ITEMS = 48;
/** Judge requests in flight for one result; a chunk is independent of its siblings. */
const JUDGE_IN_FLIGHT = 8;

/** Question key of the `i`th item of a chunk. */
export function lineKey(i: number): string {
	return `l${String(i).padStart(2, "0")}`;
}

/** State and questions of one chunk: the lines keyed by {@link lineKey}, judged against the call's context. */
export function lineBatch(
	ctx: CallContext,
	lines: readonly string[],
): {
	state: { readonly [key: string]: JsonValue };
	questions: Record<string, NoulQuestion>;
} {
	const byKey: Record<string, string> = {};
	const questions: Record<string, NoulQuestion> = {};
	lines.forEach((line, i) => {
		const key = lineKey(i);
		byKey[key] = line;
		questions[key] = renderQuestion(QUESTIONS.line, { key });
	});
	return {
		state: {
			commands: [...ctx.commands],
			intent: ctx.intent,
			lines: byKey,
			said: ctx.said,
			source: ctx.source,
			task: ctx.task,
		},
		questions,
	};
}

/**
 * A {@link Scorer} over one judge for one tool result: ranks every item's relevance, splits items that would
 * overflow one request into chunks of {@link JUDGE_CHUNK_ITEMS}, and records what it spent and what failed.
 */
export class JudgeScorer implements Scorer {
	readonly usage: ScorerUsage = { calls: 0, failures: 0, ms: 0, tokens: 0, costUsd: 0 };
	/** Left unset: no Spotlight request happened, so the trace names none. */
	readonly params: SpotlightRequestParams | undefined = undefined;
	readonly #judge: Pick<Judge, "judge"> | undefined;
	readonly #budgetMs: number;

	constructor(judge: Pick<Judge, "judge"> | undefined, budgetMs: number) {
		this.#judge = judge;
		this.#budgetMs = budgetMs;
	}

	async score(items: readonly string[], ctx: CallContext, signal?: AbortSignal): Promise<number[] | null> {
		if (items.length === 0) return [];
		const judge = this.#judge;
		if (!judge) {
			this.#fail("no_judge", undefined);
			return null;
		}
		const started = performance.now();
		const deadline = AbortSignal.timeout(this.#budgetMs);
		const budget = signal ? AbortSignal.any([signal, deadline]) : deadline;
		const chunks: (readonly string[])[] = [];
		for (let start = 0; start < items.length; start += JUDGE_CHUNK_ITEMS) {
			chunks.push(items.slice(start, start + JUDGE_CHUNK_ITEMS));
		}
		const scores: number[][] = chunks.map(() => []);
		let failure: { cause: string; error: unknown } | undefined;
		let next = 0;
		const worker = async (): Promise<void> => {
			for (;;) {
				const index = next++;
				const lines = chunks[index];
				if (lines === undefined || failure) return;
				this.usage.calls++;
				try {
					const { state, questions } = lineBatch(ctx, lines);
					const result = await judge.judge({ state, questions }, { signal: budget });
					scores[index] = lines.map((_, i) => {
						const answer = result.answers[lineKey(i)];
						const value = answer.type === "noul" ? answer.noul : Number.NaN;
						if (!Number.isFinite(value) || value < 0 || value > 1) throw new BadAnswerError(lineKey(i));
						return value;
					});
					this.usage.tokens += result.usage.input;
					this.usage.costUsd += result.usage.cost.total;
				} catch (error) {
					failure ??= { cause: causeOf(error, deadline, signal), error };
					return;
				}
			}
		};
		await Promise.all(Array.from({ length: Math.min(JUDGE_IN_FLIGHT, chunks.length) }, worker));
		this.usage.ms += Math.round(performance.now() - started);
		if (failure) {
			this.#fail(failure.cause, failure.error);
			// The caller's own cancellation is not a ranking failure: let it end the tool call.
			if (signal?.aborted) throw failure.error;
			return null;
		}
		return scores.flat();
	}

	/** Records one failed ranking and the cause the journal reports. */
	#fail(cause: string, error: unknown): void {
		this.usage.failures++;
		this.usage.failureCauses ??= {};
		this.usage.failureCauses[cause] = (this.usage.failureCauses[cause] ?? 0) + 1;
		logger.debug("spotlight: judge ranking failed", {
			cause,
			error: error instanceof Error ? error.message : String(error),
		});
	}
}

/** A judge reply that did not answer a line as a `noul` in [0, 1]. */
class BadAnswerError extends Error {
	constructor(key: string) {
		super(`judge did not answer ${key} as a noul in [0, 1]`);
		this.name = "BadAnswerError";
	}
}

/** Why one chunk failed, as `spotlight:shape` journals it. */
function causeOf(error: unknown, deadline: AbortSignal, signal?: AbortSignal): string {
	if (error instanceof BadAnswerError) return "bad_reply";
	if (deadline.aborted && !signal?.aborted) return "timeout";
	if (error instanceof AIError.ConfigurationError) return "refused";
	if (signal?.aborted) return "cancelled";
	return "provider";
}

/**
 * The judge this session ranks with, or undefined when the `judge` role has no native candidate (or the session has
 * no model registry): shaping then falls back to its unranked rules rather than reporting a score-free result.
 */
export function judgeScorerFor(
	session: {
		settings: JudgeDeps["settings"];
		modelRegistry?: JudgeDeps["registry"];
		getSessionId?: () => string | null;
		getActiveModel?: () => JudgeDeps["sessionModel"];
		getTelemetry?: () => JudgeDeps["telemetry"];
		costGate?: JudgeDeps["costGate"];
		sessionManager?: Parameters<typeof journalJudgmentUsage>[0];
	},
	budgetMs: number,
	purpose = "spotlight",
): JudgeScorer {
	const registry = session.modelRegistry;
	if (!registry) return new JudgeScorer(undefined, budgetMs);
	const deps: JudgeDeps = {
		settings: session.settings,
		registry,
		sessionModel: session.getActiveModel?.(),
		sessionId: session.getSessionId?.() ?? undefined,
		purpose,
		onUsage: journalJudgmentUsage(session.sessionManager),
		telemetry: session.getTelemetry?.(),
		costGate: session.costGate,
		cache: sharedJudgmentCache(),
	};
	return new JudgeScorer(resolveJudge(deps), budgetMs);
}
