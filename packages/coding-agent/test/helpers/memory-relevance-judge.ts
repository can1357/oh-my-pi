import {
	type AnswerFor,
	type ChoiceAnswer,
	type Judge,
	type JsonValue,
	type JudgmentState,
	type Questions,
	tokenUsage,
} from "@oh-my-pi/pi-ai";
import type { ChainJudge, JudgeKind } from "@oh-my-pi/pi-coding-agent/judgment";

/** Present `judge` as the judge-role chain's only candidate, of `kind`. */
export function judgeChain(judge: Judge, kind: JudgeKind = "native"): Pick<ChainJudge, "withCandidate"> {
	return { withCandidate: (run, _options) => run(judge, kind) };
}

/** A memory-relevance judge that records how many memories each request asked about. */
export interface MemoryRelevanceJudgeFixture extends Judge, Pick<ChainJudge, "withCandidate"> {
	readonly requests: number[];
}

/** Whether `answers` answers every one of `questions`, each a choice question offering the chosen label. */
function answersEvery<Q extends Questions>(
	questions: Q,
	answers: Record<string, ChoiceAnswer>,
): answers is Record<string, ChoiceAnswer> & { [K in keyof Q]: AnswerFor<Q[K]> } {
	for (const key in questions) {
		const question = questions[key];
		const answer = answers[key];
		if (question.type !== "choice" || answer === undefined || !Object.hasOwn(question.criteria, answer.choice)) {
			return false;
		}
	}
	return true;
}

/** `Array.isArray` narrowing that also covers readonly arrays. */
function isList(state: JudgmentState): state is readonly JsonValue[] {
	return Array.isArray(state);
}

/** The candidate text the request's state carries under `key`. */
function candidateText(state: JudgmentState, key: string): string {
	const text = typeof state === "object" && !isList(state) ? state[key] : undefined;
	if (typeof text !== "string") throw new Error(`memory-relevance fixture: no candidate text for ${key}`);
	return text;
}

/**
 * Control relevance decisions while lifecycle tests exercise real memory stores and session journals.
 * Usable as the chain itself (reporting a `kind` candidate) or, through `judge`, inside a wrapping judge.
 */
export function memoryRelevanceJudge(
	decide: (preview: string) => "relevant" | "irrelevant" | "uncertain" = () => "relevant",
	kind: JudgeKind = "native",
): MemoryRelevanceJudgeFixture {
	const requests: number[] = [];
	const judge: Judge = {
		label: "memory-relevance-fixture",
		async judge(request) {
			requests.push(Object.keys(request.questions).length);
			const answers: Record<string, ChoiceAnswer> = {};
			for (const key in request.questions) {
				const choice = decide(candidateText(request.state, key));
				answers[key] = { type: "choice", choice, confidence: 1, probabilities: { [choice]: 1 } };
			}
			if (!answersEvery(request.questions, answers)) {
				throw new Error("memory-relevance fixture: asked something other than a memory-relevance choice");
			}
			return { api: "test", provider: "test", model: "test", usage: tokenUsage(0, 0), answers };
		},
	};
	return { ...judge, requests, ...judgeChain(judge, kind) };
}
