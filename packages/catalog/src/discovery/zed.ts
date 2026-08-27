import { type } from "@oh-my-pi/omptype";
import { Effort } from "../effort";
import type { FetchImpl, ModelCost, ModelSpec } from "../types";
import { discoveryFetch } from "../utils";
import { parseZedCredentials, ZED_APP_VERSION, ZED_CLOUD_URL, ZED_HEADERS } from "../wire/zed";

const zedSupportedEffortLevelSchema = type({
	name: "string",
	value: "string",
	"is_default?": "boolean",
});

const zedLanguageModelSchema = type({
	provider: "string",
	id: "string",
	"display_name?": "string",
	"max_token_count?": "number",
	"max_output_tokens?": "number",
	"supports_tools?": "boolean",
	"supports_images?": "boolean",
	"supports_thinking?": "boolean",
	"supported_effort_levels?": zedSupportedEffortLevelSchema.array(),
	"is_disabled?": "boolean",
	"disabled_reason?": "string",
});

const zedListModelsResponseSchema = type({
	models: zedLanguageModelSchema.array(),
	"default_model?": "string | null",
	"default_fast_model?": "string | null",
	"recommended_models?": "string[]",
});

const zedLlmTokenResponseSchema = type({
	token: "string",
});

export interface FetchZedModelsOptions {
	token?: string;
	signal?: AbortSignal;
	fetcher?: FetchImpl;
}

const FALLBACK_EFFORTS: readonly Effort[] = [Effort.Low, Effort.Medium, Effort.High] as const;

/**
 * Official Zed token rates from zed.dev/pricing (+10% markup over upstream list price).
 * Prices in USD per 1,000,000 tokens.
 */
const ZED_OFFICIAL_RATES: Record<string, ModelCost> = {
	// Anthropic
	"claude-sonnet-5": { input: 2.2, output: 11.0, cacheRead: 0.22, cacheWrite: 2.75 },
	"claude-sonnet-4-6": { input: 3.3, output: 16.5, cacheRead: 0.33, cacheWrite: 4.125 },
	"claude-sonnet-4-5": { input: 3.3, output: 16.5, cacheRead: 0.33, cacheWrite: 4.125 },
	"claude-haiku-4-5": { input: 1.1, output: 5.5, cacheRead: 0.11, cacheWrite: 1.375 },
	"claude-haiku-4-6": { input: 1.1, output: 5.5, cacheRead: 0.11, cacheWrite: 1.375 },
	"claude-opus-5": { input: 5.5, output: 27.5, cacheRead: 0.55, cacheWrite: 6.875 },
	"claude-opus-4-6": { input: 5.5, output: 27.5, cacheRead: 0.55, cacheWrite: 6.875 },
	"claude-opus-4-5": { input: 5.5, output: 27.5, cacheRead: 0.55, cacheWrite: 6.875 },

	// OpenAI
	"gpt-5.6-sol": { input: 5.5, output: 33.0, cacheRead: 0.55, cacheWrite: 6.875 },
	"gpt-5.6-terra": { input: 2.75, output: 16.5, cacheRead: 0.275, cacheWrite: 3.4375 },
	"gpt-5.6-luna": { input: 1.1, output: 6.6, cacheRead: 0.11, cacheWrite: 1.375 },
	"gpt-5.5": { input: 5.5, output: 33.0, cacheRead: 0.55, cacheWrite: 6.875 },
	"gpt-5.4": { input: 2.75, output: 16.5, cacheRead: 0.0275, cacheWrite: 3.4375 },
	"gpt-5.3-codex": { input: 1.925, output: 15.4, cacheRead: 0.1925, cacheWrite: 2.406 },
	"gpt-5.2": { input: 1.925, output: 15.4, cacheRead: 0.1925, cacheWrite: 2.406 },
	"gpt-5-mini": { input: 0.275, output: 2.2, cacheRead: 0.0275, cacheWrite: 0.343 },
	"gpt-5-nano": { input: 0.055, output: 0.44, cacheRead: 0.0055, cacheWrite: 0.068 },

	// Google
	"gemini-3.1-pro-preview": { input: 2.2, output: 13.2, cacheRead: 0.55, cacheWrite: 2.75 },
	"gemini-3.5-flash": { input: 1.65, output: 9.9, cacheRead: 0.4125, cacheWrite: 2.0625 },
	"gemini-3-flash": { input: 0.55, output: 3.3, cacheRead: 0.1375, cacheWrite: 0.6875 },

	// xAI Grok
	"grok-2": { input: 2.2, output: 11.0, cacheRead: 0.55, cacheWrite: 2.75 },
	"grok-4.20": { input: 2.2, output: 11.0, cacheRead: 0.55, cacheWrite: 2.75 },
};

export function resolveZedModelCost(modelId: string): ModelCost {
	const exact = ZED_OFFICIAL_RATES[modelId];
	if (exact) return exact;

	const lower = modelId.toLowerCase();
	if (lower.includes("haiku")) return { input: 1.1, output: 5.5, cacheRead: 0.11, cacheWrite: 1.375 };
	if (lower.includes("flash")) return { input: 0.55, output: 3.3, cacheRead: 0.1375, cacheWrite: 0.6875 };
	if (lower.includes("mini")) return { input: 0.275, output: 2.2, cacheRead: 0.0275, cacheWrite: 0.343 };
	if (lower.includes("nano")) return { input: 0.055, output: 0.44, cacheRead: 0.0055, cacheWrite: 0.068 };
	if (lower.includes("opus")) return { input: 5.5, output: 27.5, cacheRead: 0.55, cacheWrite: 6.875 };
	if (lower.includes("sol")) return { input: 5.5, output: 33.0, cacheRead: 0.55, cacheWrite: 6.875 };
	if (lower.includes("terra")) return { input: 2.75, output: 16.5, cacheRead: 0.275, cacheWrite: 3.4375 };
	if (lower.includes("luna")) return { input: 1.1, output: 6.6, cacheRead: 0.11, cacheWrite: 1.375 };
	if (lower.includes("sonnet") || lower.includes("pro")) {
		return { input: 3.3, output: 16.5, cacheRead: 0.33, cacheWrite: 4.125 };
	}

	return { input: 2.0, output: 10.0, cacheRead: 0.2, cacheWrite: 2.5 };
}

/**
 * Mint a short-lived LLM token from Zed Cloud using master credentials (userId + accessToken).
 */
async function mintZedLlmToken(
	userId: string,
	accessToken: string,
	fetcher: FetchImpl,
	signal?: AbortSignal,
): Promise<string | null> {
	try {
		const response = await fetcher(`${ZED_CLOUD_URL}/client/llm_tokens`, {
			method: "POST",
			headers: {
				Authorization: `${userId} ${accessToken}`,
				"Content-Type": "application/json",
				[ZED_HEADERS.VERSION]: ZED_APP_VERSION,
			},
			body: JSON.stringify({ organization_id: null }),
			signal,
		});

		if (!response.ok) {
			return null;
		}

		const payload: unknown = await response.json();
		const parsed = zedLlmTokenResponseSchema(payload);
		if (parsed instanceof type.errors || !parsed.token.trim()) {
			return null;
		}

		return parsed.token;
	} catch {
		return null;
	}
}

export async function fetchZedModels(options: FetchZedModelsOptions = {}): Promise<ModelSpec<"zed-agent">[] | null> {
	const fetcher = discoveryFetch(options.fetcher);

	try {
		let bearerToken: string | undefined;

		if (options.token) {
			const parsedCreds = parseZedCredentials(options.token);
			if (parsedCreds.userId && parsedCreds.accessToken) {
				// Master credential pair: mint a short-lived LLM token
				const minted = await mintZedLlmToken(parsedCreds.userId, parsedCreds.accessToken, fetcher, options.signal);
				if (!minted) {
					return null;
				}
				bearerToken = minted;
			} else if (parsedCreds.accessToken) {
				// Direct LLM bearer token (e.g. from explicit test or pre-minted token)
				bearerToken = parsedCreds.accessToken;
			}
		}

		const headers: Record<string, string> = {
			[ZED_HEADERS.VERSION]: ZED_APP_VERSION,
			[ZED_HEADERS.CLIENT_X_AI]: "true",
			"Content-Type": "application/json",
		};
		if (bearerToken) {
			headers.Authorization = `Bearer ${bearerToken}`;
		}

		const response = await fetcher(`${ZED_CLOUD_URL}/models`, {
			method: "GET",
			headers,
			signal: options.signal,
		});

		if (!response.ok) {
			return null;
		}

		const payload: unknown = await response.json();
		const parsed = zedListModelsResponseSchema(payload);
		if (parsed instanceof type.errors) {
			return null;
		}

		const specs: ModelSpec<"zed-agent">[] = [];
		for (const model of parsed.models) {
			if (model.is_disabled) continue;

			const isReasoning = model.supports_thinking === true;
			const efforts: Effort[] = [];
			let defaultEffort: Effort | undefined;

			if (model.supported_effort_levels && model.supported_effort_levels.length > 0) {
				for (const level of model.supported_effort_levels) {
					const val = level.value.toLowerCase();
					let effortEnum: Effort | undefined;
					if (
						val === Effort.Low ||
						val === Effort.Medium ||
						val === Effort.High ||
						val === Effort.Max ||
						val === Effort.Minimal ||
						val === Effort.XHigh
					) {
						effortEnum = val;
						efforts.push(val);
					}
					if (level.is_default && effortEnum) {
						defaultEffort = effortEnum;
					}
				}
			}

			specs.push({
				id: model.id,
				name: model.display_name || model.id,
				api: "zed-agent",
				provider: "zed-agent",
				baseUrl: ZED_CLOUD_URL,
				reasoning: isReasoning,
				thinking: isReasoning
					? {
							mode: model.provider === "anthropic" ? "anthropic-adaptive" : "effort",
							efforts: efforts.length > 0 ? efforts : FALLBACK_EFFORTS,
							defaultLevel: defaultEffort ?? Effort.Medium,
						}
					: undefined,
				contextWindow: model.max_token_count || 128_000,
				maxTokens: model.max_output_tokens || 8_192,
				input: model.supports_images ? ["text", "image"] : ["text"],
				supportsTools: model.supports_tools,
				cost: resolveZedModelCost(model.id),
			});
		}

		return specs;
	} catch {
		return null;
	}
}
