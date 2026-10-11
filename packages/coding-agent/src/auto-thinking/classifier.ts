/**
 * Per-prompt difficulty classifier for the `auto` thinking level.
 *
 * Asks one {@link ChoiceQuestion} about the user's request — or, for
 * task-spawned turns, about the delegator's `solutionSpace` description alone —
 * and maps the chosen level to a concrete {@link Effort}, clamped into the active model's
 * supported range (never below {@link Effort.Low}). The judge comes from the
 * live `judge` role chain. A local on-device candidate gets the coarser
 * `trivial|moderate|hard` question (3-class is more reliable
 * than 4-way ordinal on sub-2B models), mapped to `low|high|xhigh`.
 *
 * Throws on any failure (no judge, no key, unparseable output, abort/timeout);
 * the caller falls back to a concrete level and continues the turn.
 */
import type { AgentTelemetryConfig } from "@oh-my-pi/pi-agent-core";
import { type ChoiceQuestion, Effort, judgeQuestions, type Model, renderQuestion } from "@oh-my-pi/pi-ai";
import { getSupportedEfforts } from "@oh-my-pi/pi-catalog/model-thinking";
import type { ModelRegistry } from "../config/model-registry";
import type { Settings } from "../config/settings";
import { type JudgmentUsage, resolveJudge, sharedJudgmentCache } from "../judgment";
import questionFile from "../prompts/judge/auto-thinking.json" with { type: "json" };
import { clampAutoThinkingEffort } from "@oh-my-pi/pi-tui/thinking";
import { preprocessTinyMessage } from "../tiny/message-preproc";

import { cfgProvidersAutoThinkingMaxEffort } from "../session/settings";

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

/**
 * The on-device bucket question, the effort ladder (levels by how open-ended
 * the problem is, `max` last), and the solution-space instructions, which
 * reuse the ladder's levels.
 */
const QUESTIONS = judgeQuestions(questionFile);

/** Questions for one classification input kind: on-device bucket, full ladder, full ladder with `max`. */
interface QuestionSet {
	bucket: ChoiceQuestion<Bucket>;
	level: ChoiceQuestion<Exclude<Level, "max">>;
	/** Offers `max`; used only when the target model exposes that tier. */
	levelWithMax: ChoiceQuestion<Level>;
}

/**
 * Build the question set for one input kind. Only the instructions differ
 * between kinds; every kind shares the ladder's levels and the bucket criteria.
 */
function buildQuestionSet(instructions: string, bucketInstructions: string): QuestionSet {
	const ladder: ChoiceQuestion<Level> = { ...QUESTIONS.level, instructions };
	const { max: _max, ...levels } = ladder.criteria;
	return {
		bucket: { ...QUESTIONS.bucket, instructions: bucketInstructions },
		level: { ...renderQuestion(ladder, {}), criteria: levels },
		levelWithMax: renderQuestion(ladder, { withMax: true }),
	};
}

const REQUEST_QUESTIONS = buildQuestionSet(QUESTIONS.level.instructions, QUESTIONS.bucket.instructions);
const SOLUTION_SPACE_QUESTIONS = buildQuestionSet(
	QUESTIONS.solutionSpace.instructions,
	renderQuestion(QUESTIONS.solutionSpace, {}).instructions,
);

/** The turn to classify. */
export interface DifficultyInput {
	/** The prompt text the agent is about to act on. */
	request: string;
	/**
	 * Delegator's description of how open-ended the subtask is (task `solutionSpace` field).
	 * When non-blank it replaces `request` as the sole classification input.
	 */
	solutionSpace?: string;
}

export interface ClassifyDifficultyDeps {
	settings: Settings;
	registry: ModelRegistry;
	model: Model;
	sessionId?: string;
	signal?: AbortSignal;
	metadataResolver?: (provider: string) => Record<string, unknown> | undefined;
	onUsage?: (usage: JudgmentUsage) => void;
	telemetry?: AgentTelemetryConfig;
}

/**
 * Highest effort this turn's classification may resolve to: the configured
 * ceiling, further limited by what the target model actually exposes. The
 * default keeps `auto` one tier below the top, so only an explicit
 * `ultrathink` reaches {@link Effort.Max}.
 */
function autoEffortCeiling(deps: ClassifyDifficultyDeps): Effort {
	if (cfgProvidersAutoThinkingMaxEffort.get(deps.settings) !== Effort.Max) return Effort.XHigh;
	return getSupportedEfforts(deps.model).includes(Effort.Max) ? Effort.Max : Effort.XHigh;
}

/**
 * Classify `input` and return a concrete effort clamped to `deps.model`,
 * or `undefined` when the model has no controllable effort surface (auto has
 * nothing to pick — the caller leaves the prior reasoning level in place).
 * @throws when the backend cannot produce a usable classification.
 */
export async function classifyDifficulty(
	input: DifficultyInput,
	deps: ClassifyDifficultyDeps,
): Promise<Effort | undefined> {
	const judge = resolveJudge({
		settings: deps.settings,
		registry: deps.registry,
		sessionModel: deps.model,
		sessionId: deps.sessionId,
		metadataResolver: deps.metadataResolver,
		purpose: "auto-thinking",
		onUsage: deps.onUsage,
		telemetry: deps.telemetry,
		cache: sharedJudgmentCache(),
	});
	const solutionSpace = input.solutionSpace?.trim();
	const state: Record<string, string> = solutionSpace
		? { solution_space: preprocessTinyMessage(solutionSpace) }
		: { request: preprocessTinyMessage(input.request) };
	const questions = solutionSpace ? SOLUTION_SPACE_QUESTIONS : REQUEST_QUESTIONS;
	const options = { signal: deps.signal };
	const classified = await judge.withCandidate(async (candidate, kind) => {
		// The 3-bucket local question cannot select `max`, so its ceiling stays at
		// XHigh whatever the setting says — otherwise a sparse ladder would snap its
		// `hard` bucket up to a tier it never chose.
		if (kind === "local") {
			const { answers } = await candidate.judge({ state, questions: { bucket: questions.bucket } }, options);
			return { effort: BUCKET_EFFORT[answers.bucket.choice], ceiling: Effort.XHigh };
		}
		const ceiling = autoEffortCeiling(deps);
		const level = ceiling === Effort.Max ? questions.levelWithMax : questions.level;
		const { answers } = await candidate.judge({ state, questions: { level } }, options);
		return { effort: LEVEL_EFFORT[answers.level.choice], ceiling };
	}, options);
	// The successful branch's ceiling goes into the clamp itself: capping the
	// request alone is not enough, because a sparse ladder snaps an excluded
	// request back up.
	return clampAutoThinkingEffort(deps.model, classified.effort, classified.ceiling);
}
