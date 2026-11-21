/**
 * Jev-scored turn retention for session rebuilds (`FreshStart` in `fresh.ts`): TypeSafe
 * Jev answers, per older turn, the probability that the agent still needs it
 * verbatim in context (question in `prompts/judge/compaction-keep.json`).
 */
import { createNativeJudge, judgeQuestions } from "@oh-my-pi/pi-ai/judgment";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import type { KeepScorer } from "./fresh";
import keepQuestions from "./prompts/judge/compaction-keep.json" with { type: "json" };

const CONCURRENCY = 16;
const ATTEMPTS = 3;

/**
 * A {@link KeepScorer} backed by TypeSafe Jev's native judgment API.
 * A turn whose judgment fails {@link ATTEMPTS} times scores 0 (archived) and is
 * counted in the log line; the rebuild never fails on judge errors.
 */
export function jevKeepScorer(opts: { apiKey: string; model: string; log: (line: string) => void }): KeepScorer {
	const judge = createNativeJudge(getBundledModel("typesafe", opts.model), { apiKey: opts.apiKey });
	const questions = judgeQuestions(keepQuestions);
	return async (candidates, context) => {
		const started = performance.now();
		const probabilities = Array.from({ length: candidates.length }, () => 0);
		let failures = 0;
		let next = 0;
		const worker = async (): Promise<void> => {
			while (next < candidates.length) {
				const index = next++;
				const state = { task: context.task, recent: context.recent, turn: candidates[index]!.digest };
				for (let attempt = 1; ; attempt++) {
					try {
						probabilities[index] = (await judge.judge({ state, questions })).answers.keep.noul;
						break;
					} catch (error) {
						if (attempt < ATTEMPTS) continue;
						failures++;
						opts.log(`jev judgment failed: ${error instanceof Error ? error.message : String(error)}`);
						break;
					}
				}
			}
		};
		await Promise.all(Array.from({ length: Math.min(CONCURRENCY, candidates.length) }, worker));
		const likely = probabilities.filter(probability => probability >= 0.5).length;
		opts.log(
			`jev scored ${candidates.length} turns in ${Math.round(performance.now() - started)}ms: ${likely} ≥0.5, ${failures} failed`,
		);
		return probabilities;
	};
}
