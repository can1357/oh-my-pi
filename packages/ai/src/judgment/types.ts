/**
 * Typed judgments: small, structured decisions over a JSON state.
 *
 * A {@link Judge} answers a map of named questions — {@link ChoiceQuestion}
 * (one option from a fixed set), {@link NoulQuestion} (probability that a
 * yes/no condition holds), {@link ScoreQuestion} (position on ordered levels)
 * — about one {@link JudgmentState}. Every question in a request sees the same
 * state and is answered independently, so callers batch independent questions
 * into one call. The shape mirrors TypeSafe's System One API so the native
 * backend ({@link TypeSafeJudge}) forwards requests verbatim, while the text
 * bridge ({@link TextJudge}) renders the same questions into keyword prompts
 * for an ordinary chat model.
 */
import type { Usage } from "../types";

/** JSON-compatible value; readonly containers are accepted so `as const` state passes through. */
export type JsonValue = string | number | boolean | null | readonly JsonValue[] | { readonly [key: string]: JsonValue };

/** The content a request evaluates: plain text, or a named-field object / array for multi-part context. */
export type JudgmentState = string | { readonly [key: string]: JsonValue } | readonly JsonValue[];

/** Pick one option from a fixed set. `criteria` maps option → rubric (`null` when the name suffices). */
export interface ChoiceQuestion<L extends string = string> {
	type: "choice";
	instructions: string;
	criteria: Record<L, string | null>;
}

/** Probability that a yes/no condition holds. `criteria` optionally spells out what yes and no mean. */
export interface NoulQuestion {
	type: "noul";
	instructions: string;
	criteria?: { true?: string; false?: string };
}

/** Position on ordered levels; `criteria` lists at least two level descriptions from lowest to highest. */
export interface ScoreQuestion {
	type: "score";
	instructions: string;
	criteria: readonly [string, string, ...string[]];
}

export type Question = ChoiceQuestion | NoulQuestion | ScoreQuestion;

/** Questions keyed by caller-chosen ids; answers come back under the same ids. */
export type Questions = Record<string, Question>;

export interface ChoiceAnswer<L extends string = string> {
	type: "choice";
	/** Highest-probability option. */
	choice: L;
	/** Every option mapped to its probability (sums to 1). */
	probabilities: Record<L, number>;
	/** Concentration of the distribution, 0–1. */
	confidence: number;
}

export interface NoulAnswer {
	type: "noul";
	/** Probability of yes, 0–1. */
	noul: number;
}

export interface ScoreAnswer {
	type: "score";
	/** Probability-weighted level index; may land between levels. */
	score: number;
	/** Level index (as a string key) mapped to its probability. */
	probabilities: Record<string, number>;
	/** Concentration of the distribution, 0–1. */
	confidence: number;
}

export type Answer = ChoiceAnswer | NoulAnswer | ScoreAnswer;

/** The answer type for a question, preserving choice labels. */
export type AnswerFor<Q extends Question> =
	Q extends ChoiceQuestion<infer L> ? ChoiceAnswer<L> : Q extends NoulQuestion ? NoulAnswer : ScoreAnswer;

export interface JudgmentRequest<Q extends Questions = Questions> {
	state: JudgmentState;
	questions: Q;
}

export interface JudgmentResult<Q extends Questions = Questions> {
	/** Transport that produced the answers (`typesafe`, or the chat model's api). */
	api: string;
	provider: string;
	model: string;
	answers: { [K in keyof Q]: AnswerFor<Q[K]> };
	usage: Usage;
}

export interface JudgeOptions {
	signal?: AbortSignal;
}

/** Answers typed questions about a state. Implementations are stateless and safe to share. */
export interface Judge {
	/** Backend description for logs, e.g. `typesafe/jev-latest`. */
	readonly label: string;
	judge<Q extends Questions>(request: JudgmentRequest<Q>, options?: JudgeOptions): Promise<JudgmentResult<Q>>;
}

/** Thrown when a backend returned output that does not resolve to an answer for every question. */
export class JudgmentParseError extends Error {
	readonly questionId: string;
	readonly output: string;

	constructor(questionId: string, output: string, detail: string) {
		super(`judgment "${questionId}": ${detail}: ${JSON.stringify(output)}`);
		this.name = "JudgmentParseError";
		this.questionId = questionId;
		this.output = output;
	}
}

/**
 * Usage from a backend that reports token counts and, optionally, one billed
 * USD amount. Judgment pricing is input-only, so the amount lands on `input`.
 */
export function tokenUsage(input: number, output: number, cost = 0): Usage {
	return {
		input,
		output,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: input + output,
		cost: { input: cost, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
	};
}
