/**
 * Custom API provider registry.
 *
 * Allows extensions to register streaming functions for custom API types
 * (e.g., "vertex-claude-api") that are not built into stream.ts.
 */

import * as AIError from "./error";
import { afterRequestHolds } from "./request-holds";
import type {
	Api,
	AssistantMessage,
	AssistantMessageEventStream,
	Context,
	KnownApi,
	Model,
	SimpleStreamOptions,
	StreamOptions,
} from "./types";
import { AssistantMessageEventStream as EventStream } from "./utils/event-stream";

const BUILTIN_API_IDS = [
	"openai-completions",
	"openai-responses",
	"openrouter",
	"openai-codex-responses",
	"azure-openai-responses",
	"anthropic-messages",
	"bedrock-converse-stream",
	"google-generative-ai",
	"google-gemini-cli",
	"google-vertex",
	"ollama-chat",
	"cursor-agent",
	"factory-droid-agent",
	"gitlab-duo-agent",
	"devin-agent",
	"apple-foundation-models",
] as const satisfies readonly KnownApi[];

type _MissingBuiltinApis = Exclude<KnownApi, (typeof BUILTIN_API_IDS)[number]>;
type _CheckBuiltinApis = _MissingBuiltinApis extends never
	? true
	: ["BUILTIN_APIS is missing KnownApi values", _MissingBuiltinApis];
true satisfies _CheckBuiltinApis;

const BUILTIN_APIS = new Set<KnownApi>(BUILTIN_API_IDS);

export type CustomStreamFn = (
	model: Model<Api>,
	context: Context,
	options?: StreamOptions,
) => AssistantMessageEventStream;
export type CustomStreamSimpleFn = (
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
) => AssistantMessageEventStream;

export interface RegisteredCustomApi {
	stream: CustomStreamFn;
	streamSimple: CustomStreamSimpleFn;
	sourceId?: string;
}

const customApiRegistry = new Map<string, RegisteredCustomApi>();

function assertCustomApiName(api: string): void {
	if (BUILTIN_APIS.has(api as KnownApi)) {
		throw new AIError.ConfigurationError(`Cannot register custom API "${api}": built-in API names are reserved.`);
	}
}

/**
 * Register a custom API streaming function.
 */
export function registerCustomApi(
	api: string,
	streamSimple: CustomStreamSimpleFn,
	sourceId?: string,
	stream?: CustomStreamFn,
): void {
	assertCustomApiName(api);
	customApiRegistry.set(api, {
		stream: afterRequestHoldsCall(
			stream ?? ((model, context, options) => streamSimple(model, context, options as SimpleStreamOptions)),
		),
		streamSimple: afterRequestHoldsCall(streamSimple),
		sourceId,
	});
}

/**
 * Calls a host's stream function once the request holds of the caller's
 * context let go ({@link afterRequestHolds}). The host's transport, its own
 * `onPayload` included, is opaque, so the hand-off is the last point at which
 * a hold can stop the request. An abort while held ends the stream as
 * aborted without calling the host.
 */
export function afterRequestHoldsCall<TApi extends Api, O extends StreamOptions | SimpleStreamOptions>(
	host: (model: Model<TApi>, context: Context, options?: O) => AssistantMessageEventStream,
): (model: Model<TApi>, context: Context, options?: O) => AssistantMessageEventStream {
	return (model, context, options) => {
		const outer = new EventStream();
		void (async () => {
			let inner: AssistantMessageEventStream;
			try {
				inner = await afterRequestHolds(options?.signal, () => host(model, context, options));
			} catch (error) {
				if (!options?.signal?.aborted) {
					outer.fail(error);
					return;
				}
				const result = await AIError.finalize(error, {
					api: model.api,
					provider: model.provider,
					model: model.id,
					signal: options.signal,
				});
				const message: AssistantMessage = {
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
					stopReason: "aborted",
					errorMessage: result.message,
					timestamp: Date.now(),
				};
				outer.push({ type: "error", reason: "aborted", error: message });
				return;
			}
			if (inner instanceof EventStream) outer.forwardLocalWorkFrom(inner);
			try {
				for await (const event of inner) outer.push(event);
				if (!outer.done) outer.end(await inner.result());
			} catch (error) {
				outer.fail(error);
			}
		})();
		return outer;
	};
}

/** Every API a model request can name: the built-in ones, then the registered custom ones. */
export function listRegisteredApis(): string[] {
	return [...BUILTIN_API_IDS, ...customApiRegistry.keys()];
}

/**
 * Get a custom API provider by API identifier.
 */
export function getCustomApi(api: string): RegisteredCustomApi | undefined {
	return customApiRegistry.get(api);
}

/**
 * Remove all custom APIs registered by a specific source (e.g., extension path).
 */
export function unregisterCustomApis(sourceId: string): void {
	for (const [api, entry] of customApiRegistry.entries()) {
		if (entry.sourceId === sourceId) {
			customApiRegistry.delete(api);
		}
	}
}

/**
 * Clear all custom API registrations.
 */
export function clearCustomApis(): void {
	customApiRegistry.clear();
}
