/**
 * Experimental advisor review gate (`advisor.judgeGate`).
 *
 * One `judge`-role fan-out over an in-progress advisor update decides whether
 * the advisor model reviews it now or the runtime holds it for the next
 * review. A decision model answers the yes/no risk questions below from one
 * shared state, so a routine tool-call round costs one cheap judgment instead
 * of a full advisor turn.
 *
 * The band lives here, not in a prompt: the update is skipped only when EVERY
 * risk scores below {@link REVIEW_THRESHOLD}. That band assumes calibrated
 * probabilities, so `auto` gates only on a native judgment backend (TypeSafe
 * Jev); `on` accepts any judge-role candidate, including prompted judges whose
 * answers are a one-hot 0 or 1. Callers fail open: a judge error or timeout
 * means "review".
 */
import type { AgentTelemetryConfig } from "@oh-my-pi/pi-agent-core";
import type { JudgmentResult, Model, NoulQuestion } from "@oh-my-pi/pi-ai";
import { logger, parseFrontmatter } from "@oh-my-pi/pi-utils";
import type { ModelRegistry } from "../config/model-registry";
import type { Settings } from "../config/settings";
import destructivePrompt from "../prompts/advisor/review-gate-destructive.md" with { type: "text" };
import guessingPrompt from "../prompts/advisor/review-gate-guessing.md" with { type: "text" };
import loopingPrompt from "../prompts/advisor/review-gate-looping.md" with { type: "text" };
import shortcutPrompt from "../prompts/advisor/review-gate-shortcut.md" with { type: "text" };
import { hasNativeJudge, type JudgmentUsage, judgeNatively, resolveJudge, sharedJudgmentCache } from "../judgment";
import { cfgAdvisorJudgeGate } from "./settings";

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
	/** Active session model: scopes provider-restricted judges, and the `on` mode's last-resort judge. */
	model?: Model;
	/** Chat-judge request metadata; only the `on` mode's prompted judges use it. */
	metadataResolver?: (provider: string) => Record<string, unknown> | undefined;
	onUsage?: (usage: JudgmentUsage) => void;
	telemetry?: AgentTelemetryConfig;
	/** Deadline for the whole judgment, after which the caller reviews anyway. */
	timeoutMs: number;
}

/**
 * The advisor-review verdict for `update` under `advisor.judgeGate`: resolves `true` when the advisor
 * should review now. `undefined` when the gate is off, or on `auto` without a native judge, so the
 * update is reviewed ungated and no judgment is spent. Rejects when no judge answers; callers fail open.
 */
export function judgeAdvisorReview(update: string, deps: AdvisorReviewGateDeps): Promise<boolean> | undefined {
	const mode = cfgAdvisorJudgeGate.get(deps.settings);
	if (mode === "off") return undefined;
	const request = { state: { update }, questions: REVIEW_QUESTIONS };
	let pending: Promise<JudgmentResult<typeof REVIEW_QUESTIONS>>;
	if (mode === "auto") {
		if (!hasNativeJudge(deps.settings, deps.registry, deps.model)) return undefined;
		pending = judgeNatively(
			"advisor-gate",
			request,
			{
				settings: deps.settings,
				registry: deps.registry,
				sessionModel: deps.model,
				sessionId: deps.sessionId,
				onUsage: deps.onUsage,
				telemetry: deps.telemetry,
			},
			deps.timeoutMs,
		);
	} else {
		pending = resolveJudge({
			settings: deps.settings,
			registry: deps.registry,
			sessionModel: deps.model,
			sessionId: deps.sessionId,
			metadataResolver: deps.metadataResolver,
			purpose: "advisor-gate",
			onUsage: deps.onUsage,
			telemetry: deps.telemetry,
			cache: sharedJudgmentCache(),
		}).judge(request, { signal: AbortSignal.timeout(deps.timeoutMs) });
	}
	return pending.then(({ answers, model }) => {
		const scores = {
			destructive: answers.destructive.noul,
			guessing: answers.guessing.noul,
			looping: answers.looping.noul,
			shortcut: answers.shortcut.noul,
		};
		const review = Object.values(scores).some(p => p >= REVIEW_THRESHOLD);
		// Logged so thresholds can be fit against what the advisor later said.
		logger.debug("advisor review gate", { mode, model, review, ...scores });
		return review;
	});
}
