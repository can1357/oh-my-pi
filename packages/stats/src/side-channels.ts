/**
 * Classification of the model calls stored in `messages`, for attributing usage.
 *
 * - A **turn** is an assistant message (stored with a NULL purpose), or the
 *   billed usage of a discarded assistant turn, which the session journals as
 *   a `model_usage` entry with purpose `discarded-turn`.
 * - A **side channel** is every other `model_usage` entry: a model call that
 *   is not part of the conversation (title generation, job captions, judge
 *   queries, …). Its category groups the purposes of one use case.
 * - A side channel runs on a **decision model** when its api answers
 *   judgments natively instead of generating text.
 *
 * The purposes are written by the coding agent, which stats never imports, so
 * the table lives here. Rows and rollups store the raw purpose and api and
 * everything below is derived at read time: the table applies to entries
 * already ingested and can be re-cut without re-ingesting.
 */

import { isJudgmentApi } from "@oh-my-pi/pi-ai";

/** Purpose of the `model_usage` entry carrying the billed usage of a discarded assistant turn. */
const DISCARDED_TURN_PURPOSE = "discarded-turn";

/** Side-channel categories and the purposes each covers. A purpose listed nowhere is its own category. */
const SIDE_CHANNEL_CATEGORIES: Record<string, readonly string[]> = {
	title: ["title", "title-fork", "title-drift"],
	progress: ["job-widget", "job-caption", "task-completion-probe"],
	judge: ["judge", "judge_batch"],
	find: ["find"],
	thinking: ["auto-thinking"],
	visualization: ["auto-graph"],
	workflow: ["auto-prewalk", "auto-parallel", "unexpected-stop"],
	memory: ["memory", "memory-relevance"],
	rules: ["ttsr"],
	composer: ["composer-prediction"],
	cache: ["cache-warm"],
};

const CATEGORY_BY_PURPOSE = new Map<string, string>();
for (const category in SIDE_CHANNEL_CATEGORIES) {
	for (const purpose of SIDE_CHANNEL_CATEGORIES[category]) CATEGORY_BY_PURPOSE.set(purpose, category);
}

/**
 * Side-channel category of a row from its stored `purpose`, or `null` when the
 * row is a turn. A `:detail` suffix belongs to its base purpose
 * (`cache-warm:extension-override` is `cache-warm`).
 */
export function sideChannelCategory(purpose: string | null): string | null {
	if (purpose === null) return null;
	const detail = purpose.indexOf(":");
	const base = detail > 0 ? purpose.slice(0, detail) : purpose;
	if (base === DISCARDED_TURN_PURPOSE) return null;
	return CATEGORY_BY_PURPOSE.get(base) ?? base;
}

/**
 * Whether a side-channel row with this stored `api` ran on a decision model.
 * Decided by the api alone, never by model or provider ids.
 */
export function isDecisionModelApi(api: string): boolean {
	return isJudgmentApi(api);
}
