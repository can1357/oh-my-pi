/**
 * Smart unexpected-stop detection: asks one {@link NoulQuestion} whether a
 * text-only assistant turn promised to act and then ended. The judge comes
 * from the live `judge` role chain resolved by {@link resolveJudge}.
 */
import type { AssistantMessage, Model, NoulQuestion } from "@oh-my-pi/pi-ai";
import { logger } from "@oh-my-pi/pi-utils";
import type { ModelRegistry } from "../config/model-registry";
import type { Settings } from "../config/settings";
import { resolveJudge } from "../judgment";

/**
 * Yes-probability at or above which a turn counts as an unexpected stop.
 * Keyword judges answer exactly 0 or 1; TypeSafe's calibrated probability
 * lands in between, and a coin-flip message must not trigger a retry.
 */
const UNEXPECTED_STOP_THRESHOLD = 0.5;

const UNEXPECTED_STOP_QUESTION: NoulQuestion = {
	type: "noul",
	// Wording and bulleted examples measured on lfm2-1.2b / qwen2.5-1.5b: prose
	// criteria cost ~3 points of recall on the 1.2B model.
	instructions:
		"Classify whether this assistant message is an unexpected stop: it says it will act, continue working, or call a tool, then ends without doing so.",
	criteria: {
		true: 'Unexpected stops:\n- "I should do the same for the JS eval worker. Doing that now."\n- "Let me run the tests next."\n- "I\'ll fix that now."\n- "Should I do that for you?"',
		false: 'Not an unexpected stop:\n- "I\'ve completed the task."\n- "Is there anything else I can help with?"\n- "The fix is done and tests pass."',
	},
};

export interface ClassifyUnexpectedStopDeps {
	settings: Settings;
	registry: ModelRegistry;
	sessionId: string;
	/** Active session model; last resort of the judge role chain. */
	model?: Model;
	metadataResolver?: (provider: string) => Record<string, unknown> | undefined;
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
		});
		const { answers } = await judge.judge(
			{ state: { message: text }, questions: { stopped: UNEXPECTED_STOP_QUESTION } },
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
