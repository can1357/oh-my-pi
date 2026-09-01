import { type } from "@oh-my-pi/omptype";
import type { FetchImpl, ModelCost, ModelSpec, ZedWireProvider } from "../types";
import { discoveryFetch } from "../utils";
import { parseZedCredentials, ZED_APP_VERSION, ZED_CLOUD_URL, ZED_HEADERS } from "../wire/zed";

const zedLanguageModelSchema = type({
	provider: "string",
	id: "string",
	"display_name?": "string",
	"max_token_count?": "number",
	"max_output_tokens?": "number",
	"supports_tools?": "boolean",
	"supports_images?": "boolean",
	"supports_thinking?": "boolean",
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

const ZED_DISCOVERY_TIMEOUT_MS = 10_000;
const ZED_LLM_TOKEN_TIMEOUT_MS = 10_000;

/**
 * Uses a cancellable timer rather than the native abort-timeout helper so
 * successful fast discovery requests do not leave armed timeout signals for
 * concurrent GC to trip over later.
 */
async function withZedDiscoveryTimeout<T>(
	timeoutMs: number,
	signal: AbortSignal | undefined,
	run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
	const timeoutController = new AbortController();
	const timer = setTimeout(
		() => timeoutController.abort(new DOMException("The operation timed out.", "TimeoutError")),
		timeoutMs,
	);
	const requestSignal = signal ? AbortSignal.any([signal, timeoutController.signal]) : timeoutController.signal;
	try {
		return await run(requestSignal);
	} finally {
		clearTimeout(timer);
	}
}

const ZED_NEUTRAL_COST: ModelCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

function parseZedWireProvider(provider: string): ZedWireProvider | undefined {
	if (provider === "anthropic" || provider === "open_ai" || provider === "google" || provider === "x_ai") {
		return provider;
	}
	if (provider === "openai") return "open_ai";
	if (provider === "xai") return "x_ai";
	return undefined;
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
		return await withZedDiscoveryTimeout(ZED_LLM_TOKEN_TIMEOUT_MS, signal, async requestSignal => {
			const response = await fetcher(`${ZED_CLOUD_URL}/client/llm_tokens`, {
				method: "POST",
				headers: {
					Authorization: `${userId} ${accessToken}`,
					"Content-Type": "application/json",
					[ZED_HEADERS.VERSION]: ZED_APP_VERSION,
				},
				body: JSON.stringify({ organization_id: null }),
				signal: requestSignal,
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
		});
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

		const payload = await withZedDiscoveryTimeout(ZED_DISCOVERY_TIMEOUT_MS, options.signal, async signal => {
			const response = await fetcher(`${ZED_CLOUD_URL}/models`, {
				method: "GET",
				headers,
				signal,
			});

			if (!response.ok) {
				return null;
			}

			return (await response.json()) as unknown;
		});

		if (payload === null) {
			return null;
		}

		const parsed = zedListModelsResponseSchema(payload);
		if (parsed instanceof type.errors) {
			return null;
		}

		const specs: ModelSpec<"zed-agent">[] = [];
		for (const model of parsed.models) {
			if (model.is_disabled) continue;

			const isReasoning = model.supports_thinking === true;

			specs.push({
				id: model.id,
				name: model.display_name || model.id,
				api: "zed-agent",
				provider: "zed-agent",
				baseUrl: ZED_CLOUD_URL,
				reasoning: isReasoning,
				contextWindow: model.max_token_count || 128_000,
				maxTokens: model.max_output_tokens || 8_192,
				input: model.supports_images ? ["text", "image"] : ["text"],
				supportsTools: model.supports_tools,
				cost: ZED_NEUTRAL_COST,
				compat: {
					provider: parseZedWireProvider(model.provider),
				},
			});
		}

		return specs;
	} catch {
		return null;
	}
}
