import { type AnswerFor, type ChoiceQuestion, judgeQuestions, renderQuestion } from "@oh-my-pi/pi-ai";
import { stripRetentionProtocolMarkers } from "../hindsight/content";
import type { ChainJudge } from "../judgment";
import questionFile from "../prompts/judge/memory-relevance.json" with { type: "json" };

const QUESTION = judgeQuestions(questionFile).relevance;

export interface RelevanceFilterOptions {
	/** The caller's cancellation: once it fires the judgment throws. */
	signal?: AbortSignal;
	/** Bound on the whole judgment. */
	timeoutMs: number;
	/** Refuse every judge that is not a native judgment backend. */
	nativeOnly?: boolean;
}

/**
 * Asks the judge which `candidates` are relevant to `task` and returns those it answered `relevant`;
 * `irrelevant`, `uncertain` and unanswered candidates are dropped. The judge reads each candidate as given.
 * A batched request that fails or outlives `timeoutMs` throws. An on-device judge is asked one candidate at
 * a time, so at the deadline the candidates it already answered are kept and the rest dropped.
 */
export async function filterRelevantMemories<T extends { content: string }>(
	task: string,
	candidates: readonly T[],
	judge: Pick<ChainJudge, "withCandidate">,
	{ signal, timeoutMs, nativeOnly = false }: RelevanceFilterOptions,
): Promise<T[]> {
	signal?.throwIfAborted();
	if (!task.trim() || candidates.length === 0) return [];
	const state: Record<string, string> = { task };
	const questions: Record<string, ChoiceQuestion> = {};
	for (const [index, candidate] of candidates.entries()) {
		const key = `candidate_${index}`;
		state[key] = stripRetentionProtocolMarkers(candidate.content) || candidate.content;
		questions[key] = renderQuestion(QUESTION, { candidate: key });
	}
	const timeout = AbortSignal.timeout(timeoutMs);
	// Requests stop at the deadline; the chain itself only stops for the caller, so the answers an
	// on-device judge gave before the deadline survive it.
	const request = { signal: signal ? AbortSignal.any([signal, timeout]) : timeout };
	const answers = await judge.withCandidate(
		async (candidate, kind) => {
			if (nativeOnly && kind !== "native") throw new Error("memory relevance: the judge role has no native backend");
			if (kind !== "local") return (await candidate.judge({ state, questions }, request)).answers;
			// An on-device model answers a few tokens per request, so it gets one question at a time.
			const answered: Record<string, AnswerFor<ChoiceQuestion>> = {};
			for (const key of Object.keys(questions)) {
				if (timeout.aborted) break;
				try {
					const result = await candidate.judge(
						{ state: { task, [key]: state[key] }, questions: { [key]: questions[key] } },
						request,
					);
					answered[key] = result.answers[key];
				} catch (error) {
					if (timeout.aborted && !signal?.aborted) break;
					throw error;
				}
			}
			return answered;
		},
		{ signal },
	);
	signal?.throwIfAborted();
	return candidates.filter((_, index) => {
		const answer = answers[`candidate_${index}`];
		return answer?.type === "choice" && answer.choice === "relevant";
	});
}
