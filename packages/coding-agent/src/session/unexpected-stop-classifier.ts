/**
 * Smart unexpected-stop detection: asks one yes/no judge question whether a
 * text-only assistant turn promised to act and then ended. The judge comes
 * from the live `judge` role chain resolved by {@link resolveJudge}.
 */
import type { AgentTelemetryConfig } from "@oh-my-pi/pi-agent-core";
import { type AssistantMessage, judgeQuestions, type Model } from "@oh-my-pi/pi-ai";
import { logger } from "@oh-my-pi/pi-utils";
import type { ModelRegistry } from "../config/model-registry";
import type { Settings } from "../config/settings";
import { type JudgmentUsage, resolveJudge, sharedJudgmentCache } from "../judgment";
import questionFile from "../prompts/judge/unexpected-stop.json" with { type: "json" };

/**
 * Yes-probability at or above which a turn counts as an unexpected stop.
 * Keyword judges answer exactly 0 or 1; TypeSafe's calibrated probability
 * lands in between, and a coin-flip message must not trigger a retry.
 */
const UNEXPECTED_STOP_THRESHOLD = 0.5;

/**
 * The yes/no `stopped` question. Its wording and bulleted examples were
 * measured on lfm2-1.2b / qwen2.5-1.5b: prose criteria cost ~3 points of
 * recall on the 1.2B model.
 */
const QUESTIONS = judgeQuestions(questionFile);

export interface ClassifyUnexpectedStopDeps {
	settings: Settings;
	registry: ModelRegistry;
	sessionId: string;
	/** Active session model; last resort of the judge role chain. */
	model?: Model;
	metadataResolver?: (provider: string) => Record<string, unknown> | undefined;
	/** Session ledger for the classification's billed attempts. */
	onUsage?: (usage: JudgmentUsage) => void;
	telemetry?: AgentTelemetryConfig;
	signal?: AbortSignal;
}

/** Detects terminal turns eligible for mechanical recovery or smart classification. */
export function isUnexpectedStopCandidate(message: AssistantMessage): boolean {
	if (message.stopReason !== "stop") return false;
	let hasContent = false;
	for (const content of message.content) {
		if (content.type === "toolCall") return false;
		if (content.type === "text" && /\S/.test(content.text)) {
			hasContent = true;
		}
		// A signed thinking-only stop is still a candidate: reasoning models can
		// trap the intended response (or a truncated fragment) in a thinking block
		// with no text. #isEmptyAssistantStop treats a non-whitespace signature as
		// terminal (not empty), so such stops bypass the empty-stop path entirely.
		// Match that predicate here — unsigned thinking-only stops stay with the
		// empty-stop retry path (and its cap) rather than being re-handled here.
		if (content.type === "thinking" && /\S/.test(content.thinking) && /\S/.test(content.thinkingSignature ?? "")) {
			hasContent = true;
		}
	}
	return hasContent;
}

/** `true` for an unexpected stop, `false` for a normal end of turn, `undefined` when no judge could answer. */
export async function classifyUnexpectedStop(
	text: string,
	deps: ClassifyUnexpectedStopDeps,
): Promise<boolean | undefined> {
	try {
		const judge = resolveJudge({
			settings: deps.settings,
			registry: deps.registry,
			sessionModel: deps.model,
			sessionId: deps.sessionId,
			metadataResolver: deps.metadataResolver,
			purpose: "unexpected-stop",
			onUsage: deps.onUsage,
			telemetry: deps.telemetry,
			cache: sharedJudgmentCache(),
		});
		const { answers } = await judge.judge(
			{ state: { message: text }, questions: { stopped: QUESTIONS.stopped } },
			{ signal: deps.signal },
		);
		return answers.stopped.noul >= UNEXPECTED_STOP_THRESHOLD;
	} catch (error) {
		logger.debug("unexpected-stop: classification failed", {
			error: error instanceof Error ? error.message : String(error),
		});
		return undefined;
	}
}
