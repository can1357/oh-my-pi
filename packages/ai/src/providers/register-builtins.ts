/**
 * Built-in provider stream dispatch with shared error, cancellation, and timeout handling.
 */

import type { CompatOf } from "@oh-my-pi/pi-catalog/types";
import * as AIError from "../error";
import type { Api, AssistantMessage, AssistantMessageEvent, Context, Model, OptionsForApi } from "../types";
import { type AbortSourceTracker, createAbortSourceTracker } from "../utils/abort";
import { AssistantMessageEventStream as EventStreamImpl } from "../utils/event-stream";
import {
	getOpenAIStreamFirstEventTimeoutMs,
	getOpenAIStreamIdleTimeoutMs,
	getStreamFirstEventTimeoutMs,
	getStreamIdleTimeoutMs,
	iterateWithIdleTimeout,
} from "../utils/idle-iterator";
import * as AnthropicProvider from "./anthropic";
import * as AzureOpenAIResponsesProvider from "./azure-openai-responses";
import * as BedrockProvider from "./amazon-bedrock";
import * as CursorProvider from "./cursor";
import * as DevinProvider from "./devin";
import * as GoogleProvider from "./google";
import * as GoogleGeminiCliProvider from "./google-gemini-cli";
import * as GoogleVertexProvider from "./google-vertex";
import * as OllamaProvider from "./ollama";
import * as OpenAICodexResponsesProvider from "./openai-codex-responses";
import * as OpenAICompletionsProvider from "./openai-completions";
import * as OpenAIResponsesProvider from "./openai-responses";

type ProviderStream<TApi extends Api> = (
	model: Model<TApi>,
	context: Context,
	options: OptionsForApi<TApi>,
) => AsyncIterable<AssistantMessageEvent>;

let cursorStreamOverride: typeof CursorProvider.streamCursor | undefined;
let bedrockStreamOverride: typeof BedrockProvider.streamBedrock | undefined;

/** Install a host-supplied Bedrock transport in place of the built-in provider. */
export function setBedrockProviderModule(module: Pick<typeof BedrockProvider, "streamBedrock">): void {
	bedrockStreamOverride = module.streamBedrock;
}

/** Install a host-supplied Cursor transport in place of the built-in provider. */
export function setCursorProviderModule(module: Pick<typeof CursorProvider, "streamCursor">): void {
	cursorStreamOverride = module.streamCursor;
}

// ---------------------------------------------------------------------------
// Stream forwarding / error helpers
// ---------------------------------------------------------------------------

const STREAM_IDLE_TIMEOUT_ERROR = "Provider stream stalled while waiting for the next event";
const STREAM_FIRST_EVENT_TIMEOUT_ERROR = "Provider stream timed out while waiting for the first event";

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
interface StreamLimits {
	defaultFirstEventTimeoutMs?: number;
	defaultIdleTimeoutMs?: number;
	/**
	 * The provider implementation already wraps its upstream transport with
	 * stream timeouts. Keep the shared watchdog from racing it with generic errors.
	 */
	providerHandlesStreamTimeouts?: boolean;
	/**
	 * The provider retries or fails over when no first event arrives, while the
	 * shared wrapper continues to own steady-state idle detection.
	 */
	providerHandlesFirstEventTimeouts?: boolean;
	/**
	 * Apply OpenAI-family idle timeout precedence in the shared wrapper. Used by
	 * local backends whose users historically tune slow prompt-processing gaps
	 * with `PI_OPENAI_STREAM_IDLE_TIMEOUT_MS`.
	 */
	openAIIdleEnvFloorsFirstEvent?: boolean;
}
/**
 * Cloud Code Assist owns first-event detection because Antigravity can return
 * successful headers and then never emit an SSE event. Keeping the watchdog in
 * the provider lets it fail over before surfacing an error; the shared wrapper
 * still catches post-first-event stalls.
 */
const GOOGLE_GEMINI_CLI_STREAM_LIMITS: StreamLimits = {
	providerHandlesFirstEventTimeouts: true,
};

const PROVIDER_HANDLED_STREAM_TIMEOUTS: StreamLimits = {
	providerHandlesStreamTimeouts: true,
};

const OPENAI_IDLE_FLOORED_STREAM_LIMITS: StreamLimits = {
	openAIIdleEnvFloorsFirstEvent: true,
};

function forwardStream<TApi extends Api>(
	target: EventStreamImpl,
	source: AsyncIterable<AssistantMessageEvent>,
	model: Model<TApi>,
	options: OptionsForApi<TApi>,
	abortTracker: AbortSourceTracker,
	limits?: StreamLimits,
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
				errorMessage: STREAM_IDLE_TIMEOUT_ERROR,
				firstItemErrorMessage: STREAM_FIRST_EVENT_TIMEOUT_ERROR,
				onIdle: () => abortTracker.abortLocally(new AIError.StreamTimeoutError(STREAM_IDLE_TIMEOUT_ERROR)),
				onFirstItemTimeout: () =>
					abortTracker.abortLocally(new AIError.StreamTimeoutError(STREAM_FIRST_EVENT_TIMEOUT_ERROR)),
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
			const message = createProviderStreamError(model, error, stopReason);
			target.push({ type: "error", reason: stopReason, error: message });
			target.end(message);
		}
	})();
}

function createProviderStreamError<TApi extends Api>(
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
// Provider stream wrapper
// ---------------------------------------------------------------------------

function createProviderStream<TApi extends Api>(
	stream: ProviderStream<TApi>,
	limits?: StreamLimits,
): (model: Model<TApi>, context: Context, options: OptionsForApi<TApi>) => EventStreamImpl {
	return (model, context, options) => {
		const outer = new EventStreamImpl();
		const streamOptions: OptionsForApi<TApi> = options ?? {};

		try {
			const abortTracker = createAbortSourceTracker(streamOptions.signal);
			const providerOptions: OptionsForApi<TApi> = { ...streamOptions, signal: abortTracker.requestSignal };
			const inner = stream(model, context, providerOptions);
			forwardStream(outer, inner, model, streamOptions, abortTracker, limits);
		} catch (error) {
			const message = createProviderStreamError(model, error);
			outer.push({ type: "error", reason: "error", error: message });
			outer.end(message);
		}

		return outer;
	};
}

/** Stream Anthropic responses with provider-owned timeout handling. */
export const streamAnthropic = createProviderStream<"anthropic-messages">(
	(model, context, options) => AnthropicProvider.streamAnthropic(model, context, options),
	PROVIDER_HANDLED_STREAM_TIMEOUTS,
);

/** Stream Azure Responses with provider-owned timeout handling. */
export const streamAzureOpenAIResponses = createProviderStream<"azure-openai-responses">(
	(model, context, options) => AzureOpenAIResponsesProvider.streamAzureOpenAIResponses(model, context, options),
	PROVIDER_HANDLED_STREAM_TIMEOUTS,
);

/** Stream Google's direct API through the shared watchdog. */
export const streamGoogle = createProviderStream<"google-generative-ai">((model, context, options) =>
	GoogleProvider.streamGoogle(model, context, options),
);

/** Stream Cloud Code Assist while retaining its first-event watchdog. */
export const streamGoogleGeminiCli = createProviderStream<"google-gemini-cli">(
	(model, context, options) => GoogleGeminiCliProvider.streamGoogleGeminiCli(model, context, options),
	GOOGLE_GEMINI_CLI_STREAM_LIMITS,
);

/** Stream the Vertex API through the shared watchdog. */
export const streamGoogleVertex = createProviderStream<"google-vertex">((model, context, options) =>
	GoogleVertexProvider.streamGoogleVertex(model, context, options),
);

/** Stream Codex with provider-owned timeout handling. */
export const streamOpenAICodexResponses = createProviderStream<"openai-codex-responses">(
	(model, context, options) => OpenAICodexResponsesProvider.streamOpenAICodexResponses(model, context, options),
	PROVIDER_HANDLED_STREAM_TIMEOUTS,
);

/** Stream Chat Completions with provider-owned timeout handling. */
export const streamOpenAICompletions = createProviderStream<"openai-completions">(
	(model, context, options) => OpenAICompletionsProvider.streamOpenAICompletions(model, context, options),
	PROVIDER_HANDLED_STREAM_TIMEOUTS,
);

/** Stream Responses with provider-owned timeout handling. */
export const streamOpenAIResponses = createProviderStream<"openai-responses">(
	(model, context, options) => OpenAIResponsesProvider.streamOpenAIResponses(model, context, options),
	PROVIDER_HANDLED_STREAM_TIMEOUTS,
);

/** Stream through the host Cursor transport when installed, otherwise the built-in transport. */
export const streamCursor = createProviderStream<"cursor-agent">((model, context, options) =>
	(cursorStreamOverride ?? CursorProvider.streamCursor)(model, context, options),
);

/** Stream Devin through the shared watchdog. */
export const streamDevin = createProviderStream<"devin-agent">((model, context, options) =>
	DevinProvider.streamDevin(model, context, options),
);

/** Stream Ollama with OpenAI-compatible idle timeout precedence. */
export const streamOllama = createProviderStream<"ollama-chat">(
	(model, context, options) => OllamaProvider.streamOllama(model, context, options),
	OPENAI_IDLE_FLOORED_STREAM_LIMITS,
);

/** Stream through the host Bedrock transport when installed, otherwise the built-in transport. */
export const streamBedrock = createProviderStream<"bedrock-converse-stream">((model, context, options) =>
	(bedrockStreamOverride ?? BedrockProvider.streamBedrock)(model, context, options),
);
