import { fetchOpenAICompatibleModels } from "../discovery/openai-compatible";
import { getBundledModelReferenceIndex } from "../identity/bundled";
import { isAnthropicNamespacedModelId, isClaudeModelId } from "../identity/family";
import { inheritReferenceThinking, resolveModelReference } from "../identity/reference";
import type { ModelManagerOptions } from "../model-manager";
import type { Api, ModelSpec } from "../types";
import { resolveModelCacheProviderId } from "./cache-provider-id";
import type { ModelManagerConfig } from "./descriptor-types";

const COMMAND_CODE_PROVIDER_BASE_URL = "https://api.commandcode.ai/provider";

function normalizeBasePath(baseUrl: string | undefined): string {
	const value = (baseUrl ?? COMMAND_CODE_PROVIDER_BASE_URL).trim().replace(/\/+$/, "");
	return value.endsWith("/v1") ? value.slice(0, -3) : value;
}

export function resolveCommandCodeBaseUrl(api: Api, baseUrl?: string): string {
	const basePath = normalizeBasePath(baseUrl);
	return api === "anthropic-messages" ? basePath : `${basePath}/v1`;
}

/**
 * Command Code exposes one model list but two wire protocols:
 * Anthropic model identities use `/provider/v1/messages`, while every other
 * model uses `/provider/v1/chat/completions`. Routing must be based on the
 * discovered model id itself, not whichever reseller reference wins metadata
 * lookup, because the same GPT/Gemini id can appear on Anthropic-shaped gateways.
 */
export function resolveCommandCodeApi(modelId: string): Api {
	return isClaudeModelId(modelId) || isAnthropicNamespacedModelId(modelId)
		? "anthropic-messages"
		: "openai-completions";
}

function mapCommandCodeModel(defaults: ModelSpec<Api>, baseUrl?: string): ModelSpec<Api> {
	const reference = resolveModelReference(defaults.id, getBundledModelReferenceIndex());
	const api = resolveCommandCodeApi(defaults.id);
	const thinking = inheritReferenceThinking(defaults.thinking, reference, "command-code");
	return {
		...defaults,
		name: reference?.name ?? defaults.name,
		api,
		provider: "command-code",
		baseUrl: resolveCommandCodeBaseUrl(api, baseUrl),
		// Reasoning is an intrinsic model capability; buildModel derives the
		// Command Code transport's wire controls from the new API/id pair.
		reasoning: reference?.reasoning ?? defaults.reasoning,
		input: reference?.input ?? defaults.input,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: reference?.contextWindow ?? defaults.contextWindow,
		maxTokens: reference?.maxTokens ?? defaults.maxTokens,
		// Wire-model aliases such as effortRouting are provider-specific. Keep
		// discovery-provided thinking, but never inherit another provider's routing.
		...(thinking ? { thinking } : {}),
	};
}

export function commandCodeModelManagerOptions(config?: ModelManagerConfig): ModelManagerOptions<Api> {
	const apiKey = config?.apiKey;
	const discoveryBaseUrl = resolveCommandCodeBaseUrl("openai-completions", config?.baseUrl);

	return {
		providerId: "command-code",
		cacheProviderId: resolveModelCacheProviderId("command-code", { apiKey, baseUrl: discoveryBaseUrl }),
		dynamicModelsAuthoritative: true,
		...(apiKey && {
			fetchDynamicModels: () =>
				fetchOpenAICompatibleModels<Api>({
					api: "openai-completions",
					provider: "command-code",
					baseUrl: discoveryBaseUrl,
					apiKey,
					mapModel: (_entry, defaults) => mapCommandCodeModel(defaults, config?.baseUrl),
					fetch: config?.fetch,
				}),
		}),
	};
}
