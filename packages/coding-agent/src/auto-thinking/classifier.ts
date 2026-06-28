/**
 * Per-prompt difficulty classifier for the `auto` thinking level.
 *
 * Picks a coding-difficulty bucket for a user prompt and maps it to a concrete
 * {@link Effort}, clamped into the active model's supported range (never below
 * {@link Effort.Low}). Two backends, selected by `providers.autoThinkingModel`:
 *
 * - `online` (default): a smol model classifies into `low|medium|high|xhigh`.
 * - a local key: an on-device memory model classifies into the coarser
 *   `trivial|moderate|hard` scheme (3-class is more reliable than 4-way ordinal
 *   on sub-2B models), mapped to `low|high|xhigh`.
 *
 * Throws on any failure (no model, no key, unparseable output, abort/timeout);
 * the caller falls back to a concrete level and continues the turn.
 */
import { type AssistantMessage, completeSimple, Effort, type Model } from "@pk-nerdsaver-ai/pi-ai";
import { prompt } from "@pk-nerdsaver-ai/pi-utils";

import type { ModelRegistry } from "../config/model-registry";
import { resolveRoleSelection } from "../config/model-resolver";
import type { Settings } from "../config/settings";
import difficultySystemPrompt from "../prompts/system/auto-thinking-difficulty.md" with { type: "text" };
import difficultyLocalPrompt from "../prompts/system/auto-thinking-difficulty-local.md" with { type: "text" };
import { clampAutoThinkingEffort } from "../thinking";
import {
	isTinyMemoryLocalModelKey,
	isTinyMemoryReasoningModelKey,
	ONLINE_AUTO_THINKING_MODEL_KEY,
} from "../tiny/models";
import { tinyModelClient } from "../tiny/title-client";

const DIFFICULTY_SYSTEM_PROMPT = prompt.render(difficultySystemPrompt);

/** Upper bound on prompt characters fed to the classifier. */
const MAX_INPUT_CHARS = 6000;
const HEAD_CHARS = 4000;
const TAIL_CHARS = 2000;
/** The online answer is a single word; keep budgets tiny for non-reasoning backends. */
const ANSWER_MAX_TOKENS = 8;
/** Local classifiers occasionally need more room for chat-template boilerplate. */
const LOCAL_ANSWER_MAX_TOKENS = 16;
/**
 * Reasoning backends ignore `disableReasoning` on some providers, so reserve
 * enough output room for the keyword to still land after unavoidable thinking.
 */
const REASONING_SAFE_MAX_TOKENS = 1024;

export interface ClassifyDifficultyDeps {
	settings: Settings;
	registry: ModelRegistry;
	model: Model;
	sessionId?: string;
	signal?: AbortSignal;
	metadataResolver?: (provider: string) => Record<string, unknown> | undefined;
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
	const backend = deps.settings.get("providers.autoThinkingModel");
	const input = prepareClassifierInput(promptText);
	const effort =
		backend === ONLINE_AUTO_THINKING_MODEL_KEY
			? await classifyOnline(input, deps)
			: await classifyLocal(input, backend, deps);
	return clampAutoThinkingEffort(deps.model, effort);
}

async function classifyOnline(input: string, deps: ClassifyDifficultyDeps): Promise<Effort> {
	const resolved = resolveRoleSelection(["tiny", "smol"], deps.settings, deps.registry.getAvailable(), deps.registry);
	const model = resolved?.model;
	if (!model) {
		throw new Error("auto-thinking: no tiny/smol model available for classification");
	}
	const apiKey = await deps.registry.getApiKey(model, deps.sessionId);
	if (!apiKey) {
		throw new Error(`auto-thinking: no API key for ${model.provider}/${model.id}`);
	}
	// Resolve metadata after getApiKey so the session-sticky credential is recorded first.
	const metadata = deps.metadataResolver?.(model.provider);
	const maxTokens = model.reasoning ? Math.max(ANSWER_MAX_TOKENS, REASONING_SAFE_MAX_TOKENS) : ANSWER_MAX_TOKENS;

	const response = await completeSimple(
		model,
		{
			systemPrompt: [DIFFICULTY_SYSTEM_PROMPT],
			messages: [{ role: "user", content: input, timestamp: Date.now() }],
		},
		{
			apiKey: deps.registry.resolver(model, deps.sessionId),
			maxTokens,
			disableReasoning: true,
			metadata,
			signal: deps.signal,
		},
	);

	if (response.stopReason === "error") {
		throw new Error(`auto-thinking: online classification failed: ${response.errorMessage ?? "unknown error"}`);
	}

	const text = extractText(response.content);
	const effort = parseDifficultyLevel(text);
	if (!effort) {
		throw new Error(`auto-thinking: unparseable online classification: ${JSON.stringify(text)}`);
	}
	return effort;
}

async function classifyLocal(input: string, modelKey: string, deps: ClassifyDifficultyDeps): Promise<Effort> {
	if (!isTinyMemoryLocalModelKey(modelKey)) {
		throw new Error(`auto-thinking: unsupported local classifier model: ${modelKey}`);
	}
	const maxTokens = isTinyMemoryReasoningModelKey(modelKey)
		? Math.max(LOCAL_ANSWER_MAX_TOKENS, REASONING_SAFE_MAX_TOKENS)
		: LOCAL_ANSWER_MAX_TOKENS;
	const builtPrompt = prompt.render(difficultyLocalPrompt, { prompt: input });
	const text = await tinyModelClient.complete(modelKey, builtPrompt, {
		maxTokens,
		signal: deps.signal,
	});
	if (!text) {
		throw new Error("auto-thinking: local classification returned no output");
	}
	const effort = parseDifficultyBucket(text);
	if (!effort) {
		throw new Error(`auto-thinking: unparseable local classification: ${JSON.stringify(text)}`);
	}
	return effort;
}

/** Map the online 4-way level keyword to an {@link Effort}; earliest match wins. */
export function parseDifficultyLevel(text: string): Effort | undefined {
	const lower = text.toLowerCase();
	const candidates: Array<[number, Effort]> = [];
	// `xhigh` must be probed as its own token: `\bhigh\b` cannot match the "high"
	// inside "xhigh" (no word boundary between `x` and `h`), so the two never collide.
	const xhigh = lower.search(/x[\s_-]?high/);
	if (xhigh >= 0) candidates.push([xhigh, Effort.XHigh]);
	const high = lower.search(/\bhigh\b/);
	if (high >= 0) candidates.push([high, Effort.High]);
	const medium = lower.search(/\bmed(?:ium)?\b/);
	if (medium >= 0) candidates.push([medium, Effort.Medium]);
	const low = lower.search(/\blow\b/);
	if (low >= 0) candidates.push([low, Effort.Low]);
	return earliest(candidates);
}

/** Map the local 3-way bucket keyword to an {@link Effort}; earliest match wins. */
export function parseDifficultyBucket(text: string): Effort | undefined {
	const lower = text.toLowerCase();
	const candidates: Array<[number, Effort]> = [];
	const trivial = lower.search(/\btrivial\b/);
	if (trivial >= 0) candidates.push([trivial, Effort.Low]);
	const moderate = lower.search(/\bmoderate\b/);
	if (moderate >= 0) candidates.push([moderate, Effort.High]);
	const hard = lower.search(/\bhard\b/);
	if (hard >= 0) candidates.push([hard, Effort.XHigh]);
	return earliest(candidates);
}

function earliest(candidates: Array<[number, Effort]>): Effort | undefined {
	if (candidates.length === 0) return undefined;
	let best = candidates[0];
	for (const candidate of candidates) {
		if (candidate[0] < best[0]) best = candidate;
	}
	return best[1];
}

function extractText(content: AssistantMessage["content"]): string {
	return content
		.filter((block): block is Extract<AssistantMessage["content"][number], { type: "text" }> => block.type === "text")
		.map(block => block.text)
		.join(" ")
		.trim();
}

/**
 * Bound the classifier input. Code blocks are kept (a large diff is signal), but
 * very long prompts are head+tail trimmed so the intent (start) and any trailing
 * error/stacktrace (end) both survive.
 */
function prepareClassifierInput(text: string): string {
	const trimmed = text.trim();
	if (trimmed.length <= MAX_INPUT_CHARS) return trimmed;
	return `${trimmed.slice(0, HEAD_CHARS)}\n…\n${trimmed.slice(-TAIL_CHARS)}`;
}
