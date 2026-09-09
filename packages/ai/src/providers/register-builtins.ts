/**
 * Lazy provider module loading.
 *
 * Each provider module is loaded only when its stream function is first called.
 * This avoids eagerly importing heavy SDK dependencies (e.g., openai) at
 * startup. The loaded module promise is cached so subsequent calls
 * reuse the same import.
 *
 * NOTE: stream.ts currently imports providers directly, so this file is not yet
 * wired into the main streaming path. It provides the infrastructure for lazy
 * loading that can be integrated when stream.ts is refactored.
 */

import type { CompatOf } from "@oh-my-pi/pi-catalog/types";
import * as AIError from "../error";
import type {
	Api,
	AssistantMessage,
	AssistantMessageEvent,
	AssistantMessageEventStream,
	Context,
	Model,
	OptionsForApi,
} from "../types";
import { type AbortSourceTracker, createAbortSourceTracker } from "../utils/abort";
import { AssistantMessageEventStream as EventStreamImpl } from "../utils/event-stream";
import {
	getOpenAIStreamFirstEventTimeoutMs,
	getOpenAIStreamIdleTimeoutMs,
	getStreamFirstEventTimeoutMs,
	getStreamIdleTimeoutMs,
	iterateWithIdleTimeout,
} from "../utils/idle-iterator";
import type { BedrockOptions } from "./amazon-bedrock";
import type { AnthropicOptions } from "./anthropic";
import type { AzureOpenAIResponsesOptions } from "./azure-openai-responses";
import type { CursorOptions } from "./cursor";
import type { DevinOptions } from "./devin";
import type { GoogleOptions } from "./google";
import type { GoogleGeminiCliOptions } from "./google-gemini-cli";
import type { GoogleVertexOptions } from "./google-vertex";
import type { OllamaChatOptions } from "./ollama";
import type { OpenAICodexResponsesOptions } from "./openai-codex-responses";
import type { OpenAICompletionsOptions } from "./openai-completions";
import type { OpenAIResponsesOptions } from "./openai-responses";

// ---------------------------------------------------------------------------
// Lazy provider module shape
// ---------------------------------------------------------------------------

interface LazyProviderModule<TApi extends Api> {
	stream: (model: Model<TApi>, context: Context, options: OptionsForApi<TApi>) => AsyncIterable<AssistantMessageEvent>;
}

interface AnthropicProviderModule {
	streamAnthropic: (
		model: Model<"anthropic-messages">,
		context: Context,
		options: AnthropicOptions,
	) => AssistantMessageEventStream;
}

interface AzureOpenAIResponsesProviderModule {
	streamAzureOpenAIResponses: (
		model: Model<"azure-openai-responses">,
		context: Context,
		options: AzureOpenAIResponsesOptions,
	) => AssistantMessageEventStream;
}

interface GoogleProviderModule {
	streamGoogle: (
		model: Model<"google-generative-ai">,
		context: Context,
		options: GoogleOptions,
	) => AssistantMessageEventStream;
}

interface GoogleGeminiCliProviderModule {
	streamGoogleGeminiCli: (
		model: Model<"google-gemini-cli">,
		context: Context,
		options: GoogleGeminiCliOptions,
	) => AssistantMessageEventStream;
}

interface GoogleVertexProviderModule {
	streamGoogleVertex: (
		model: Model<"google-vertex">,
		context: Context,
		options: GoogleVertexOptions,
	) => AssistantMessageEventStream;
}

interface OpenAICodexResponsesProviderModule {
	streamOpenAICodexResponses: (
		model: Model<"openai-codex-responses">,
		context: Context,
		options: OpenAICodexResponsesOptions,
	) => AssistantMessageEventStream;
}

interface OpenAICompletionsProviderModule {
	streamOpenAICompletions: (
		model: Model<"openai-completions">,
		context: Context,
		options: OpenAICompletionsOptions,
	) => AssistantMessageEventStream;
}

interface OpenAIResponsesProviderModule {
	streamOpenAIResponses: (
		model: Model<"openai-responses">,
		context: Context,
		options: OpenAIResponsesOptions,
	) => AssistantMessageEventStream;
}

interface OllamaProviderModule {
	streamOllama: (
		model: Model<"ollama-chat">,
		context: Context,
		options: OllamaChatOptions,
	) => AssistantMessageEventStream;
}

interface CursorProviderModule {
	streamCursor: (
		model: Model<"cursor-agent">,
		context: Context,
		options: CursorOptions,
	) => AssistantMessageEventStream;
}

interface DevinProviderModule {
	streamDevin: (model: Model<"devin-agent">, context: Context, options: DevinOptions) => AssistantMessageEventStream;
}

interface BedrockProviderModule {
	streamBedrock: (
		model: Model<"bedrock-converse-stream">,
		context: Context,
		options: BedrockOptions,
	) => AssistantMessageEventStream;
}

// ---------------------------------------------------------------------------
// Module-level lazy promise caches
// ---------------------------------------------------------------------------

let anthropicProviderModulePromise: Promise<LazyProviderModule<"anthropic-messages">> | undefined;
let azureOpenAIResponsesProviderModulePromise: Promise<LazyProviderModule<"azure-openai-responses">> | undefined;
let googleProviderModulePromise: Promise<LazyProviderModule<"google-generative-ai">> | undefined;
let googleGeminiCliProviderModulePromise: Promise<LazyProviderModule<"google-gemini-cli">> | undefined;
let googleVertexProviderModulePromise: Promise<LazyProviderModule<"google-vertex">> | undefined;
let openAICodexResponsesProviderModulePromise: Promise<LazyProviderModule<"openai-codex-responses">> | undefined;
let openAICompletionsProviderModulePromise: Promise<LazyProviderModule<"openai-completions">> | undefined;
let openAIResponsesProviderModulePromise: Promise<LazyProviderModule<"openai-responses">> | undefined;
let ollamaProviderModulePromise: Promise<LazyProviderModule<"ollama-chat">> | undefined;
let cursorProviderModulePromise: Promise<LazyProviderModule<"cursor-agent">> | undefined;
let cursorProviderModuleOverride: LazyProviderModule<"cursor-agent"> | undefined;
let devinProviderModulePromise: Promise<LazyProviderModule<"devin-agent">> | undefined;
let bedrockProviderModuleOverride: LazyProviderModule<"bedrock-converse-stream"> | undefined;
let bedrockProviderModulePromise: Promise<LazyProviderModule<"bedrock-converse-stream">> | undefined;

export function setBedrockProviderModule(module: BedrockProviderModule): void {
	bedrockProviderModuleOverride = {
		stream: module.streamBedrock,
	};
}

export function setCursorProviderModule(module: CursorProviderModule): void {
	cursorProviderModuleOverride = {
		stream: module.streamCursor,
	};
}

// ---------------------------------------------------------------------------
// Stream forwarding / error helpers
// ---------------------------------------------------------------------------

const LAZY_STREAM_IDLE_TIMEOUT_ERROR = "Provider stream stalled while waiting for the next event";
const LAZY_STREAM_FIRST_EVENT_TIMEOUT_ERROR = "Provider stream timed out while waiting for the first event";

function hasFinalResult(
	source: AsyncIterable<AssistantMessageEvent>,
): source is AsyncIterable<AssistantMessageEvent> & { result(): Promise<AssistantMessage> } {
	return typeof (source as { result?: unknown }).result === "function";
}

/**
 * floor used when neither caller option nor env var pins a value. Generic env
 * vars (`PI_STREAM_FIRST_EVENT_TIMEOUT_MS`, `PI_STREAM_IDLE_TIMEOUT_MS`) still
 * take precedence unless a provider opts into OpenAI-family idle flooring for
 * local backends that users historically tuned with `PI_OPENAI_STREAM_IDLE_TIMEOUT_MS`.
 */
interface LazyStreamLimits {
	defaultFirstEventTimeoutMs?: number;
	defaultIdleTimeoutMs?: number;
	/**
	 * The provider implementation already wraps its upstream transport with
	 * stream timeouts. Keep the lazy loader from racing it with generic errors.
	 */
	providerHandlesStreamTimeouts?: boolean;
	/**
	 * The provider retries or fails over when no first event arrives, while the
	 * lazy wrapper continues to own steady-state idle detection.
	 */
	providerHandlesFirstEventTimeouts?: boolean;
	/**
	 * Apply OpenAI-family idle timeout precedence in the lazy wrapper. Used by
	 * local backends whose users historically tune slow prompt-processing gaps
	 * with `PI_OPENAI_STREAM_IDLE_TIMEOUT_MS`.
	 */
	openAIIdleEnvFloorsFirstEvent?: boolean;
}
/**
 * Cloud Code Assist owns first-event detection because Antigravity can return
 * successful headers and then never emit an SSE event. Keeping the watchdog in
 * the provider lets it fail over before surfacing an error; the lazy wrapper
 * still catches post-first-event stalls.
 */
const GOOGLE_GEMINI_CLI_LAZY_STREAM_LIMITS: LazyStreamLimits = {
	providerHandlesFirstEventTimeouts: true,
};

const PROVIDER_HANDLED_STREAM_TIMEOUTS: LazyStreamLimits = {
	providerHandlesStreamTimeouts: true,
};

const OPENAI_IDLE_FLOORED_LAZY_STREAM_LIMITS: LazyStreamLimits = {
	openAIIdleEnvFloorsFirstEvent: true,
};

function forwardStream<TApi extends Api>(
	target: EventStreamImpl,
	source: AsyncIterable<AssistantMessageEvent>,
	model: Model<TApi>,
	options: OptionsForApi<TApi>,
	abortTracker: AbortSourceTracker,
	limits?: LazyStreamLimits,
): void {
	(async () => {
		try {
			const providerHandlesStreamTimeouts = limits?.providerHandlesStreamTimeouts === true;
			const providerHandlesFirstEventTimeouts = limits?.providerHandlesFirstEventTimeouts === true;
			// Per-model catalog compat can widen the fallback watchdog for hosts
			// with no keepalive events (e.g. Bedrock reasoning models that go
			// quiet for minutes mid-thinking, issue #4758). Caller options and
			// env overrides still take precedence over the compat fallback. The
			// annotated local up-casts the generic CompatOf<TApi> by assignment,
			// so any compat shape redeclaring `streamIdleTimeoutMs` with another
			// type is a compile error here.
			const compat: CompatOf<Api> | undefined = model.compat;
			const compatIdleTimeoutMs =
				compat !== undefined && "streamIdleTimeoutMs" in compat ? compat.streamIdleTimeoutMs : undefined;
			const idleTimeoutFallbackMs = compatIdleTimeoutMs ?? limits?.defaultIdleTimeoutMs;
			const idleTimeoutMs = providerHandlesStreamTimeouts
				? undefined
				: (options.streamIdleTimeoutMs ??
					(limits?.openAIIdleEnvFloorsFirstEvent
						? getOpenAIStreamIdleTimeoutMs(idleTimeoutFallbackMs)
						: getStreamIdleTimeoutMs(idleTimeoutFallbackMs)));
			const firstItemTimeoutMs =
				providerHandlesStreamTimeouts || providerHandlesFirstEventTimeouts
					? 0
					: (options.streamFirstEventTimeoutMs ??
						(limits?.openAIIdleEnvFloorsFirstEvent
							? getOpenAIStreamFirstEventTimeoutMs(idleTimeoutMs, limits.defaultFirstEventTimeoutMs)
							: getStreamFirstEventTimeoutMs(idleTimeoutMs, limits?.defaultFirstEventTimeoutMs)));
			// Providers with a server-driven local tool bridge (e.g. the Cursor
			// exec channel) mark their stream busy while a local tool runs; the
			// watchdog must not read that silence as a provider stall (#4593).
			const localWorkSource = source instanceof EventStreamImpl ? source : undefined;
			const watchedSource = iterateWithIdleTimeout(source, {
				idleTimeoutMs,
				firstItemTimeoutMs,
				errorMessage: LAZY_STREAM_IDLE_TIMEOUT_ERROR,
				firstItemErrorMessage: LAZY_STREAM_FIRST_EVENT_TIMEOUT_ERROR,
				onIdle: () => abortTracker.abortLocally(new AIError.StreamTimeoutError(LAZY_STREAM_IDLE_TIMEOUT_ERROR)),
				onFirstItemTimeout: () =>
					abortTracker.abortLocally(new AIError.StreamTimeoutError(LAZY_STREAM_FIRST_EVENT_TIMEOUT_ERROR)),
				abortSignal: options.signal,
				// The synthetic `start` event is yielded immediately by every provider before
				// the upstream model has emitted any tokens. Treating it as the first "real"
				// item would flip the watchdog from `firstItemTimeoutMs` to the much shorter
				// `idleTimeoutMs` while we're still legitimately waiting on the model's
				// first response (slow first-token from reasoning models, cold proxies, etc.).
				isProgressItem: event => (event as AssistantMessageEvent).type !== "start",
				hasPendingLocalWork: localWorkSource ? () => localWorkSource.hasPendingLocalWork : undefined,
			});

			for await (const event of watchedSource) {
				target.push(event);
			}
			if (hasFinalResult(source)) {
				target.end(await source.result());
			} else {
				target.end();
			}
		} catch (error) {
			const stopReason = abortTracker.wasCallerAbort() ? "aborted" : "error";
			const message = createLazyLoadErrorMessage(model, error, stopReason);
			target.push({ type: "error", reason: stopReason, error: message });
			target.end(message);
		}
	})();
}

function createLazyLoadErrorMessage<TApi extends Api>(
	model: Model<TApi>,
	error: unknown,
	stopReason: Extract<AssistantMessage["stopReason"], "aborted" | "error"> = "error",
): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		errorId: stopReason === "error" ? AIError.classify(error, model.api) || undefined : undefined,
		errorMessage:
			stopReason === "aborted" ? "Request was aborted" : error instanceof Error ? error.message : String(error),
		timestamp: Date.now(),
	};
}

// ---------------------------------------------------------------------------
// Generic lazy stream factory
// ---------------------------------------------------------------------------

function createLazyStream<TApi extends Api>(
	loadModule: () => Promise<LazyProviderModule<TApi>>,
	limits?: LazyStreamLimits,
): (model: Model<TApi>, context: Context, options: OptionsForApi<TApi>) => EventStreamImpl {
	return (model, context, options) => {
		const outer = new EventStreamImpl();
		const streamOptions = (options ?? {}) as OptionsForApi<TApi>;

		loadModule()
			.then(module => {
				const abortTracker = createAbortSourceTracker(streamOptions.signal);
				const providerOptions = { ...streamOptions, signal: abortTracker.requestSignal } as OptionsForApi<TApi>;
				const inner = module.stream(model, context, providerOptions);
				forwardStream(outer, inner, model, streamOptions, abortTracker, limits);
			})
			.catch(error => {
				const message = createLazyLoadErrorMessage(model, error);
				outer.push({ type: "error", reason: "error", error: message });
				outer.end(message);
			});

		return outer;
	};
}

// ---------------------------------------------------------------------------
// Module loaders (one per provider, cached via ||=)
// ---------------------------------------------------------------------------

function loadAnthropicProviderModule(): Promise<LazyProviderModule<"anthropic-messages">> {
	anthropicProviderModulePromise ||= import("./anthropic").then(module => {
		const provider = module as AnthropicProviderModule;
		return { stream: provider.streamAnthropic };
	});
	return anthropicProviderModulePromise;
}

function loadAzureOpenAIResponsesProviderModule(): Promise<LazyProviderModule<"azure-openai-responses">> {
	azureOpenAIResponsesProviderModulePromise ||= import("./azure-openai-responses").then(module => {
		const provider = module as AzureOpenAIResponsesProviderModule;
		return { stream: provider.streamAzureOpenAIResponses };
	});
	return azureOpenAIResponsesProviderModulePromise;
}

function loadGoogleProviderModule(): Promise<LazyProviderModule<"google-generative-ai">> {
	googleProviderModulePromise ||= import("./google").then(module => {
		const provider = module as GoogleProviderModule;
		return { stream: provider.streamGoogle };
	});
	return googleProviderModulePromise;
}

function loadGoogleGeminiCliProviderModule(): Promise<LazyProviderModule<"google-gemini-cli">> {
	googleGeminiCliProviderModulePromise ||= import("./google-gemini-cli").then(module => {
		const provider = module as GoogleGeminiCliProviderModule;
		return { stream: provider.streamGoogleGeminiCli };
	});
	return googleGeminiCliProviderModulePromise;
}

function loadGoogleVertexProviderModule(): Promise<LazyProviderModule<"google-vertex">> {
	googleVertexProviderModulePromise ||= import("./google-vertex").then(module => {
		const provider = module as GoogleVertexProviderModule;
		return { stream: provider.streamGoogleVertex };
	});
	return googleVertexProviderModulePromise;
}

function loadOpenAICodexResponsesProviderModule(): Promise<LazyProviderModule<"openai-codex-responses">> {
	openAICodexResponsesProviderModulePromise ||= import("./openai-codex-responses").then(module => {
		const provider = module as OpenAICodexResponsesProviderModule;
		return { stream: provider.streamOpenAICodexResponses };
	});
	return openAICodexResponsesProviderModulePromise;
}

function loadOpenAICompletionsProviderModule(): Promise<LazyProviderModule<"openai-completions">> {
	openAICompletionsProviderModulePromise ||= import("./openai-completions").then(module => {
		const provider = module as OpenAICompletionsProviderModule;
		return { stream: provider.streamOpenAICompletions };
	});
	return openAICompletionsProviderModulePromise;
}

function loadOpenAIResponsesProviderModule(): Promise<LazyProviderModule<"openai-responses">> {
	openAIResponsesProviderModulePromise ||= import("./openai-responses").then(module => {
		const provider = module as OpenAIResponsesProviderModule;
		return { stream: provider.streamOpenAIResponses };
	});
	return openAIResponsesProviderModulePromise;
}

function loadOllamaProviderModule(): Promise<LazyProviderModule<"ollama-chat">> {
	ollamaProviderModulePromise ||= import("./ollama").then(module => {
		const provider = module as OllamaProviderModule;
		return { stream: provider.streamOllama };
	});
	return ollamaProviderModulePromise;
}

function loadCursorProviderModule(): Promise<LazyProviderModule<"cursor-agent">> {
	if (cursorProviderModuleOverride) {
		return Promise.resolve(cursorProviderModuleOverride);
	}
	cursorProviderModulePromise ||= import("./cursor").then(module => {
		const provider = module as CursorProviderModule;
		return { stream: provider.streamCursor };
	});
	return cursorProviderModulePromise;
}

function loadDevinProviderModule(): Promise<LazyProviderModule<"devin-agent">> {
	devinProviderModulePromise ||= import("./devin").then(module => {
		const provider = module as DevinProviderModule;
		return { stream: provider.streamDevin };
	});
	return devinProviderModulePromise;
}

function loadBedrockProviderModule(): Promise<LazyProviderModule<"bedrock-converse-stream">> {
	if (bedrockProviderModuleOverride) {
		return Promise.resolve(bedrockProviderModuleOverride);
	}
	bedrockProviderModulePromise ||= import("./amazon-bedrock").then(module => {
		const provider = module as BedrockProviderModule;
		return { stream: provider.streamBedrock };
	});
	return bedrockProviderModulePromise;
}

// ---------------------------------------------------------------------------
// Lazy stream function exports
//
// These use the same names as the direct provider stream functions. When
// stream.ts is updated to import from this module instead of individual
// providers, the lazy loading will take effect on the main code path.
// ---------------------------------------------------------------------------

export const streamAnthropic = createLazyStream(loadAnthropicProviderModule, PROVIDER_HANDLED_STREAM_TIMEOUTS);
export const streamAzureOpenAIResponses = createLazyStream(
	loadAzureOpenAIResponsesProviderModule,
	PROVIDER_HANDLED_STREAM_TIMEOUTS,
);
export const streamGoogle = createLazyStream(loadGoogleProviderModule);
export const streamGoogleGeminiCli = createLazyStream(
	loadGoogleGeminiCliProviderModule,
	GOOGLE_GEMINI_CLI_LAZY_STREAM_LIMITS,
);
export const streamGoogleVertex = createLazyStream(loadGoogleVertexProviderModule);
export const streamOpenAICodexResponses = createLazyStream(
	loadOpenAICodexResponsesProviderModule,
	PROVIDER_HANDLED_STREAM_TIMEOUTS,
);
export const streamOpenAICompletions = createLazyStream(
	loadOpenAICompletionsProviderModule,
	PROVIDER_HANDLED_STREAM_TIMEOUTS,
);
export const streamOpenAIResponses = createLazyStream(
	loadOpenAIResponsesProviderModule,
	PROVIDER_HANDLED_STREAM_TIMEOUTS,
);
export const streamCursor = createLazyStream(loadCursorProviderModule);
export const streamDevin = createLazyStream(loadDevinProviderModule);
export const streamOllama = createLazyStream(loadOllamaProviderModule, OPENAI_IDLE_FLOORED_LAZY_STREAM_LIMITS);

export const streamBedrock = createLazyStream(loadBedrockProviderModule);
