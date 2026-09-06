import { scheduler } from "node:timers/promises";
import type { Effort } from "@pk-nerdsaver-ai/pi-catalog/effort";
import { isVertexExpressOpenAIUrl, isVertexRawPredictUrl } from "@pk-nerdsaver-ai/pi-catalog/hosts";
import {
	mapEffortToAnthropicAdaptiveEffort,
	mapEffortToGoogleThinkingLevel,
	minimumSupportedEffort,
	requireSupportedEffort,
	resolveWireModelId,
} from "@pk-nerdsaver-ai/pi-catalog/model-thinking";
import { CATALOG_PROVIDERS, type ProviderCatalogEntry } from "@pk-nerdsaver-ai/pi-catalog/provider-models";
import { $env, $pickenv, extractHttpStatusFromError } from "@pk-nerdsaver-ai/pi-utils";
import { getCustomApi } from "./api-registry";
import { AUTH_RETRY_STEPS, isApiKeyResolver, resolveRetryKey } from "./auth-retry";
import * as AIError from "./error";
import { isUsageLimitOutcome } from "./error/rate-limit";
import { ProviderHttpError } from "./errors";
import type { BedrockOptions } from "./providers/amazon-bedrock";
import type { AnthropicOptions } from "./providers/anthropic";
import type { CursorOptions } from "./providers/cursor";
import type { DevinOptions } from "./providers/devin";
import { isGitLabDuoModel, streamGitLabDuo } from "./providers/gitlab-duo";
import type { GoogleOptions } from "./providers/google";
import { getVertexAccessToken } from "./providers/google-auth";
import type { GoogleGeminiCliOptions } from "./providers/google-gemini-cli";
import type { GoogleInteractionsOptions } from "./providers/google-interactions";
import type { GoogleVertexOptions } from "./providers/google-vertex";
import { isKimiModel, streamKimi } from "./providers/kimi";
import type { OllamaChatOptions } from "./providers/ollama";
import type { OpenAICodexResponsesOptions } from "./providers/openai-codex-responses";
import type { OpenAICompletionsOptions } from "./providers/openai-completions";
import type { OpenAIResponsesOptions } from "./providers/openai-responses";
import { streamPiNative } from "./providers/pi-native-client";
// Heavy provider stream functions are imported lazily via register-builtins,
// which wraps each provider module in a dynamic import. This keeps the
// AWS SDK, google-auth-library, @google/genai, @bufbuild/protobuf, and
// other provider SDKs out of the CLI startup parse graph. The
// gitlab-duo / kimi / synthetic providers stay eager because their modules
// export routing predicates (isGitLabDuoModel, isKimiModel, isSyntheticModel)
// that must be callable synchronously before streaming begins, and their
// modules are thin wrappers with no heavy SDK dependencies.
import {
	streamAnthropic,
	streamAzureOpenAIResponses,
	streamBedrock,
	streamCursor,
	streamDevin,
	streamGoogle,
	streamGoogleGeminiCli,
	streamGoogleVertex,
	streamOllama,
	streamOpenAICodexResponses,
	streamOpenAICompletions,
	streamOpenAIResponses,
} from "./providers/register-builtins";
import { isSyntheticModel, streamSynthetic } from "./providers/synthetic";
import { PROVIDER_REGISTRY } from "./registry";
import type {
	Api,
	AssistantMessage,
	AssistantMessageEvent,
	Context,
	FetchImpl,
	Model,
	OptionsForApi,
	SimpleStreamOptions,
	StreamOptions,
	ThinkingBudgets,
	ToolChoice,
} from "./types";
import { AssistantMessageEventStream } from "./utils/event-stream";
import { resolveProviderMaxInFlightRequests, streamWithProviderSlot } from "./utils/provider-inflight";
import { withRequestDebugFetch } from "./utils/request-debug";
import { THINKING_LOOP_ERROR_MARKER, withGeminiThinkingLoopGuard } from "./utils/thinking-loop";

export { __providerInFlightForTesting, configureProviderMaxInFlightRequests } from "./utils/provider-inflight";

function isGoogleVertexAuthenticatedModel(model: Model<Api>): boolean {
	return (
		model.provider === "google-vertex" &&
		((model.api === "openai-completions" && isVertexExpressOpenAIUrl(model.baseUrl)) ||
			(model.api === "anthropic-messages" && isVertexRawPredictUrl(model.baseUrl)))
	);
}

function createVertexAuthenticatedFetch(options: StreamOptions | undefined): FetchImpl {
	const baseFetch = options?.fetch ?? fetch;
	const vertexFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		const token = await getVertexAccessToken({ signal: options?.signal, fetch: baseFetch });
		const headers = new Headers(init?.headers);
		headers.set("Authorization", `Bearer ${token}`);
		const rewritten = resolveVertexRequest(input);
		const url = rewritten instanceof Request ? rewritten.url : rewritten.toString();
		if (isVertexRawPredictUrl(url)) {
			const bodyText = await readVertexRequestBody(rewritten, init);
			const transformed = transformVertexAnthropicBody(bodyText);
			return baseFetch(url, {
				...init,
				method: init?.method ?? (rewritten instanceof Request ? rewritten.method : "POST"),
				headers,
				body: transformed,
			});
		}
		return baseFetch(rewritten, { ...init, headers });
	};
	return Object.assign(vertexFetch, baseFetch.preconnect ? { preconnect: baseFetch.preconnect } : {});
}

async function readVertexRequestBody(input: string | URL | Request, init: RequestInit | undefined): Promise<string> {
	if (input instanceof Request) return input.clone().text();
	const body = init?.body;
	if (typeof body === "string") return body;
	if (body instanceof Uint8Array) return new TextDecoder().decode(body);
	if (body instanceof ArrayBuffer) return new TextDecoder().decode(body);
	return "";
}

// Vertex Claude rejects the standard Anthropic body shape: the `model` field
// is encoded in the URL path and `anthropic_version: "vertex-2023-10-16"` is
// required in the JSON body instead of the `anthropic-version` HTTP header.
function transformVertexAnthropicBody(bodyText: string): string {
	if (!bodyText) return bodyText;
	try {
		const payload = JSON.parse(bodyText) as Record<string, unknown>;
		delete payload.model;
		payload.anthropic_version = "vertex-2023-10-16";
		return JSON.stringify(payload);
	} catch {
		return bodyText;
	}
}

function resolveVertexRequest(input: string | URL | Request): string | URL | Request {
	const project = $env.GOOGLE_CLOUD_PROJECT || $env.GCP_PROJECT || $env.GCLOUD_PROJECT;
	const location = $env.GOOGLE_VERTEX_LOCATION || $env.GOOGLE_CLOUD_LOCATION || $env.VERTEX_LOCATION;
	if (!project || !location) return input;

	const rewriteUrl = (url: string): string => {
		const hasPlaceholder =
			url.includes("{project}") ||
			url.includes("{location}") ||
			url.includes("%7Bproject%7D") ||
			url.includes("%7Blocation%7D");
		const host = location === "global" ? "aiplatform.googleapis.com" : `${location}-aiplatform.googleapis.com`;
		const rewritten = hasPlaceholder
			? url
					.replace("https://{location}-aiplatform.googleapis.com", `https://${host}`)
					.replace("https://%7Blocation%7D-aiplatform.googleapis.com", `https://${host}`)
					.replaceAll("{project}", encodeURIComponent(project))
					.replaceAll("%7Bproject%7D", encodeURIComponent(project))
					.replaceAll("{location}", encodeURIComponent(location))
					.replaceAll("%7Blocation%7D", encodeURIComponent(location))
			: url;
		return rewritten.replace(":streamRawPredict/v1/messages", ":streamRawPredict");
	};

	if (input instanceof Request) {
		const rewrittenUrl = rewriteUrl(input.url);
		return rewrittenUrl === input.url ? input : new Request(rewrittenUrl, input);
	}
	if (input instanceof URL) {
		const rewrittenUrl = rewriteUrl(input.toString());
		return rewrittenUrl === input.toString() ? input : new URL(rewrittenUrl);
	}
	return rewriteUrl(input);
}

type KeyResolver = string | (() => string | undefined);

const LEGACY_ENV_KEYS: Record<string, KeyResolver> = {
	// Non-provider / search-tool keys and API-name keys not modeled as registry provider defs.
	"azure-openai-responses": "AZURE_OPENAI_API_KEY",
	"llama.cpp": "LLAMA_CPP_API_KEY",
	exa: "EXA_API_KEY",
	jina: "JINA_API_KEY",
	brave: "BRAVE_API_KEY",
};

/**
 * Env fallbacks derived from the catalog table — the single source for plain
 * provider env-var names. Registry defs override with computed resolvers
 * (Foundry/ADC/Bedrock probes); legacy non-provider keys merge last.
 */
const CATALOG_ENTRY_ENV_KEYS = (CATALOG_PROVIDERS as readonly ProviderCatalogEntry[]).flatMap(provider => {
	const envVars = provider.envVars;
	if (!envVars || envVars.length === 0) return [];
	const resolver: KeyResolver = envVars.length === 1 ? envVars[0] : () => $pickenv(...envVars);
	return [[provider.id, resolver] as [string, KeyResolver]];
});

const serviceProviderMap: Record<string, KeyResolver> = {
	...Object.fromEntries(CATALOG_ENTRY_ENV_KEYS),
	...Object.fromEntries(
		PROVIDER_REGISTRY.flatMap(provider =>
			provider.envKeys != null ? [[provider.id, provider.envKeys] as [string, KeyResolver]] : [],
		),
	),
	...LEGACY_ENV_KEYS,
};

/**
 * Get API key for provider from known environment variables, e.g. OPENAI_API_KEY.
 *
 * Will not return API keys for providers that require OAuth tokens.
 * Checks Bun.env, then cwd/.env, then ~/.env.
 */
export function getEnvApiKey(provider: string): string | undefined {
	const resolver = serviceProviderMap[provider];
	if (typeof resolver === "string") {
		return $env[resolver];
	}
	return resolver?.();
}

/**
 * Name of the environment variable that backs `getEnvApiKey` for a provider,
 * when that provider maps to a single named variable (e.g. `github-copilot` →
 * `COPILOT_GITHUB_TOKEN`). Returns undefined for providers whose env fallback
 * is computed (multi-var pickers, Vertex ADC / Bedrock probes, …) since no
 * single variable name describes the source.
 */
export function getEnvApiKeyName(provider: string): string | undefined {
	const resolver = serviceProviderMap[provider];
	return typeof resolver === "string" ? resolver : undefined;
}

/**
 * Enumerate every provider that has an env-var fallback for `getEnvApiKey`.
 * Used by `omp auth-broker migrate --include-env` to discover env-sourced keys
 * that should be uploaded to the broker.
 */
export function listProvidersWithEnvKey(): string[] {
	return Object.keys(serviceProviderMap);
}

export function stream<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	options?: OptionsForApi<TApi>,
): AssistantMessageEventStream {
	return withGeminiThinkingLoopGuard(model, options, opts => streamDispatch(model, context, opts));
}

function streamDispatch<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	options?: OptionsForApi<TApi>,
): AssistantMessageEventStream {
	const requestOptions = withRequestDebugFetch(options as StreamOptions | undefined) as
		| OptionsForApi<TApi>
		| undefined;

	// Check custom API registry first (extension-provided APIs like "vertex-claude-api")
	const customApiProvider = getCustomApi(model.api);
	if (customApiProvider) {
		return customApiProvider.stream(model, context, requestOptions as StreamOptions);
	}

	if (isGitLabDuoModel(model)) {
		const apiKey = (requestOptions as StreamOptions | undefined)?.apiKey || getEnvApiKey(model.provider);
		if (!apiKey) {
			throw new Error(`No API key for provider: ${model.provider}`);
		}
		return streamGitLabDuo(model, context, {
			...(requestOptions as SimpleStreamOptions | undefined),
			apiKey,
		});
	}

	// Vertex AI uses Application Default Credentials, not API keys
	if (model.api === "google-vertex") {
		return streamGoogleVertex(model as Model<"google-vertex">, context, requestOptions as GoogleVertexOptions);
	} else if (model.api === "bedrock-converse-stream") {
		// Bedrock doesn't have any API keys instead it sources credentials from standard AWS env variables or from given AWS profile.
		return streamBedrock(
			model as Model<"bedrock-converse-stream">,
			context,
			(requestOptions || {}) as BedrockOptions,
		);
	}

	const apiKey = requestOptions?.apiKey || getEnvApiKey(model.provider);
	if (!apiKey) {
		throw new Error(`No API key for provider: ${model.provider}`);
	}
	const providerOptions = isGoogleVertexAuthenticatedModel(model)
		? {
				...requestOptions,
				apiKey: "vertex-adc",
				fetch: createVertexAuthenticatedFetch(requestOptions as StreamOptions | undefined),
			}
		: { ...requestOptions, apiKey };

	const api: Api = model.api;
	switch (api) {
		case "anthropic-messages": {
			const anthropicOptions = providerOptions as AnthropicOptions;
			return streamAnthropic(model as Model<"anthropic-messages">, context, {
				...anthropicOptions,
				isOAuth: anthropicOptions.isOAuth ?? model.isOAuth,
			});
		}

		case "openrouter": {
			const useResponses = $env.PI_OPENROUTER_RESPONSES !== "0";
			if (useResponses) {
				return streamOpenAIResponses(model as Model<"openai-responses">, context, providerOptions as any);
			}
			return streamOpenAICompletions(model as Model<"openai-completions">, context, providerOptions as any);
		}

		case "openai-completions":
			return streamOpenAICompletions(model as Model<"openai-completions">, context, providerOptions as any);

		case "openai-responses":
			return streamOpenAIResponses(model as Model<"openai-responses">, context, providerOptions as any);

		case "azure-openai-responses":
			return streamAzureOpenAIResponses(model as Model<"azure-openai-responses">, context, providerOptions as any);

		case "openai-codex-responses":
			return streamOpenAICodexResponses(model as Model<"openai-codex-responses">, context, providerOptions as any);

		case "google-generative-ai":
			return streamGoogle(model as Model<"google-generative-ai">, context, providerOptions);

		case "google-gemini-cli":
			return streamGoogleGeminiCli(
				model as Model<"google-gemini-cli">,
				context,
				providerOptions as GoogleGeminiCliOptions,
			);

		case "ollama-chat":
			return streamOllama(model as Model<"ollama-chat">, context, providerOptions as OllamaChatOptions);

		case "cursor-agent":
			return streamCursor(model as Model<"cursor-agent">, context, providerOptions as CursorOptions);

		case "devin-agent":
			return streamDevin(model as Model<"devin-agent">, context, providerOptions as DevinOptions);

		default:
			throw new Error(`Unhandled API: ${api}`);
	}
}

/** Guarded samples of a thinking-loop stall (initial + re-samples) before the cook pass. */
const THINKING_LOOP_GUARDED_ATTEMPTS = 3;
/** Backoff between thinking-loop re-samples; a loop is a model-side stall, not load. */
const THINKING_LOOP_RESAMPLE_DELAY_MS = 500;

/**
 * The loop guard's synthetic stall: an error terminal that streamed no
 * observable content. A contentful marker error is replay-unsafe output and is
 * never re-sampled.
 */
function isThinkingLoopStall(message: AssistantMessage): boolean {
	if (message.stopReason !== "error" || message.content.length > 0) return false;
	return (
		AIError.is(message.errorId, AIError.Flag.ThinkingLoop) ||
		(message.errorMessage?.includes(THINKING_LOOP_ERROR_MARKER) ?? false)
	);
}

/**
 * Result-path counterpart of the loop guard: re-sample a thinking-loop stall a
 * few times, then let a stubborn loop cook through one unguarded pass instead
 * of surfacing the stall. Streaming consumers keep the raw stall (their retry
 * loop lives in the session); result-awaiting callers have nowhere to retry, so
 * the bounded loop lives here.
 */
async function resultWithThinkingLoopCook<O extends Pick<StreamOptions, "signal" | "loopGuard">>(
	options: O | undefined,
	dispatch: (options: O | undefined) => Promise<AssistantMessage>,
): Promise<AssistantMessage> {
	let result = await dispatch(options);
	for (let attempt = 1; attempt < THINKING_LOOP_GUARDED_ATTEMPTS && isThinkingLoopStall(result); attempt++) {
		await scheduler.wait(THINKING_LOOP_RESAMPLE_DELAY_MS, { signal: options?.signal });
		result = await dispatch(options);
	}
	if (!isThinkingLoopStall(result)) return result;
	await scheduler.wait(THINKING_LOOP_RESAMPLE_DELAY_MS, { signal: options?.signal });
	return dispatch({ ...(options ?? {}), loopGuard: { ...options?.loopGuard, enabled: false } } as O);
}

export async function complete<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	options?: OptionsForApi<TApi>,
): Promise<AssistantMessage> {
	return resultWithThinkingLoopCook(options, opts => stream(model, context, opts).result());
}

type AuthRetryFailure = {
	error: unknown;
	bufferedEvents: AssistantMessageEvent[];
	terminalEvent?: Extract<AssistantMessageEvent, { type: "error" }>;
};

function extractStatusFromAssistantError(message: AssistantMessage): number | undefined {
	if (message.errorStatus !== undefined) return message.errorStatus;
	if (!message.errorMessage) return undefined;
	return extractHttpStatusFromError({ message: message.errorMessage });
}

function isRetryableUpstreamError(error: unknown, status: number | undefined, message: string | undefined): boolean {
	// 401 means the credential is bad. Usage-limit outcomes (Codex's
	// "You have hit your ChatGPT usage limit" or its opaque bare-429 shape,
	// Anthropic's "usage_limit_reached", Google's "resource_exhausted") mean
	// this account is parked but a sibling credential can usually pick the
	// request up. Both are rotatable via `onAuthError` — the auth-gateway maps
	// the former to `invalidateCredentialMatching` and the latter to
	// `markUsageLimitReached`. Informative transient 429 bodies stay in the
	// provider's own backoff layer.
	if (status === 401) return true;
	void error;
	return isUsageLimitOutcome(status, message);
}

function createAssistantAuthError(message: AssistantMessage): Error {
	const text = message.errorMessage ?? "Provider authentication failed";
	const status = extractStatusFromAssistantError(message);
	return status === undefined ? new Error(text) : new ProviderHttpError(text, status);
}

function emitBufferedEvents(stream: AssistantMessageEventStream, events: AssistantMessageEvent[]): void {
	for (const event of events) {
		stream.push(event);
	}
}

export function streamSimple<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	// Per-provider in-flight limit (per-request option or the process-global
	// configuration): gate the entire dispatch — including auth-retry key
	// resolution — behind a cross-process slot. Unlimited providers keep the
	// direct path and its stream object untouched.
	const limit = resolveProviderMaxInFlightRequests(model.provider, options?.maxInFlightRequests);
	if (limit === undefined) {
		return streamSimpleUnlimited(model, context, options);
	}
	return streamWithProviderSlot(model.provider, limit, options?.signal, () =>
		streamSimpleUnlimited(model, context, options),
	);
}

function streamSimpleUnlimited<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const requestOptions = withRequestDebugFetch(options);
	const apiKeyResolver = isApiKeyResolver(requestOptions?.apiKey) ? requestOptions.apiKey : undefined;
	if (apiKeyResolver) {
		const outer = new AssistantMessageEventStream();
		const signal = requestOptions?.signal;
		// One inner attempt against a resolved string key. When
		// `captureAuthFailure` is set, a retryable auth error that arrives before
		// any replay-unsafe event is buffered and returned (so the caller can
		// retry with a fresh key) instead of surfaced. The terminal attempt
		// clears the flag and emits whatever it gets.
		const runAttempt = async (apiKey: string, captureAuthFailure: boolean): Promise<AuthRetryFailure | undefined> => {
			const bufferedEvents: AssistantMessageEvent[] = [];
			let emittedReplayUnsafeEvent = false;
			const flushBuffered = (): void => {
				emitBufferedEvents(outer, bufferedEvents);
				bufferedEvents.length = 0;
			};

			try {
				// Recurse into the unlimited entry point: the public wrapper already
				// holds the provider slot for this request (when one applies).
				const inner = streamSimpleUnlimited(model, context, { ...requestOptions, apiKey });
				for await (const event of inner) {
					if (!emittedReplayUnsafeEvent && event.type === "start") {
						bufferedEvents.push(event);
						continue;
					}
					if (
						!emittedReplayUnsafeEvent &&
						captureAuthFailure &&
						event.type === "error" &&
						isRetryableUpstreamError(
							event.error,
							extractStatusFromAssistantError(event.error),
							event.error.errorMessage,
						)
					) {
						return { error: createAssistantAuthError(event.error), bufferedEvents, terminalEvent: event };
					}
					flushBuffered();
					emittedReplayUnsafeEvent = true;
					outer.push(event);
					if (outer.done) return undefined;
				}
				flushBuffered();
				if (!outer.done) outer.end(await inner.result());
			} catch (error) {
				if (
					!emittedReplayUnsafeEvent &&
					captureAuthFailure &&
					isRetryableUpstreamError(
						error,
						extractHttpStatusFromError(error),
						error instanceof Error ? error.message : undefined,
					)
				) {
					return { error, bufferedEvents };
				}
				flushBuffered();
				outer.fail(error);
			}
			return undefined;
		};
		const emitFailure = (failure: AuthRetryFailure): void => {
			emitBufferedEvents(outer, failure.bufferedEvents);
			if (failure.terminalEvent) {
				outer.push(failure.terminalEvent);
			} else {
				outer.fail(failure.error);
			}
		};

		void (async () => {
			let lastKey: string | undefined;
			try {
				lastKey = (await apiKeyResolver({ lastChance: false, error: undefined, signal })) || undefined;
			} catch (error) {
				// A thrown resolver is a broker/OAuth/network failure, not a missing
				// key — surface the cause instead of masking it as "No API key".
				outer.fail(
					new Error(
						`Failed to resolve API key for provider ${model.provider}: ${error instanceof Error ? error.message : String(error)}`,
						{ cause: error },
					),
				);
				return;
			}
			if (lastKey === undefined) {
				outer.fail(new Error(`No API key for provider: ${model.provider}`));
				return;
			}
			let failure = await runAttempt(lastKey, true);
			if (!failure) return;
			// a/b/c policy: refresh the same account (lastChance=false), then
			// switch to a sibling (lastChance=true). A step is skipped when the
			// resolver yields the same key it just tried or `undefined`; the
			// final step's attempt clears the capture flag so it emits directly.
			for (let step = 0; step < AUTH_RETRY_STEPS.length; step++) {
				// Caller aborted between attempts: don't mint a fresh token or fire
				// another doomed request — emit the captured failure instead.
				if (signal?.aborted) break;
				const nextKey = await resolveRetryKey(apiKeyResolver, AUTH_RETRY_STEPS[step]!, failure.error, signal);
				if (nextKey === undefined || nextKey === lastKey) continue;
				lastKey = nextKey;
				const isLastStep = step === AUTH_RETRY_STEPS.length - 1;
				const next = await runAttempt(nextKey, !isLastStep);
				if (!next) return;
				failure = next;
			}
			emitFailure(failure);
		})();
		return outer;
	}

	// Pi-native transport short-circuits the per-provider dispatch entirely:
	// the gateway resolves provider + credential server-side, so we don't
	// need an `apiKey` from `getEnvApiKey` here — `options.apiKey` carries
	// the gateway bearer instead. Comes BEFORE the custom-API check so
	// extension-registered APIs can't accidentally override a configured
	// pi-native transport.
	if (model.transport === "pi-native") {
		return withGeminiThinkingLoopGuard(model, requestOptions, opts => streamPiNative(model, context, opts));
	}

	// Check custom API registry (extension-provided APIs)
	const customApiProvider = getCustomApi(model.api);
	if (customApiProvider) {
		return withGeminiThinkingLoopGuard(model, requestOptions, opts =>
			customApiProvider.streamSimple(model, context, opts),
		);
	}

	// Vertex AI uses Application Default Credentials, not API keys
	if (model.api === "google-vertex") {
		const providerOptions = mapOptionsForApi(model, requestOptions, undefined);
		return stream(model, context, providerOptions);
	} else if (model.api === "bedrock-converse-stream") {
		// Bedrock doesn't have any API keys instead it sources credentials from standard AWS env variables or from given AWS profile.
		const providerOptions = mapOptionsForApi(model, requestOptions, undefined);
		return stream(model, context, providerOptions);
	}

	// The resolver form is handled by the wrapper above; only a static string
	// key reaches this point.
	const apiKey =
		(typeof requestOptions?.apiKey === "string" ? requestOptions.apiKey : undefined) || getEnvApiKey(model.provider);
	if (!apiKey) {
		throw new Error(`No API key for provider: ${model.provider}`);
	}

	// GitLab Duo - wraps Anthropic/OpenAI behind GitLab AI Gateway direct access tokens
	if (isGitLabDuoModel(model)) {
		return streamGitLabDuo(model, context, {
			...requestOptions,
			apiKey,
		});
	}

	// Kimi Code - route to dedicated handler that wraps OpenAI or Anthropic API
	if (isKimiModel(model)) {
		// Pass raw SimpleStreamOptions - streamKimi handles mapping internally
		return streamKimi(model as Model<"openai-completions">, context, {
			...requestOptions,
			apiKey,
			format: requestOptions?.kimiApiFormat ?? "anthropic",
		});
	}

	// Synthetic - route to dedicated handler that wraps OpenAI or Anthropic API
	if (isSyntheticModel(model)) {
		// Pass raw SimpleStreamOptions - streamSynthetic handles mapping internally
		return streamSynthetic(model as Model<"openai-completions">, context, {
			...requestOptions,
			apiKey,
			format: requestOptions?.syntheticApiFormat ?? "openai", // Default to OpenAI format
		});
	}
	const providerOptions = mapOptionsForApi(model, requestOptions, apiKey);
	return stream(model, context, providerOptions);
}

export async function completeSimple<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	options?: SimpleStreamOptions,
): Promise<AssistantMessage> {
	return resultWithThinkingLoopCook(options, opts => streamSimple(model, context, opts).result());
}

const MIN_OUTPUT_TOKENS = 1024;
// Fallback total output cap for models whose catalog entry has no maxTokens.
const OUTPUT_CAP_WHEN_UNKNOWN = 64_000;
function maxTokensWithThinkingBudget(
	baseMaxTokens: number | undefined,
	modelMaxTokens: number | null,
	thinkingBudget: number,
): number {
	const uncappedMaxTokens = baseMaxTokens === undefined ? OUTPUT_CAP_WHEN_UNKNOWN : baseMaxTokens + thinkingBudget;
	return Math.min(uncappedMaxTokens, modelMaxTokens ?? Number.POSITIVE_INFINITY);
}
export const OUTPUT_FALLBACK_BUFFER = 4000;
const ANTHROPIC_USE_INTERLEAVED_THINKING = Bun.env.PI_NO_INTERLEAVED_THINKING !== "1";

export const ANTHROPIC_THINKING: Record<Effort, number> = {
	minimal: 1024,
	low: 4096,
	medium: 8192,
	high: 16384,
	xhigh: 32768,
	max: 32768,
	ultra: 32768,
};

const GOOGLE_THINKING: Record<Effort, number> = {
	minimal: 1024,
	low: 4096,
	medium: 8192,
	high: 16384,
	xhigh: 24575,
	max: 24575,
	ultra: 24575,
};

const BEDROCK_CLAUDE_THINKING: Record<Effort, number> = {
	minimal: 1024,
	low: 2048,
	medium: 8192,
	high: 16384,
	xhigh: 16384,
	max: 16384,
	ultra: 16384,
};

function resolveBedrockThinkingBudget(
	model: Model<"bedrock-converse-stream">,
	options?: SimpleStreamOptions,
): { budget: number; level: Effort } | null {
	if (!options?.reasoning || !model.reasoning) return null;
	const level = requireSupportedEffort(model, options.reasoning);
	const budget = options.thinkingBudgets?.[level] ?? BEDROCK_CLAUDE_THINKING[level];
	return { budget, level };
}

export function mapAnthropicToolChoice(choice?: ToolChoice): AnthropicOptions["toolChoice"] {
	if (!choice) return undefined;
	if (typeof choice === "string") {
		if (choice === "required") return "any";
		if (choice === "auto" || choice === "none" || choice === "any") return choice;
		return undefined;
	}
	if (choice.type === "tool") {
		return choice.name ? { type: "tool", name: choice.name } : undefined;
	}
	if (choice.type === "function") {
		const name = "function" in choice ? choice.function?.name : choice.name;
		return name ? { type: "tool", name } : undefined;
	}
	return undefined;
}

export function mapGoogleToolChoice(
	choice?: ToolChoice,
): GoogleOptions["toolChoice"] | GoogleGeminiCliOptions["toolChoice"] | GoogleVertexOptions["toolChoice"] {
	if (!choice) return undefined;
	if (typeof choice === "string") {
		if (choice === "required") return "any";
		if (choice === "auto" || choice === "none" || choice === "any") return choice;
		return undefined;
	}
	// Named-tool routing on Google: emit an `ANY`-mode allow-list of one entry,
	// mirroring the Anthropic mapper that returns `{type: "tool", name}`.
	if (choice.type === "tool") {
		return choice.name ? { mode: "ANY", allowedFunctionNames: [choice.name] } : undefined;
	}
	if (choice.type === "function") {
		const name = "function" in choice ? choice.function?.name : choice.name;
		return name ? { mode: "ANY", allowedFunctionNames: [name] } : undefined;
	}
	return undefined;
}

function mapOpenAiToolChoice(choice?: ToolChoice): OpenAICompletionsOptions["toolChoice"] {
	if (!choice) return undefined;
	if (typeof choice === "string") {
		if (choice === "any") return "required";
		if (choice === "auto" || choice === "none" || choice === "required") return choice;
		return undefined;
	}
	if (choice.type === "tool") {
		return choice.name ? { type: "function", function: { name: choice.name } } : undefined;
	}
	if (choice.type === "function") {
		const name = "function" in choice ? choice.function?.name : choice.name;
		return name ? { type: "function", function: { name } } : undefined;
	}
	return undefined;
}

function resolveOpenAiReasoningEffort<TApi extends Api>(
	model: Model<TApi>,
	options?: SimpleStreamOptions,
): Effort | undefined {
	const reasoning = options?.reasoning;
	if (!reasoning || !model.reasoning) return undefined;
	// Models that reason natively but expose no effort dial carry
	// `thinking: undefined` (baked at build time from
	// `compat.supportsReasoningEffort: false` on openai-responses*). The
	// wire-side omitReasoningEffort gate (stream.ts) is the actual strip; returning
	// undefined here avoids a redundant requireSupportedEffort throw that would
	// defeat the gate and surface a confusing "Compaction failed: Thinking effort
	// high is not supported by..." to the user.
	if (!model.thinking) return undefined;
	return requireSupportedEffort(model, reasoning);
}

const castApi = <TApi extends Api>(api: OptionsForApi<TApi>): OptionsForApi<Api> => api as OptionsForApi<Api>;

/**
 * Mandatory-reasoning endpoints (`thinking.requiresEffort`) reject disabled
 * or omitted thinking ("Reasoning is mandatory for this endpoint and cannot
 * be disabled") — clamp to the lowest supported effort instead.
 * `suppressWhenOff` models handle off provider-side via explicit wire
 * suppression. Collapsed pairs interplay: pair derivation strips member
 * flags (off routes to a bare SKU that CAN disable), while identity backfill
 * re-flags pairs whose logical id is itself mandatory (Gemini 3.x) — there
 * the clamp wins and the floored effort routes to the thinking SKU.
 */
function normalizeMandatoryReasoningOptions<TApi extends Api>(
	model: Model<TApi>,
	options?: SimpleStreamOptions,
): SimpleStreamOptions | undefined {
	if (
		!model.reasoning ||
		!model.thinking?.requiresEffort ||
		model.thinking.suppressWhenOff ||
		(options?.reasoning !== undefined && !options.disableReasoning)
	) {
		return options;
	}
	const floor = minimumSupportedEffort(model);
	if (floor === undefined) return options;
	return { ...options, reasoning: floor, disableReasoning: undefined };
}

function mapOptionsForApi<TApi extends Api>(
	model: Model<TApi>,
	rawOptions?: SimpleStreamOptions,
	apiKey?: string,
): OptionsForApi<TApi> {
	const options = normalizeMandatoryReasoningOptions(model, rawOptions);
	const base = {
		temperature: options?.temperature,
		topP: options?.topP,
		topK: options?.topK,
		minP: options?.minP,
		presencePenalty: options?.presencePenalty,
		repetitionPenalty: options?.repetitionPenalty,
		maxTokens: options?.maxTokens ?? model.maxTokens ?? undefined,
		signal: options?.signal,
		apiKey: apiKey ?? (typeof options?.apiKey === "string" ? options.apiKey : undefined),
		cacheRetention: options?.cacheRetention,
		headers: options?.headers,
		initiatorOverride: options?.initiatorOverride,
		maxRetryDelayMs: options?.maxRetryDelayMs,
		metadata: options?.metadata,
		taskBudget: options?.taskBudget,
		sessionId: options?.sessionId,
		promptCacheKey: options?.promptCacheKey,
		streamFirstEventTimeoutMs: options?.streamFirstEventTimeoutMs,
		streamIdleTimeoutMs: options?.streamIdleTimeoutMs,
		providerSessionState: options?.providerSessionState,
		onPayload: options?.onPayload,
		onResponse: options?.onResponse,
		onSseEvent: options?.onSseEvent,
		execHandlers: options?.execHandlers,
		fetch: options?.fetch,
	};

	switch (model.api) {
		case "anthropic-messages": {
			// Explicitly disable thinking when reasoning is not specified or model doesn't support it
			const reasoning = options?.reasoning;
			if (!reasoning || !model.reasoning) {
				return castApi<"anthropic-messages">({
					...base,
					requestModelId: resolveWireModelId(model, undefined),
					thinkingEnabled: false,
					toolChoice: mapAnthropicToolChoice(options?.toolChoice),
					thinkingDisplay: options?.hideThinkingSummary ? "omitted" : undefined,
					serviceTier: options?.serviceTier,
				});
			}

			let thinkingBudget = options.thinkingBudgets?.[reasoning] ?? ANTHROPIC_THINKING[reasoning];
			if (thinkingBudget <= 0) {
				return castApi<"anthropic-messages">({
					...base,
					requestModelId: resolveWireModelId(model, undefined),
					thinkingEnabled: false,
					toolChoice: mapAnthropicToolChoice(options?.toolChoice),
					thinkingDisplay: options?.hideThinkingSummary ? "omitted" : undefined,
					serviceTier: options?.serviceTier,
				});
			}

			// For Opus 4.6+ and Sonnet 4.6+: use adaptive thinking with effort level
			// For older models: use budget-based thinking
			if (model.thinking?.mode === "anthropic-adaptive") {
				const effort = mapEffortToAnthropicAdaptiveEffort(model, reasoning);
				return castApi<"anthropic-messages">({
					...base,
					requestModelId: resolveWireModelId(model, reasoning),
					thinkingEnabled: true,
					effort,
					toolChoice: mapAnthropicToolChoice(options?.toolChoice),
					thinkingDisplay: options?.hideThinkingSummary ? "omitted" : undefined,
					serviceTier: options?.serviceTier,
				});
			}

			// Budget-effort models (e.g. GLM-5.2 behind Anthropic-compatible
			// gateways) pair `thinking.budget_tokens` with `output_config.effort`;
			// forward the requested level so the provider can map it.
			const budgetEffortReasoning = model.thinking?.mode === "anthropic-budget-effort" ? reasoning : undefined;

			if (ANTHROPIC_USE_INTERLEAVED_THINKING) {
				return castApi<"anthropic-messages">({
					...base,
					requestModelId: resolveWireModelId(model, reasoning),
					thinkingEnabled: true,
					thinkingBudgetTokens: thinkingBudget,
					reasoning: budgetEffortReasoning,
					toolChoice: mapAnthropicToolChoice(options?.toolChoice),
					thinkingDisplay: options?.hideThinkingSummary ? "omitted" : undefined,
					serviceTier: options?.serviceTier,
				});
			}

			// Caller's maxTokens is desired output, so add thinking budget on top. With no caller/model cap, use a finite total fallback.
			const maxTokens = maxTokensWithThinkingBudget(base.maxTokens, model.maxTokens, thinkingBudget);

			// If not enough room for thinking + output, reduce thinking budget
			if (maxTokens <= thinkingBudget) {
				thinkingBudget = maxTokens - MIN_OUTPUT_TOKENS;
			}

			// If thinking budget is too low, disable thinking
			if (thinkingBudget <= 0) {
				return castApi<"anthropic-messages">({
					...base,
					requestModelId: resolveWireModelId(model, undefined),
					thinkingEnabled: false,
					toolChoice: mapAnthropicToolChoice(options?.toolChoice),
					thinkingDisplay: options?.hideThinkingSummary ? "omitted" : undefined,
					serviceTier: options?.serviceTier,
				});
			} else {
				return castApi<"anthropic-messages">({
					...base,
					maxTokens,
					requestModelId: resolveWireModelId(model, reasoning),
					thinkingEnabled: true,
					thinkingBudgetTokens: thinkingBudget,
					reasoning: budgetEffortReasoning,
					toolChoice: mapAnthropicToolChoice(options?.toolChoice),
					thinkingDisplay: options?.hideThinkingSummary ? "omitted" : undefined,
					serviceTier: options?.serviceTier,
				});
			}
		}

		case "bedrock-converse-stream": {
			const bedrockBase: BedrockOptions = {
				...base,
				reasoning: options?.reasoning,
				thinkingBudgets: options?.thinkingBudgets,
				toolChoice: mapAnthropicToolChoice(options?.toolChoice),
				thinkingDisplay: options?.hideThinkingSummary ? "omitted" : undefined,
			};
			// Adaptive mode sends effort directly, no budget_tokens — skip budget inflation.
			if (model.thinking?.mode === "anthropic-adaptive") {
				return castApi<"bedrock-converse-stream">(bedrockBase);
			}
			const budgetInfo = resolveBedrockThinkingBudget(model as Model<"bedrock-converse-stream">, options);
			if (!budgetInfo) return bedrockBase as OptionsForApi<TApi>;
			let maxTokens = bedrockBase.maxTokens ?? model.maxTokens ?? OUTPUT_CAP_WHEN_UNKNOWN;
			let thinkingBudgets = bedrockBase.thinkingBudgets;
			if (maxTokens <= budgetInfo.budget) {
				const desiredMaxTokens = Math.min(
					model.maxTokens ?? Number.POSITIVE_INFINITY,
					budgetInfo.budget + MIN_OUTPUT_TOKENS,
				);
				if (desiredMaxTokens > maxTokens) {
					maxTokens = desiredMaxTokens;
				}
			}
			if (maxTokens <= budgetInfo.budget) {
				const adjustedBudget = Math.max(0, maxTokens - MIN_OUTPUT_TOKENS);
				thinkingBudgets = { ...(thinkingBudgets ?? {}), [budgetInfo.level]: adjustedBudget };
			}
			return castApi<"bedrock-converse-stream">({ ...bedrockBase, maxTokens, thinkingBudgets });
		}

		case "openrouter": {
			const useResponses = $env.PI_OPENROUTER_RESPONSES !== "0";
			if (useResponses) {
				return castApi<"openai-responses">({
					...base,
					reasoning: resolveOpenAiReasoningEffort(model, options),
					toolChoice: mapOpenAiToolChoice(options?.toolChoice),
					serviceTier: options?.serviceTier,
					reasoningSummary: options?.hideThinkingSummary ? null : undefined,
					openrouterVariant: options?.openrouterVariant,
					maxTokensExplicit: rawOptions?.maxTokens !== undefined,
					disableReasoning: options?.disableReasoning,
				});
			}
			return castApi<"openai-completions">({
				...base,
				reasoning: resolveOpenAiReasoningEffort(model, options),
				disableReasoning: options?.disableReasoning,
				toolChoice: mapOpenAiToolChoice(options?.toolChoice),
				serviceTier: options?.serviceTier,
				openrouterVariant: options?.openrouterVariant,
				maxTokensExplicit: rawOptions?.maxTokens !== undefined,
			});
		}

		case "openai-completions":
			return castApi<"openai-completions">({
				...base,
				reasoning: resolveOpenAiReasoningEffort(model, options),
				disableReasoning: options?.disableReasoning,
				toolChoice: mapOpenAiToolChoice(options?.toolChoice),
				serviceTier: options?.serviceTier,
				openrouterVariant: options?.openrouterVariant,
				maxTokensExplicit: rawOptions?.maxTokens !== undefined,
			});

		case "openai-responses":
			return castApi<"openai-responses">({
				...base,
				reasoning: resolveOpenAiReasoningEffort(model, options),
				toolChoice: mapOpenAiToolChoice(options?.toolChoice),
				serviceTier: options?.serviceTier,
				textVerbosity: options?.textVerbosity as OpenAIResponsesOptions["textVerbosity"],
				reasoningSummary: options?.hideThinkingSummary ? null : undefined,
				openrouterVariant: options?.openrouterVariant,
				maxTokensExplicit: rawOptions?.maxTokens !== undefined,
				disableReasoning: options?.disableReasoning,
			});

		case "azure-openai-responses":
			return castApi<"azure-openai-responses">({
				...base,
				reasoning: resolveOpenAiReasoningEffort(model, options),
				toolChoice: mapOpenAiToolChoice(options?.toolChoice),
				serviceTier: options?.serviceTier,
				reasoningSummary: options?.hideThinkingSummary ? null : undefined,
			});

		case "openai-codex-responses":
			return castApi<"openai-codex-responses">({
				...base,
				reasoning: resolveOpenAiReasoningEffort(model, options),
				toolChoice: mapOpenAiToolChoice(options?.toolChoice),
				serviceTier: options?.serviceTier,
				textVerbosity: options?.textVerbosity as OpenAICodexResponsesOptions["textVerbosity"],
				preferWebsockets: options?.preferWebsockets,
				reasoningSummary: options?.hideThinkingSummary ? null : undefined,
			});

		case "google-generative-ai": {
			// Explicitly disable thinking when reasoning is not specified or model doesn't support it
			// This is needed because Gemini has "dynamic thinking" enabled by default
			const reasoning = options?.reasoning;
			if (!reasoning || !model.reasoning) {
				return castApi<"google-generative-ai">({
					...base,
					thinking: { enabled: false },
					toolChoice: mapGoogleToolChoice(options?.toolChoice),
				});
			}

			const googleModel = model as Model<"google-generative-ai">;
			const effort = requireSupportedEffort(googleModel, reasoning);

			// Gemini 3+ models use thinkingLevel exclusively instead of thinkingBudget.
			// https://ai.google.dev/gemini-api/docs/thinking#set-budget
			if (googleModel.thinking?.mode === "google-level") {
				return castApi<"google-generative-ai">({
					...base,
					thinking: {
						enabled: true,
						level: mapEffortToGoogleThinkingLevel(effort),
					},
					toolChoice: mapGoogleToolChoice(options?.toolChoice),
				});
			}

			return castApi<"google-gemini-cli">({
				...base,
				thinking: {
					enabled: true,
					budgetTokens: getGoogleBudget(googleModel, effort, options?.thinkingBudgets),
				},
				toolChoice: mapGoogleToolChoice(options?.toolChoice),
			});
		}

		case "google-gemini-cli": {
			const reasoning = options?.reasoning;
			const toolChoice = mapGoogleToolChoice(options?.toolChoice);
			if (reasoning && model.reasoning) {
				const effort = requireSupportedEffort(model, reasoning);

				// Gemini 3+ models use thinkingLevel instead of thinkingBudget
				if (model.thinking?.mode === "google-level") {
					return castApi<"google-gemini-cli">({
						...base,
						requestModelId: resolveWireModelId(model, effort),
						thinking: {
							enabled: true,
							level: mapEffortToGoogleThinkingLevel(effort),
						},
						toolChoice,
						antigravityEndpointMode: options?.antigravityEndpointMode,
					});
				}

				let thinkingBudget =
					options.thinkingBudgets?.[effort] ?? model.thinking?.effortBudgets?.[effort] ?? GOOGLE_THINKING[effort];

				// Caller's maxTokens is desired output, so add thinking budget on top. With no caller/model cap, use a finite total fallback.
				const maxTokens = maxTokensWithThinkingBudget(base.maxTokens, model.maxTokens, thinkingBudget);

				// If not enough room for thinking + output, reduce thinking budget
				if (maxTokens <= thinkingBudget) {
					thinkingBudget = Math.max(0, maxTokens - MIN_OUTPUT_TOKENS);
				}

				if (thinkingBudget > 0) {
					return castApi<"google-gemini-cli">({
						...base,
						maxTokens,
						requestModelId: resolveWireModelId(model, effort),
						thinking: { enabled: true, budgetTokens: thinkingBudget },
						toolChoice,
						antigravityEndpointMode: options?.antigravityEndpointMode,
					});
				}
				// Budget clamped to zero — fall through to the thinking-off path.
			}

			const thinking: GoogleGeminiCliOptions["thinking"] = { enabled: false };
			if (model.reasoning && model.thinking?.suppressWhenOff) {
				// CCA re-applies the per-id baked server default when the config
				// is omitted; suppression must be explicit on the wire.
				thinking.suppress = model.thinking.mode === "google-level" ? { level: "MINIMAL" } : { budget: 0 };
			}
			return castApi<"google-gemini-cli">({
				...base,
				requestModelId: resolveWireModelId(model, undefined),
				thinking,
				toolChoice,
				antigravityEndpointMode: options?.antigravityEndpointMode,
			});
		}

		case "google-vertex": {
			// Explicitly disable thinking when reasoning is not specified or model doesn't support it
			const reasoning = options?.reasoning;
			if (!reasoning || !model.reasoning) {
				return castApi<"google-vertex">({
					...base,
					thinking: { enabled: false },
					toolChoice: mapGoogleToolChoice(options?.toolChoice),
				});
			}

			const vertexModel = model as Model<"google-vertex">;
			const effort = requireSupportedEffort(vertexModel, reasoning);
			const geminiModel = vertexModel as unknown as Model<"google-generative-ai">;

			if (geminiModel.thinking?.mode === "google-level") {
				return castApi<"google-vertex">({
					...base,
					thinking: {
						enabled: true,
						level: mapEffortToGoogleThinkingLevel(effort),
					},
					toolChoice: mapGoogleToolChoice(options?.toolChoice),
				});
			}

			return castApi<"google-vertex">({
				...base,
				thinking: {
					enabled: true,
					budgetTokens: getGoogleBudget(geminiModel, effort, options?.thinkingBudgets),
				},
				toolChoice: mapGoogleToolChoice(options?.toolChoice),
			});
		}

		case "google-interactions": {
			return castApi<"google-interactions">({
				...base,
				apiKey,
				environment: "browser",
				enablePromptInjectionDetection: true,
			} satisfies GoogleInteractionsOptions);
		}

		case "ollama-chat":
			return castApi<"ollama-chat">({
				...base,
				reasoning: resolveOpenAiReasoningEffort(model, options),
				disableReasoning: options?.disableReasoning,
				toolChoice: options?.toolChoice,
			});

		case "cursor-agent": {
			const execHandlers = options?.cursorExecHandlers ?? options?.execHandlers;
			const onToolResult = options?.cursorOnToolResult ?? execHandlers?.onToolResult;
			return castApi<"cursor-agent">({
				...base,
				execHandlers,
				onToolResult,
			});
		}

		case "devin-agent": {
			const devinModel = model as Model<"devin-agent">;
			const effort =
				devinModel.reasoning && options?.reasoning && !options.disableReasoning
					? requireSupportedEffort(devinModel, options.reasoning)
					: undefined;
			return castApi<"devin-agent">({
				...base,
				chatModelUid: resolveWireModelId(devinModel, effort),
				stopSequences: options?.stopSequences,
			});
		}

		default:
			throw new Error(`Unhandled API in mapOptionsForApi: ${model.api}`);
	}
}

function getGoogleBudget(
	model: Model<"google-generative-ai">,
	effort: Effort,
	customBudgets?: ThinkingBudgets,
): number {
	requireSupportedEffort(model, effort);

	// Custom budgets take precedence if provided for this level
	if (customBudgets?.[effort] !== undefined) {
		return customBudgets[effort]!;
	}

	// See https://ai.google.dev/gemini-api/docs/thinking#set-budget
	if (model.id.includes("2.5-")) {
		switch (effort) {
			case "minimal":
				return 128;
			case "low":
				return 2048;
			case "medium":
				return 8192;
			default:
				return model.id.includes("2.5-flash") ? 24576 : 32768;
		}
	}

	// Unknown model - use dynamic
	return -1;
}
