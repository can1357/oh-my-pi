/**
 * Session-close handoff for the Dakera backend.
 *
 * The closing summary alone is one ≤500-char line a later recall may never
 * surface; the handoff is a four-label row the NEXT session's first turn fetches
 * deliberately (tag `handoff`), so continuation facts land in the block's first
 * slots. Synthesis mirrors `runDakeraReflect` (same model ladder, same retry) but
 * renders dedicated templates; every failure path rejects into
 * {@link extractiveHandoff}, which needs no model — a missing model or a
 * synthesis timeout lands there, never in an error.
 */
import { completeSimple, Effort, retryTransientCompletion } from "@oh-my-pi/pi-ai";
import { clampThinkingLevelForModel } from "@oh-my-pi/pi-catalog/model-thinking";
import { prompt } from "@oh-my-pi/pi-utils";
import type { ModelRegistry } from "../config/model-registry";
import type { Settings } from "../config/settings";
import { type HindsightMessage, prepareRetentionTranscript } from "../hindsight/content";
import handoffInputTemplate from "../prompts/memories/dakera-handoff-input.md" with { type: "text" };
import handoffSystemTemplate from "../prompts/memories/dakera-handoff-system.md" with { type: "text" };
import { withTimeoutSignal } from "../utils/fetch-timeout";
import type { DakeraConfig } from "./config";
import { resolveDakeraModel } from "./reflect";

/** Client deadline for the handoff model call — session close must not hang on synthesis. */
const HANDOFF_TIMEOUT_MS = 30_000;
const HANDOFF_MAX_OUTPUT_TOKENS = 1024;
/**
 * Cap on the transcript fed to the model, mirroring reflect's input budget
 * (`REFLECT_INPUT_CHAR_BUDGET`): a full-session transcript approaches the 99k
 * server content ceiling per retain. The TAIL is kept — a handoff is about where
 * the session stopped, so the head is what may go.
 */
const HANDOFF_INPUT_CHAR_BUDGET = 60_000;

export interface DakeraHandoffOptions {
	config: DakeraConfig;
	settings: Settings;
	modelRegistry: ModelRegistry;
	sessionId: string;
	messages: HindsightMessage[];
	closingSummary: string;
	signal?: AbortSignal;
}

/**
 * Synthesize the four-label handoff over the closing conversation.
 *
 * Throws when no model resolves or the model answers with an error — callers
 * catch and fall back to {@link extractiveHandoff}.
 */
export async function synthesizeHandoff(options: DakeraHandoffOptions): Promise<string> {
	const { config, settings, modelRegistry, sessionId, messages, closingSummary } = options;
	const model = await resolveDakeraModel(settings, modelRegistry, config.reflectModel);
	if (!model) throw new Error("Dakera handoff needs a model: set dakera.reflectModel or a smol/default model role.");

	const transcript = buildTranscript(messages);
	const input = prompt.render(handoffInputTemplate, { transcript, closingSummary });
	const response = await retryTransientCompletion(
		() =>
			completeSimple(
				model,
				{
					systemPrompt: [prompt.render(handoffSystemTemplate)],
					messages: [{ role: "user", content: [{ type: "text", text: input }], timestamp: Date.now() }],
				},
				{
					apiKey: modelRegistry.resolver(model, sessionId),
					sessionId,
					maxTokens: HANDOFF_MAX_OUTPUT_TOKENS,
					reasoning: clampThinkingLevelForModel(model, Effort.Low),
					signal: withTimeoutSignal(HANDOFF_TIMEOUT_MS, options.signal),
				},
			),
		{ provider: model.provider },
	);
	if (response.stopReason === "error") {
		throw new Error(response.errorMessage || "Dakera handoff model error");
	}
	const text = response.content
		.filter(block => block.type === "text")
		.map(block => block.text)
		.join("\n")
		.trim();
	// An empty completion is a failed handoff, not a valid one: reject so the
	// caller stores the extractive fallback instead of a blank row.
	if (!text) throw new Error("Dakera handoff model returned no text");
	return text;
}

/**
 * Deterministic handoff with no model: the four labels filled from the closing
 * exchange — last user prompt (the stopped-at line), the last assistant's first
 * sentence (the outcome), its tail (what is usually still open), and the closing
 * summary (the next step). Missing members render `—`; overlong ones are cut
 * with an ellipsis. The labels match {@link dakera-handoff-system} verbatim, so
 * the renderer's readers treat both shapes alike.
 */
export function extractiveHandoff(messages: HindsightMessage[], closingSummary: string | undefined): string {
	const lastUser = [...messages].reverse().find(message => message.role === "user");
	const lastAssistant = [...messages].reverse().find(message => message.role === "assistant");
	const assistantText = lastAssistant?.content ?? "";
	return [
		`Where we stopped: ${cutHead(lastUser?.content, 200)}`,
		`What failed: ${cutHead(firstSentence(assistantText), 300)}`,
		`Still open: ${cutTail(assistantText, 300)}`,
		`Next step: ${cutHead(closingSummary, 300)}`,
	].join("\n");
}

/** Full-window retention transcript (role-prefixed, no timestamps) for the synthesis input. */
function buildTranscript(messages: HindsightMessage[]): string {
	const { transcript } = prepareRetentionTranscript(messages, true, { includeTimestamps: false });
	if (!transcript) return "—";
	return transcript.length > HANDOFF_INPUT_CHAR_BUDGET
		? `…${transcript.slice(-HANDOFF_INPUT_CHAR_BUDGET)}`
		: transcript;
}

/** First sentence ending in `.`, `!`, `?` or a newline; the whole text when none. */
function firstSentence(text: string): string {
	for (let index = 0; index < text.length; index++) {
		const char = text[index];
		if (char === "." || char === "!" || char === "?" || char === "\n") return text.slice(0, index + 1).trim();
	}
	return text.trim();
}

function cutHead(text: string | undefined, limit: number): string {
	const trimmed = text?.trim();
	if (!trimmed) return "—";
	return trimmed.length <= limit ? trimmed : `${trimmed.slice(0, limit)}…`;
}

function cutTail(text: string | undefined, limit: number): string {
	const trimmed = text?.trim();
	if (!trimmed) return "—";
	return trimmed.length <= limit ? trimmed : `…${trimmed.slice(-limit)}`;
}

/** The state labels whose values say whether anything is mid-flight.
 * `Next step:` is excluded by design: the closing summary auto-fills it with
 * boilerplate (`omp: session ended` and siblings — every call site coalesces,
 * `buildClosingSummary()` yields `undefined` rather than `""`) on exactly the
 * empty close this guards, so it can never vouch for the row alone. */
const HANDOFF_STATE_LABELS = ["Where we stopped:", "What failed:", "Still open:"] as const;

/**
 * True when the handoff carries no continuation state: every state label is
 * the `—` placeholder — an empty close (extractive had nothing to cut) or a
 * model that echoed the template back. Any real state value, or label-free
 * text, keeps the row; placeholder lines are judged per label.
 */
export function isDegenerateHandoff(text: string): boolean {
	for (const raw of text.split("\n")) {
		const line = raw.trim();
		if (!line) continue;
		const label = HANDOFF_STATE_LABELS.find(prefix => line.startsWith(prefix));
		if (label) {
			const value = line.slice(label.length).trim();
			if (value && value !== "—") return false;
			continue;
		}
		if (line.startsWith("Next step:")) continue;
		if (line.replace(/[\s—]/gu, "")) return false;
	}
	return true;
}
