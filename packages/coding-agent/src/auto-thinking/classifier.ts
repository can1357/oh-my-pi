/**
 * Per-prompt difficulty classifier for the `auto` thinking level.
 *
 * Picks a coding-difficulty bucket for a user prompt and maps it to a concrete
 * {@link Effort}, clamped into the active model's supported range (never below
 * {@link Effort.Low}). Two backends, selected by `providers.autoThinkingModel`:
 *
 * - `online` (default): a smol model classifies into `low|medium|high|xhigh`,
 *   plus `max` when the target model exposes that tier.
 * - a local key: an on-device memory model classifies into the coarser
 *   `trivial|moderate|hard` scheme (3-class is more reliable than 4-way ordinal
 *   on sub-2B models), mapped to `low|high|xhigh`.
 *
 * Throws on any failure (no model, no key, unparseable output, abort/timeout);
 * the caller falls back to a concrete level and continues the turn.
 */
import { type AssistantMessage, completeSimple, Effort, type Model, retryTransientCompletion } from "@oh-my-pi/pi-ai";
import { getSupportedEfforts } from "@oh-my-pi/pi-catalog/model-thinking";
import { prompt } from "@oh-my-pi/pi-utils";

import type { ModelRegistry } from "../config/model-registry";
import { resolveRoleSelection } from "../config/model-resolver";
import type { Settings } from "../config/settings";
import difficultySystemPrompt from "../prompts/system/auto-thinking-difficulty.md" with { type: "text" };
import difficultyLocalPrompt from "../prompts/system/auto-thinking-difficulty-local.md" with { type: "text" };
import { clampAutoThinkingEffort } from "../thinking";
import { preprocessTinyMessage } from "../tiny/message-preproc";
import {
	isTinyMemoryLocalModelKey,
	isTinyMemoryReasoningModelKey,
	ONLINE_AUTO_THINKING_MODEL_KEY,
} from "../tiny/models";
import { tinyModelClient } from "../tiny/title-client";

/**
 * Rendered classifier prompts, keyed by whether `max` is offered as a label.
 * Two variants only, so both are memoized on first use.
 */
const DIFFICULTY_SYSTEM_PROMPTS: Partial<Record<"max" | "xhigh", string>> = {};

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

function difficultySystemPromptFor(ceiling: Effort): string {
	const key = ceiling === Effort.Max ? "max" : "xhigh";
	const cached = DIFFICULTY_SYSTEM_PROMPTS[key];
	if (cached !== undefined) return cached;
	const rendered = prompt.render(difficultySystemPrompt, { allowMax: key === "max" });
	DIFFICULTY_SYSTEM_PROMPTS[key] = rendered;
	return rendered;
}

/** Local classifiers occasionally need more room for chat-template boilerplate. */
const LOCAL_ANSWER_MAX_TOKENS = 16;
/** On-device reasoning classifiers need room for the bucket keyword after the `<think>` preamble. */
const LOCAL_REASONING_MAX_TOKENS = 1024;
/**
 * Online classifier budget. Sized against two independent constraints:
 *   - Backends that ignore `disableReasoning` still emit a thinking preamble
 *     (e.g. Qwen3 via llama.cpp catalogued `reasoning: false` but still thinking;
 *     Anthropic via LiteLLM/Vertex, whose `openai-completions` route downgrades a
 *     disabled request to the lowest reasoning effort instead of turning thinking
 *     off). The classifier keyword must have room to land after that preamble
 *     (issue #4355).
 *   - Anthropic-dialect proxies reject `max_tokens <= thinking.budget_tokens`. The
 *     pinned lowest effort maps to at least Anthropic's 1024-token minimum budget,
 *     so the cap MUST comfortably exceed 1024 or every classifier call 400s with
 *     `max_tokens must be greater than thinking.budget_tokens` (issue #8610).
 * `maxTokens` is a hard cap — non-thinking completions still return in a handful
 * of tokens.
 */
const ONLINE_REASONING_SAFE_MAX_TOKENS = 4096;

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
	const input = preprocessTinyMessage(promptText);
	const online = backend === ONLINE_AUTO_THINKING_MODEL_KEY;
	// The 3-bucket local classifier cannot select `max`, so its ceiling stays at
	// XHigh whatever the setting says — otherwise a sparse ladder would snap its
	// `hard` bucket up to a tier it never chose.
	const ceiling = online ? autoEffortCeiling(deps) : Effort.XHigh;
	const effort = online ? await classifyOnline(input, deps, ceiling) : await classifyLocal(input, backend, deps);
	// The ceiling goes into the clamp itself: capping the request alone is not
	// enough, because a sparse ladder snaps an excluded request back up.
	return clampAutoThinkingEffort(deps.model, effort, ceiling);
}

async function classifyOnline(input: string, deps: ClassifyDifficultyDeps, ceiling: Effort): Promise<Effort> {
	const resolved = resolveRoleSelection(["tiny", "smol"], deps.settings, deps.registry.getAvailable());
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
	const maxTokens = ONLINE_REASONING_SAFE_MAX_TOKENS;

	const response = await retryTransientCompletion(
		() =>
			completeSimple(
				model,
				{
					systemPrompt: [difficultySystemPromptFor(ceiling)],
					messages: [{ role: "user", content: input, timestamp: Date.now() }],
				},
				{
					apiKey: deps.registry.resolver(model, deps.sessionId),
					maxTokens,
					disableReasoning: true,
					metadata,
					signal: deps.signal,
				},
			),
		{ signal: deps.signal },
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
		? Math.max(LOCAL_ANSWER_MAX_TOKENS, LOCAL_REASONING_MAX_TOKENS)
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

/**
 * Map an online level keyword to an {@link Effort}; earliest match wins.
 *
 * `max` is only offered to the classifier when the target model exposes that
 * tier, but it is always parsed: an unsupported `max` is snapped back down by
 * {@link clampAutoThinkingEffort} rather than failing the turn.
 */
export function parseDifficultyLevel(text: string): Effort | undefined {
	const lower = text.toLowerCase();
	const candidates: Array<[number, Effort]> = [];
	// `xhigh` must be probed as its own token: `\bhigh\b` cannot match the "high"
	// inside "xhigh" (no word boundary between `x` and `h`), so the two never collide.
	const xhigh = lower.search(/x[\s_-]?high/);
	if (xhigh >= 0) candidates.push([xhigh, Effort.XHigh]);
	const max = lower.search(/\bmax\b/);
	if (max >= 0) candidates.push([max, Effort.Max]);
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
