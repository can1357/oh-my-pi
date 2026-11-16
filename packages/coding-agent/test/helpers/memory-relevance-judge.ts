import { type Judge, type JudgmentResult, tokenUsage } from "@oh-my-pi/pi-ai";
import type { ChainJudge, JudgeKind } from "@oh-my-pi/pi-coding-agent/judgment";

/** Present `judge` as the judge-role chain's only candidate, of `kind`. */
export function judgeChain(judge: Judge, kind: JudgeKind = "native"): Pick<ChainJudge, "withCandidate"> {
	return { withCandidate: (run, _options) => run(judge, kind) };
}

/** A memory-relevance judge that records how many memories each request asked about. */
export interface MemoryRelevanceJudgeFixture extends Judge, Pick<ChainJudge, "withCandidate"> {
	readonly requests: number[];
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
			const state = request.state as Record<string, string>;
			requests.push(Object.keys(request.questions).length);
			const answers = Object.fromEntries(
				Object.keys(request.questions).map(key => {
					const choice = decide(state[key]);
					return [key, { type: "choice", choice, confidence: 1, probabilities: { [choice]: 1 } }];
				}),
			);
			return {
				api: "test",
				provider: "test",
				model: "test",
				usage: tokenUsage(0, 0),
				answers: answers as JudgmentResult<typeof request.questions>["answers"],
			};
		},
	};
	return { ...judge, requests, ...judgeChain(judge, kind) };
}
