/**
 * First-use provider loading with shared stream error, cancellation, and timeout handling.
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
import type * as BedrockProvider from "./amazon-bedrock";
import type * as CursorProvider from "./cursor";

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
				localWork: localWorkSource,
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

/**
 * Wraps a provider stream whose module loads on first call.
 *
 * `load` MUST call `import` with a string literal: `Bun.build` bundles only
 * literal specifiers, so a forwarded module name fails in compiled binaries.
 * A failed load or a throwing provider surfaces as the stream's `error` event.
 */
function createLazyProviderStream<TModule, TApi extends Api>(
	load: () => Promise<TModule>,
	pick: (mod: TModule) => ProviderStream<TApi>,
	limits?: StreamLimits,
): (model: Model<TApi>, context: Context, options: OptionsForApi<TApi>) => EventStreamImpl {
	return (model, context, options) => {
		const outer = new EventStreamImpl();
		const streamOptions: OptionsForApi<TApi> = options ?? {};

		load()
			.then(mod => {
				const abortTracker = createAbortSourceTracker(streamOptions.signal);
				const providerOptions: OptionsForApi<TApi> = { ...streamOptions, signal: abortTracker.requestSignal };
				const inner = pick(mod)(model, context, providerOptions);
				forwardStream(outer, inner, model, streamOptions, abortTracker, limits);
			})
			.catch(error => {
				const message = createProviderStreamError(model, error);
				outer.push({ type: "error", reason: "error", error: message });
				outer.end(message);
			});

		return outer;
	};
}

/** Stream Anthropic responses with provider-owned timeout handling. */
export const streamAnthropic = createLazyProviderStream(
	() => import("./anthropic"),
	mod => mod.streamAnthropic,
	PROVIDER_HANDLED_STREAM_TIMEOUTS,
);

/** Stream Azure Responses with provider-owned timeout handling. */
export const streamAzureOpenAIResponses = createLazyProviderStream(
	() => import("./azure-openai-responses"),
	mod => mod.streamAzureOpenAIResponses,
	PROVIDER_HANDLED_STREAM_TIMEOUTS,
);

/** Stream Google's direct API through the shared watchdog. */
export const streamGoogle = createLazyProviderStream(
	() => import("./google"),
	mod => mod.streamGoogle,
);

/** Stream Cloud Code Assist while retaining its first-event watchdog. */
export const streamGoogleGeminiCli = createLazyProviderStream(
	() => import("./google-gemini-cli"),
	mod => mod.streamGoogleGeminiCli,
	GOOGLE_GEMINI_CLI_STREAM_LIMITS,
);

/** Stream the Vertex API through the shared watchdog. */
export const streamGoogleVertex = createLazyProviderStream(
	() => import("./google-vertex"),
	mod => mod.streamGoogleVertex,
);

/** Stream Codex with provider-owned timeout handling. */
export const streamOpenAICodexResponses = createLazyProviderStream(
	() => import("./openai-codex-responses"),
	mod => mod.streamOpenAICodexResponses,
	PROVIDER_HANDLED_STREAM_TIMEOUTS,
);

/** Stream Chat Completions with provider-owned timeout handling. */
export const streamOpenAICompletions = createLazyProviderStream(
	() => import("./openai-completions"),
	mod => mod.streamOpenAICompletions,
	PROVIDER_HANDLED_STREAM_TIMEOUTS,
);

/** Stream Responses with provider-owned timeout handling. */
export const streamOpenAIResponses = createLazyProviderStream(
	() => import("./openai-responses"),
	mod => mod.streamOpenAIResponses,
	PROVIDER_HANDLED_STREAM_TIMEOUTS,
);

/** Stream through the host Cursor transport when installed, otherwise the built-in transport. */
export const streamCursor = createLazyProviderStream(
	() => import("./cursor"),
	(builtin): ProviderStream<"cursor-agent"> =>
		(model, context, options) =>
			(cursorStreamOverride ?? builtin.streamCursor)(model, context, options),
);

/** Stream Devin through the shared watchdog. */
export const streamDevin = createLazyProviderStream(
	() => import("./devin"),
	mod => mod.streamDevin,
);

/** Stream Apple's on-device Foundation Model through the shared watchdog. */
export const streamAppleFoundationModels = createLazyProviderStream(
	() => import("./apple-foundation-models"),
	mod => mod.streamAppleFoundationModels,
);

/** Stream Ollama with OpenAI-compatible idle timeout precedence. */
export const streamOllama = createLazyProviderStream(
	() => import("./ollama"),
	mod => mod.streamOllama,
	OPENAI_IDLE_FLOORED_STREAM_LIMITS,
);

/** Stream through the host Bedrock transport when installed, otherwise the built-in transport. */
export const streamBedrock = createLazyProviderStream(
	() => import("./amazon-bedrock"),
	(builtin): ProviderStream<"bedrock-converse-stream"> =>
		(model, context, options) =>
			(bedrockStreamOverride ?? builtin.streamBedrock)(model, context, options),
);
