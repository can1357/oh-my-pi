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
import { logger, parseFrontmatter } from "@oh-my-pi/pi-utils";
import type { ModelRegistry } from "../config/model-registry";
import type { Settings } from "../config/settings";
import destructivePrompt from "../prompts/advisor/review-gate-destructive.md" with { type: "text" };
import guessingPrompt from "../prompts/advisor/review-gate-guessing.md" with { type: "text" };
import loopingPrompt from "../prompts/advisor/review-gate-looping.md" with { type: "text" };
import shortcutPrompt from "../prompts/advisor/review-gate-shortcut.md" with { type: "text" };
import { type JudgmentUsage, resolveJudge, sharedJudgmentCache } from "../judgment";

/**
 * Lowest yes-probability on any risk question that still sends the update to
 * the advisor. Deliberately low: a skipped risky update costs more than a
 * spent review, and calibrated is not correct per call.
 */
// ponytail: one global band; per-question thresholds fit on labeled __advisor.jsonl data if this misfires.
const REVIEW_THRESHOLD = 0.2;

/** Prompt body is the question; frontmatter `true`/`false` spell out what yes and no mean. */
function noulQuestion(content: string): NoulQuestion {
	const { frontmatter, body } = parseFrontmatter(content, { level: "fatal" });
	return {
		type: "noul",
		instructions: body,
		criteria: { true: String(frontmatter.true), false: String(frontmatter.false) },
	};
}

/** Mirrors the advisor's concern/blocker lanes in `prompts/advisor/system.md`. */
const REVIEW_QUESTIONS = {
	destructive: noulQuestion(destructivePrompt),
	guessing: noulQuestion(guessingPrompt),
	looping: noulQuestion(loopingPrompt),
	shortcut: noulQuestion(shortcutPrompt),
};

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
