/**
 * Live OpenRouter RLM eval host — defaults to openrouter/free for dogfood smoke.
 */
import type { Usage } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "../../../src/config/model-registry";
import { resolveModelFromString } from "../../../src/config/model-resolver";
import { Settings } from "../../../src/config/settings";
import type { RlmCompleter } from "../../../src/rlm/query";
import { createTokenomicsBridge, type ContextPolicy, type OmpTokenomicsBridge } from "../../../src/rlm/tokenomics-bridge";
import { AuthStorage } from "../../../src/session/auth-storage";
import {
	createEvidenceCompleter,
	createProseCompleter,
	RESULTS_DIR,
	type LiveGroqHost,
} from "./live-groq-common";

/** OpenRouter free-model router (override via RLM_OPENROUTER_SUBMODEL / RLM_SUBMODEL). */
export const DEFAULT_OPENROUTER_MODEL = "openrouter/free";

export type LiveOpenRouterHost = LiveGroqHost;

export function requireOpenRouterApiKey(): void {
	if (process.env.OPENROUTER_API_KEY?.trim()) return;
	throw new Error(
		"OPENROUTER_API_KEY is required for OpenRouter live evals. Export OPENROUTER_API_KEY or run via ~/.omp/bin/omp-with-secrets if BWS provides it.",
	);
}

export async function createLiveOpenRouterHost(options?: {
	reasoning?: string;
	contextPolicy?: ContextPolicy;
	sessionSuffix?: string;
	workerMode?: "auto" | "prose" | "evidence-packet";
	subModel?: string;
}): Promise<LiveOpenRouterHost> {
	requireOpenRouterApiKey();
	const subModel =
		options?.subModel ??
		process.env.RLM_OPENROUTER_SUBMODEL ??
		process.env.RLM_SUBMODEL ??
		DEFAULT_OPENROUTER_MODEL;
	const reasoning = options?.reasoning ?? process.env.RLM_OPENROUTER_REASONING ?? "low";
	const settings = Settings.isolated({
		"rlm.enabled": true,
		"rlm.subModel": subModel,
		"rlm.workerMode": options?.workerMode ?? "auto",
		"context.engine": "rlm",
	});
	const auth = await AuthStorage.create();
	const modelRegistry = new ModelRegistry(auth, undefined, { settings });
	await modelRegistry.refresh("online-if-uncached");
	const model =
		resolveModelFromString(subModel, modelRegistry.getAvailable(), { settings }) ?? undefined;
	if (!model) throw new Error(`could not resolve OpenRouter model ${subModel}`);
	const apiKey = await modelRegistry.getApiKey(model);
	if (!apiKey) throw new Error(`no API key for ${model.provider}/${model.id}`);

	const tokenomics = createTokenomicsBridge({
		sessionId: `live-openrouter-${options?.sessionSuffix ?? Date.now()}`,
		dir: RESULTS_DIR,
		memoryOnly: process.env.RLM_OPENROUTER_MEMORY_TOKENOMICS === "1",
		contextPolicy: options?.contextPolicy ?? "rlm-search-grants",
	});

	return {
		settings,
		auth,
		modelRegistry,
		model,
		tokenomics,
		reasoning,
		close: () => auth.close(),
	};
}

/** Production-shaped completer: evidence-packet vs prose by purpose tag. */
export function createUnifiedRlmCompleter(host: LiveOpenRouterHost): RlmCompleter {
	const evidence = createEvidenceCompleter(host);
	const prose = createProseCompleter(host);
	return async (prompt, options) => {
		if (options?.purpose === "rlm-evidence-packet") return evidence(prompt, options);
		return prose(prompt, options);
	};
}

export function usageFromWorker(result: {
	inputTokens?: number;
	outputTokens?: number;
	cacheReadTokens?: number;
	tokens?: number;
	cost?: number;
}): Usage | undefined {
	if (result.inputTokens === undefined) return undefined;
	return {
		input: result.inputTokens,
		output: result.outputTokens ?? 0,
		cacheRead: result.cacheReadTokens ?? 0,
		cacheWrite: 0,
		totalTokens: result.tokens ?? result.inputTokens + (result.outputTokens ?? 0),
		cost: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			total: result.cost ?? 0,
		},
	};
}
