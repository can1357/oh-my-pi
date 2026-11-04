/**
 * Title drift detection: one yes/no judge question whether a session's
 * generated title still names its recent conversation, so a
 * `title.refreshAfterPrompts` check regenerates only a title the session has
 * moved away from.
 */
import { type Judge, judgeQuestions } from "@oh-my-pi/pi-ai";
import { logger } from "@oh-my-pi/pi-utils";
import questionFile from "../prompts/judge/title-drift.json" with { type: "json" };
import { splitCardTitle } from "../utils/title-card";
import type { TitleDriftTurn } from "./messages";

/**
 * Yes-probability below which a title no longer fits its conversation. Tuned on
 * 205 title and conversation checkpoints from real sessions, labeled fits or
 * stale by a larger chat model: `typesafe/jev-1.14.0` separated them with ROC
 * AUC 0.95, and below 0.5, 89% of the titles it flagged were stale and it caught
 * 74% of stale titles. Higher cutoffs caught more stale titles but flagged
 * fitting ones. Keyword judges answer exactly 0 or 1.
 */
const TITLE_FITS_THRESHOLD = 0.5;

const QUESTIONS = judgeQuestions(questionFile);

/** `true` when `title` no longer fits `recent`, `false` when it does, `undefined` when no judge answered. */
export async function classifyTitleDrift(
	judge: Judge,
	title: string,
	recent: TitleDriftTurn[],
	signal?: AbortSignal,
): Promise<boolean | undefined> {
	try {
		// The card is how the terminal indexes the session, not what it works on.
		const state = { title: splitCardTitle(title)?.title ?? title, recent };
		const { answers } = await judge.judge({ state, questions: { fits: QUESTIONS.fits } }, { signal });
		return answers.fits.noul < TITLE_FITS_THRESHOLD;
	} catch (error) {
		logger.debug("title-drift: classification failed", {
			error: error instanceof Error ? error.message : String(error),
		});
		return undefined;
	}
}
