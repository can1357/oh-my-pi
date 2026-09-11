import { type AssistantMessage, completeSimple, retryTransientCompletion } from "@oh-my-pi/pi-ai";
import { logger, prompt } from "@oh-my-pi/pi-utils";

import type { ModelRegistry } from "../config/model-registry";
import { resolveRoleSelection } from "../config/model-resolver";
import type { Settings } from "../config/settings";
import unexpectedStopClassifierPrompt from "../prompts/system/unexpected-stop-classifier.md" with { type: "text" };
import { isTinyMemoryLocalModelKey, ONLINE_MEMORY_MODEL_KEY } from "../tiny/models";
import { tinyModelClient } from "../tiny/title-client";

const CLASSIFIER_SYSTEM_PROMPT = prompt.render(unexpectedStopClassifierPrompt);

/**
 * The answer is a single word. OpenAI-compatible endpoints reject values below
 * 16, so 16 is the smallest portable budget for this classifier.
 */
const ANSWER_MAX_TOKENS = 16;
/**
 * Online classifier budget. Sized against two independent constraints:
 *   - Backends that ignore `disableReasoning` still emit a thinking preamble
 *     (e.g. Qwen3 via llama.cpp catalogued `reasoning: false` but still thinking;
 *     Anthropic via LiteLLM/Vertex, whose `openai-completions` route downgrades a
 *     disabled request to the lowest reasoning effort instead of turning thinking
 *     off). The yes/no keyword must have room to land after that preamble
 *     (issue #4355).
 *   - Anthropic-dialect proxies reject `max_tokens <= thinking.budget_tokens`. The
 *     pinned lowest effort maps to at least Anthropic's 1024-token minimum budget,
 *     so the cap MUST comfortably exceed 1024 or the request 400s with
 *     `max_tokens must be greater than thinking.budget_tokens` (issue #8610).
 * `maxTokens` is a hard cap — non-thinking completions still return in a single
 * word.
 */
const ONLINE_REASONING_SAFE_MAX_TOKENS = 4096;

export interface ClassifyUnexpectedStopDeps {
	settings: Settings;
	registry: ModelRegistry;
	sessionId: string;
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

export async function classifyUnexpectedStop(
	text: string,
	deps: ClassifyUnexpectedStopDeps,
): Promise<boolean | undefined> {
	const backend = deps.settings.get("providers.unexpectedStopModel");
	try {
		if (backend === ONLINE_MEMORY_MODEL_KEY) {
			return await classifyOnline(text, deps);
		}
		if (isTinyMemoryLocalModelKey(backend)) {
			return await classifyLocal(text, backend, deps);
		}
		return undefined;
	} catch (error) {
		logger.debug("unexpected-stop: classification failed", {
			error: error instanceof Error ? error.message : String(error),
			backend,
		});
		return undefined;
	}
}

async function classifyOnline(text: string, deps: ClassifyUnexpectedStopDeps): Promise<boolean | undefined> {
	const resolved = resolveRoleSelection(["tiny", "smol"], deps.settings, deps.registry.getAvailable());
	const model = resolved?.model;
	if (!model) {
		throw new Error("unexpected-stop: no tiny/smol model available for classification");
	}
	const apiKey = await deps.registry.getApiKey(model, deps.sessionId);
	if (!apiKey) {
		throw new Error(`unexpected-stop: no API key for ${model.provider}/${model.id}`);
	}
	const metadata = deps.metadataResolver?.(model.provider);
	const maxTokens = ONLINE_REASONING_SAFE_MAX_TOKENS;

	const response = await retryTransientCompletion(
		() =>
			completeSimple(
				model,
				{
					systemPrompt: [CLASSIFIER_SYSTEM_PROMPT],
					messages: [{ role: "user", content: text, timestamp: Date.now() }],
				},
				{
					apiKey: deps.registry.resolver(model, deps.sessionId),
					sessionId: deps.sessionId,
					maxTokens,
					disableReasoning: true,
					metadata,
					signal: deps.signal,
				},
			),
		{ signal: deps.signal },
	);

	if (response.stopReason === "error") {
		throw new Error(`unexpected-stop: online classification failed: ${response.errorMessage ?? "unknown error"}`);
	}

	const outputText = response.content
		.filter((part): part is { type: "text"; text: string } => part.type === "text")
		.map(part => part.text)
		.join("\n");
	return parseUnexpectedStopClassification(outputText);
}

async function classifyLocal(
	text: string,
	modelKey: string,
	deps: ClassifyUnexpectedStopDeps,
): Promise<boolean | undefined> {
	if (!isTinyMemoryLocalModelKey(modelKey)) {
		throw new Error(`unexpected-stop: unsupported local classifier model: ${modelKey}`);
	}
	const builtPrompt = prompt.render(unexpectedStopClassifierPrompt, { message: text });
	const output = await tinyModelClient.complete(modelKey, builtPrompt, {
		maxTokens: ANSWER_MAX_TOKENS,
		signal: deps.signal,
	});
	if (!output) {
		return undefined;
	}
	return parseUnexpectedStopClassification(output);
}

export function parseUnexpectedStopClassification(text: string): boolean | undefined {
	const trimmed = text.trim().toLowerCase();
	if (trimmed.startsWith("yes")) return true;
	if (trimmed.startsWith("no")) return false;
	return undefined;
}
