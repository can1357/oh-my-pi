/**
 * Experimental advisor review gate (`advisor.judgeGate`).
 *
 * One `judge`-role fan-out over an in-progress advisor update decides whether
 * the advisor model reviews it now or the runtime holds it for the next
 * review. A decision model (TypeSafe Jev, or any judge-role fallback) answers
 * the yes/no risk questions below from one shared state, so a routine
 * tool-call round costs one cheap judgment instead of a full advisor turn.
 *
 * The band lives here, not in a prompt: the update is skipped only when EVERY
 * risk scores below {@link REVIEW_THRESHOLD}. Callers fail open: a judge error
 * or timeout means "review".
 */
import type { AgentTelemetryConfig } from "@oh-my-pi/pi-agent-core";
import type { Model, NoulQuestion } from "@oh-my-pi/pi-ai";
import { logger } from "@oh-my-pi/pi-utils";
import type { ModelRegistry } from "../config/model-registry";
import type { Settings } from "../config/settings";
import { type JudgmentUsage, resolveJudge, sharedJudgmentCache } from "../judgment";

/**
 * Lowest yes-probability on any risk question that still sends the update to
 * the advisor. Deliberately low: a skipped risky update costs more than a
 * spent review, and calibrated is not correct per call.
 */
// ponytail: one global band; per-question thresholds fit on labeled __advisor.jsonl data if this misfires.
const REVIEW_THRESHOLD = 0.2;

/** Mirrors the advisor's concern/blocker lanes in `prompts/advisor/system.md`. */
const REVIEW_QUESTIONS = {
	destructive: {
		type: "noul",
		instructions:
			"Does this coding-agent update run or prepare a command or edit that could destroy work, data, or state that is hard to recover?",
		criteria: {
			true: "Force resets, recursive deletes, history rewrites, dropping data, overwriting files outside the task, pushing to shared branches.",
			false: "Reading, searching, running tests, or editing files within the task.",
		},
	},
	guessing: {
		type: "noul",
		instructions:
			"Does the agent assume how code, an API, or runtime behavior works when it could have read the source or run a check instead?",
		criteria: {
			true: "Edits or claims based on guessed signatures, paths, config keys, or error causes.",
			false: "Reading files, searching, running commands, or claims backed by something it read or ran.",
		},
	},
	looping: {
		type: "noul",
		instructions: "Does the agent repeat an action or plan it already tried without changing its approach?",
		criteria: {
			true: "The same failing command, edit, or search retried; the same analysis restated.",
			false: "Each step makes new progress or changes approach after a failure.",
		},
	},
	shortcut: {
		type: "noul",
		instructions:
			"Does the agent substitute stubs, TODOs, placeholders, mocks, or a simplified version for the real implementation or verification?",
		criteria: {
			true: "Stubbed functions, skipped tests, fake data, 'for now' workarounds, claiming done without running anything.",
			false: "Reading, searching, or planning with no code written yet; or a real implementation verified by running it.",
		},
	},
} satisfies Record<string, NoulQuestion>;

export interface AdvisorReviewGateDeps {
	settings: Settings;
	registry: ModelRegistry;
	sessionId: string;
	/** Active session model; last resort of the judge role chain. */
	model?: Model;
	metadataResolver?: (provider: string) => Record<string, unknown> | undefined;
	onUsage?: (usage: JudgmentUsage) => void;
	telemetry?: AgentTelemetryConfig;
	signal?: AbortSignal;
}

/** `true` when the advisor should review `update` now. Throws when no judge answers; callers fail open. */
export async function judgeAdvisorReview(update: string, deps: AdvisorReviewGateDeps): Promise<boolean> {
	const judge = resolveJudge({
		settings: deps.settings,
		registry: deps.registry,
		sessionModel: deps.model,
		sessionId: deps.sessionId,
		metadataResolver: deps.metadataResolver,
		purpose: "advisor-gate",
		onUsage: deps.onUsage,
		telemetry: deps.telemetry,
		cache: sharedJudgmentCache(),
	});
	const { answers, model } = await judge.judge(
		{ state: { update }, questions: REVIEW_QUESTIONS },
		{ signal: deps.signal },
	);
	const scores = {
		destructive: answers.destructive.noul,
		guessing: answers.guessing.noul,
		looping: answers.looping.noul,
		shortcut: answers.shortcut.noul,
	};
	const review = Object.values(scores).some(p => p >= REVIEW_THRESHOLD);
	// Logged so thresholds can be fit against what the advisor later said.
	logger.debug("advisor review gate", { model, review, ...scores });
	return review;
}
