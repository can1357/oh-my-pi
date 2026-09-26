/**
 * Client-side `reflect` for the Dakera backend.
 *
 * Dakera has no generative reflection. `consolidate` and `knowledge_summarize`
 * look like the right endpoints and are not: both concatenate their inputs
 * (observed on v0.11.91) and `consolidate` ignores `dry_run`, so a "preview"
 * destroys the sources. `extract` can call an LLM but only per-memory, against
 * a provider configured on the server.
 *
 * So the synthesis happens here: recall the memories, ask a model to answer the
 * question over them, and return the prose. Nothing is written back — a reflect
 * answer stored as a memory would feed the next recall, and the answer is only
 * as good as the memories it was synthesized from.
 */

import { completeSimple, Effort, type Model, retryTransientCompletion } from "@oh-my-pi/pi-ai";
import { clampThinkingLevelForModel } from "@oh-my-pi/pi-catalog/model-thinking";
import { logger, prompt, truncate } from "@oh-my-pi/pi-utils";
import type { ModelRegistry } from "../config/model-registry";
import { getModelMatchPreferences, resolveModelRoleValue, resolveRoleSelection } from "../config/model-resolver";
import type { Settings } from "../config/settings";
import reflectInputTemplate from "../prompts/memories/dakera-reflect-input.md" with { type: "text" };
import reflectSystemTemplate from "../prompts/memories/dakera-reflect-system.md" with { type: "text" };
import { withTimeoutSignal } from "../utils/fetch-timeout";
import { type DakeraRecallHit, formatDakeraTimestamp } from "./client";
import type { DakeraConfig } from "./config";
import { cfgDakeraReflectModel } from "./settings";

const REFLECT_MAX_OUTPUT_TOKENS = 1024;

/**
 * Resolve the configured reflect model, then the memory role chain.
 *
 * `smol` alone is not enough: a config that sets only `modelRoles.default` — the
 * common case — has no smol role, and the local memory pipeline documents the
 * same `smol` → `default` ladder.
 */
export async function resolveDakeraModel(
	settings: Settings,
	modelRegistry: ModelRegistry,
	configuredSelector?: string | null,
): Promise<Model | undefined> {
	const selector = configuredSelector ?? cfgDakeraReflectModel.get(settings);
	if (selector) {
		const resolved = resolveModelRoleValue(selector, modelRegistry.getAll(), {
			settings,
			matchPreferences: getModelMatchPreferences(settings),
		});
		if (resolved.model) return resolved.model;
		logger.debug("Dakera: reflect model selector did not resolve", { selector });
	}

	const fallback = resolveRoleSelection(["smol", "default"], settings, modelRegistry.getAvailable())?.model;
	if (!fallback) logger.debug("Dakera: reflect unavailable, no model resolved");
	return fallback;
}

/**
 * Render recall hits oldest-first, so the model reads the facts in the order
 * they happened and the newest land closest to its answer.
 *
 * The hits arrive rank-ordered from recall; the input template asks the model to
 * prefer the most recently dated contradiction, which needs the dates to run in
 * one direction. An undated row sorts as the oldest thing on record.
 */
export function formatRecallHits(hits: DakeraRecallHit[]): string {
	const stamp = (hit: DakeraRecallHit) => formatDakeraTimestamp(hit.memory.created_at) ?? "";
	return hits
		.toSorted((a, b) => (stamp(a) < stamp(b) ? -1 : stamp(a) > stamp(b) ? 1 : 0))
		.map(hit => {
			const timestamp = stamp(hit);
			const type = hit.memory.memory_type ? ` [${hit.memory.memory_type}]` : "";
			return `${timestamp ? `(${timestamp})` : ""}${type} ${hit.memory.content}`.trim();
		})
		.join("\n\n");
}
/**
 * Upper bound on the characters of memory content fed to the reflect model.
 * Uncapped, `topK=8` hits of a 99k-char transcript ceiling can approach
 * ~800k characters and overflow the resolved model's context window. The
 * budget is on the rendered memories block; rows past it are dropped.
 */
const REFLECT_INPUT_CHAR_BUDGET = 60_000;
/**
 * Cut the ranked hit list down to {@link REFLECT_INPUT_CHAR_BUDGET} characters.
 *
 * Best-ranked hits are kept whole and the newest-ranked overflow is dropped (the
 * caller renders oldest-first inside {@link formatRecallHits}, so what is cut is
 * what the model would have weighted last anyway).
 *
 * The hit that crosses the budget is clamped rather than dropped: dropping it
 * would report "nothing to reflect on" while holding evidence, and keeping it
 * whole overflows the context window the budget exists to protect — a single
 * 99k-char transcript is enough on its own.
 */
export function budgetRecallHits(hits: DakeraRecallHit[]): DakeraRecallHit[] {
	const kept: DakeraRecallHit[] = [];
	let total = 0;
	for (const hit of hits) {
		const room = REFLECT_INPUT_CHAR_BUDGET - total;
		if (room <= 0) break;
		const content = hit.memory.content;
		if (content.length <= room) {
			total += content.length;
			kept.push(hit);
			continue;
		}
		// A copy: these hits are the session's stored recall results and clamping
		// must not shorten what the next turn sees.
		kept.push({ ...hit, memory: { ...hit.memory, content: truncate(content, room) } });
		break;
	}
	return kept;
}

export interface DakeraReflectOptions {
	config: DakeraConfig;
	/** Ranked hits from {@link DakeraSessionState.recallHits}; empty means nothing to synthesize. */
	hits: DakeraRecallHit[];
	settings: Settings;
	modelRegistry: ModelRegistry;
	sessionId: string;
	query: string;
	context?: string;
	signal?: AbortSignal;
}

/**
 * Synthesize an answer over the agent's memories.
 *
 * Returns the "nothing stored" phrasing when recall found nothing: an empty
 * answer is a valid reflection result, not an error.
 */
export async function runDakeraReflect(options: DakeraReflectOptions): Promise<string> {
	const { config, hits, settings, modelRegistry, sessionId, query, context } = options;
	if (hits.length === 0) return "No relevant information found to reflect on.";

	const model = await resolveDakeraModel(settings, modelRegistry, config.reflectModel);
	if (!model) throw new Error("Dakera reflect needs a model: set dakera.reflectModel or a smol/default model role.");

	const input = prompt.render(reflectInputTemplate, {
		question: query,
		...(context?.trim() ? { context: context.trim() } : {}),
		memories: formatRecallHits(budgetRecallHits(hits)),
		memoryCount: hits.length,
	});

	const response = await retryTransientCompletion(
		() =>
			completeSimple(
				model,
				{
					systemPrompt: [prompt.render(reflectSystemTemplate)],
					messages: [{ role: "user", content: [{ type: "text", text: input }], timestamp: Date.now() }],
				},
				{
					apiKey: modelRegistry.resolver(model, sessionId),
					sessionId,
					maxTokens: REFLECT_MAX_OUTPUT_TOKENS,
					reasoning: clampThinkingLevelForModel(model, Effort.Low),
					signal: withTimeoutSignal(config.reflectTimeoutMs, options.signal),
				},
			),
		{ provider: model.provider },
	);
	if (response.stopReason === "error") {
		throw new Error(response.errorMessage || "Dakera reflect model error");
	}

	const text = response.content
		.filter(block => block.type === "text")
		.map(block => block.text)
		.join("\n")
		.trim();
	return text || "No relevant information found to reflect on.";
}
