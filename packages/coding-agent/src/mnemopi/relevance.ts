import { type AnswerFor, type ChoiceQuestion, judgeQuestions, renderQuestion } from "@oh-my-pi/pi-ai";
import { stripRetentionProtocolMarkers } from "../hindsight/content";
import type { ChainJudge } from "../judgment";
import questionFile from "../prompts/judge/memory-relevance.json" with { type: "json" };

const QUESTION = judgeQuestions(questionFile).relevance;

/** Select whole previews, never generated replacements, regardless of their originating session or store. */
export async function filterRelevantMemories<T extends { content: string }>(
	task: string,
	candidates: readonly T[],
	judge: Pick<ChainJudge, "withCandidate">,
	signal?: AbortSignal,
): Promise<T[]> {
	signal?.throwIfAborted();
	if (!task.trim() || candidates.length === 0) return [];
	const state: Record<string, string> = { task };
	const questions: Record<string, ChoiceQuestion> = {};
	for (const [index, candidate] of candidates.entries()) {
		const key = `candidate_${index}`;
		// Judge the same text that the recall renderer will inject, including clipped previews.
		state[key] = stripRetentionProtocolMarkers(candidate.content) || candidate.content;
		questions[key] = renderQuestion(QUESTION, { candidate: key });
	}
	const options = { signal };
	const answers = await judge.withCandidate(async (candidate, kind) => {
		if (kind !== "local") return (await candidate.judge({ state, questions }, options)).answers;
		// An on-device model answers a few tokens per request, so it gets one question at a time.
		const answered: Record<string, AnswerFor<ChoiceQuestion>> = {};
		for (const key of Object.keys(questions)) {
			const result = await candidate.judge(
				{ state: { task, [key]: state[key] }, questions: { [key]: questions[key] } },
				options,
			);
			answered[key] = result.answers[key];
		}
		return answered;
	}, options);
	signal?.throwIfAborted();
	return candidates.filter((_, index) => {
		const answer = answers[`candidate_${index}`];
		return answer?.type === "choice" && answer.choice === "relevant";
	});
}
