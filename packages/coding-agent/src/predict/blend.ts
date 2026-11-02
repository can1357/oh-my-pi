/**
 * The `smollm` setting's ghost text: SmolLM's pick blended with n-gram's.
 *
 * Each engine's word scores its weighted confidence, plus the other engine's
 * weighted confidence when both picked the same word; the higher score wins
 * and shows at or above {@link SHOW_THRESHOLD}. On a replay of 400 held-out
 * prompts (see `pi_predict::ngram` docs) the blend saved 39.6 % of keystrokes
 * against SmolLM's 37.7 % and n-gram's 32.4 %, at a similar wrong-ghost rate.
 * Without SmolLM (weights still downloading, or it failed to load) the blend
 * degrades to n-gram at a ~0.17 threshold.
 */
import type { PredictedWord } from "@oh-my-pi/pi-natives";

/** N-gram's share of the blend; SmolLM gets the rest. */
const NGRAM_WEIGHT = 0.3;
/** Minimum blended score to show a ghost. */
const SHOW_THRESHOLD = 0.05;

/** Blend both engines' answers for one query; `null` shows nothing. */
export function blendPredictions(ngram: PredictedWord | null, smollm: PredictedWord | null): PredictedWord | null {
	const agree = ngram && smollm && ngram.suffix.toLowerCase() === smollm.suffix.toLowerCase();
	const shared = agree ? NGRAM_WEIGHT * ngram.confidence + (1 - NGRAM_WEIGHT) * smollm.confidence : 0;
	const ngramScore = agree ? shared : ngram ? NGRAM_WEIGHT * ngram.confidence : 0;
	const smollmScore = agree ? shared : smollm ? (1 - NGRAM_WEIGHT) * smollm.confidence : 0;
	const pick = ngramScore >= smollmScore ? ngram : smollm;
	const confidence = Math.max(ngramScore, smollmScore);
	return pick && confidence >= SHOW_THRESHOLD ? { suffix: pick.suffix, confidence } : null;
}
