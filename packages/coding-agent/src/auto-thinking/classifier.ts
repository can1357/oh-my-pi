/**
 * Per-prompt difficulty classifier for the `auto` thinking level.
 *
 * Asks one {@link ChoiceQuestion} about the user's request and maps the
 * chosen level to a concrete {@link Effort}, clamped into the active model's
 * supported range (never below {@link Effort.Low}). The judge comes from the
 * live `judge` role chain. A local on-device candidate gets the coarser
 * `trivial|moderate|hard` question (3-class is more reliable
 * than 4-way ordinal on sub-2B models), mapped to `low|high|xhigh`.
 *
 * Throws on any failure (no judge, no key, unparseable output, abort/timeout);
 * the caller falls back to a concrete level and continues the turn.
 */
import { type ChoiceQuestion, Effort, type Model } from "@oh-my-pi/pi-ai";
import { getSupportedEfforts } from "@oh-my-pi/pi-catalog/model-thinking";
import type { ModelRegistry } from "../config/model-registry";
import bucketQuestionInstructions from "../prompts/system/auto-thinking-bucket-question.md" with { type: "text" };
import type { Settings } from "../config/settings";
import { type JudgmentUsage, resolveJudge } from "../judgment";
import { clampAutoThinkingEffort } from "@oh-my-pi/pi-tui/thinking";
import { preprocessTinyMessage } from "../tiny/message-preproc";

type Level = "low" | "medium" | "high" | "xhigh" | "max";
type Bucket = "trivial" | "moderate" | "hard";

const LEVEL_EFFORT: Record<Level, Effort> = {
	low: Effort.Low,
	medium: Effort.Medium,
	high: Effort.High,
	xhigh: Effort.XHigh,
	max: Effort.Max,
};

const BUCKET_EFFORT: Record<Bucket, Effort> = {
	trivial: Effort.Low,
	moderate: Effort.High,
	hard: Effort.XHigh,
};

const LEVEL_CRITERIA: Record<Exclude<Level, "max">, string> = {
	low: "Trivial or mechanical: rename, typo, one-line edit, formatting tweak, direct factual question, obvious solution.",
	medium:
		"Localized change needing reasoning: small self-contained feature, straightforward one-place bug fix, explain moderate code.",
	high: "Non-trivial: multiple files or callers, real debugging, moderate design decision, refactor with several moving parts.",
	xhigh: "Deep or open-ended: subtle concurrency or algorithmic problem, cross-system reasoning, ambiguous requirements, large or risky refactor, hard root-cause debugging.",
};

const MAX_CRITERION =
	"Meets xhigh and at least one of: no reproduction to work from, irreversible or data-loss operation, or a live cutover that must stay correct while running. xhigh is required; difficulty alone is insufficient.";

/** Full-ladder question up to `xhigh`. */
const LEVEL_QUESTION: ChoiceQuestion<Exclude<Level, "max">> = {
	type: "choice",
	instructions:
		"The state is a user's request to a coding agent. Choose the reasoning effort this turn needs, judging inherent task difficulty rather than phrasing politeness or verbosity. If torn between levels, choose the lower one.",
	criteria: LEVEL_CRITERIA,
};

/** Full-ladder question offering `max`; used only when the target model exposes that tier. */
const LEVEL_QUESTION_WITH_MAX: ChoiceQuestion<Level> = {
	type: "choice",
	instructions:
		"The state is a user's request to a coding agent. Choose the reasoning effort this turn needs, judging inherent task difficulty rather than phrasing politeness or verbosity. If torn between levels, choose the lower one, except between xhigh and max: a request meeting the max conditions takes max.",
	criteria: { ...LEVEL_CRITERIA, max: MAX_CRITERION },
};

/** Coarse 3-bucket question for on-device models. */
const BUCKET_QUESTION: ChoiceQuestion<Bucket> = {
	type: "choice",
	instructions: bucketQuestionInstructions,
	criteria: {
		trivial: "Obvious, mechanical, or a direct question: rename, typo, one-liner, simple lookup.",
		moderate: "A real localized task: small feature, normal bug fix, code explanation.",
		hard: "Deep, multi-file, ambiguous, or tricky debugging or design.",
	},
};

export interface ClassifyDifficultyDeps {
	settings: Settings;
	registry: ModelRegistry;
	model: Model;
	sessionId?: string;
	signal?: AbortSignal;
	metadataResolver?: (provider: string) => Record<string, unknown> | undefined;
	onUsage?: (usage: JudgmentUsage) => void;
}

/**
 * Highest effort this turn's classification may resolve to: the configured
 * ceiling, further limited by what the target model actually exposes. The
 * default keeps `auto` one tier below the top, so only an explicit
 * `ultrathink` reaches {@link Effort.Max}.
 */
function autoEffortCeiling(deps: ClassifyDifficultyDeps): Effort {
	if (deps.settings.get("providers.autoThinkingMaxEffort") !== Effort.Max) return Effort.XHigh;
	return getSupportedEfforts(deps.model).includes(Effort.Max) ? Effort.Max : Effort.XHigh;
}

/**
 * Classify `promptText` and return a concrete effort clamped to `deps.model`,
 * or `undefined` when the model has no controllable effort surface (auto has
 * nothing to pick — the caller leaves the prior reasoning level in place).
 * @throws when the backend cannot produce a usable classification.
 */
export async function classifyDifficulty(
	promptText: string,
	deps: ClassifyDifficultyDeps,
): Promise<Effort | undefined> {
	const judge = resolveJudge({
		settings: deps.settings,
		registry: deps.registry,
		sessionModel: deps.model,
		sessionId: deps.sessionId,
		metadataResolver: deps.metadataResolver,
		onUsage: deps.onUsage,
	});
	const state = { request: preprocessTinyMessage(promptText) };
	const options = { signal: deps.signal };
	const classified = await judge.withCandidate(async (candidate, kind) => {
		// The 3-bucket local question cannot select `max`, so its ceiling stays at
		// XHigh whatever the setting says — otherwise a sparse ladder would snap its
		// `hard` bucket up to a tier it never chose.
		if (kind === "local") {
			const { answers } = await candidate.judge({ state, questions: { bucket: BUCKET_QUESTION } }, options);
			return { effort: BUCKET_EFFORT[answers.bucket.choice], ceiling: Effort.XHigh };
		}
		const ceiling = autoEffortCeiling(deps);
		const level = ceiling === Effort.Max ? LEVEL_QUESTION_WITH_MAX : LEVEL_QUESTION;
		const { answers } = await candidate.judge({ state, questions: { level } }, options);
		return { effort: LEVEL_EFFORT[answers.level.choice], ceiling };
	}, options);
	// The successful branch's ceiling goes into the clamp itself: capping the
	// request alone is not enough, because a sparse ladder snaps an excluded
	// request back up.
	return clampAutoThinkingEffort(deps.model, classified.effort, classified.ceiling);
}
