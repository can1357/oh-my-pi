/**
 * Spotlight-ranked turn retention for session rebuilds (`FreshStart` in `fresh.ts`).
 *
 * One Stencil Spotlight request ranks every candidate turn's brief under each probe in
 * `prompts/spotlight-keep.json` (unresolved failures, observed reference behavior, live
 * decisions, code still changing); a turn's score is its best probe score. Scores are
 * comparable only within one request, so the rebuild keeps turns by rank within its budget
 * rather than by an absolute threshold. Credential: `STENCIL_API_KEY` or the stencil.so login.
 */
import { SpotlightClient } from "@oh-my-pi/pi-coding-agent/spotlight/client";
import { BRIEF_CHARS, type KeepScorer } from "./fresh";
import probes from "./prompts/spotlight-keep.json" with { type: "json" };

/** Spotlight's per-question prompt cap is 32,768 tokens; stay well under it for the item briefs. */
const ITEMS_CHAR_BUDGET = 80_000;
const TIMEOUT_MS = 120_000;

/**
 * A {@link KeepScorer} backed by Stencil Spotlight. Throws (failing the rebuild) when the request
 * fails, since without scores there is no selection to make.
 */
export function spotlightKeepScorer(opts: { log: (line: string) => void }): KeepScorer {
	return async (candidates, context) => {
		const client = new SpotlightClient({ timeoutMs: TIMEOUT_MS });
		try {
			const perItem = Math.min(BRIEF_CHARS, Math.floor(ITEMS_CHAR_BUDGET / Math.max(1, candidates.length)));
			const reply = await client.rank({
				state: { task: context.task, intent: context.recent.slice(-3_000) },
				source: "earlier turns of this coding agent session (tool calls, notes, and outputs), oldest first",
				items: candidates.map((candidate, index) => `t${index + 1}: ${candidate.brief.slice(0, perItem)}`),
				questions: probes,
			});
			const scores = candidates.map((_, index) => {
				let best = 0;
				for (const id in reply.scores) best = Math.max(best, reply.scores[id]![index] ?? 0);
				return best;
			});
			opts.log(
				`spotlight ranked ${candidates.length} turns in ${reply.ms}ms (${reply.inputTokens} tokens, $${reply.costUsd.toFixed(5)})`,
			);
			return scores;
		} finally {
			await client.close();
		}
	};
}
