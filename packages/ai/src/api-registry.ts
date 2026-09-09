/**
 * Custom API provider registry.
 *
 * Allows extensions to register streaming functions for custom API types
 * (e.g., "vertex-claude-api") that are not built into stream.ts.
 */

import * as AIError from "./error";
import type {
	Api,
	AssistantMessageEventStream,
	Context,
	KnownApi,
	Model,
	SimpleStreamOptions,
	StreamOptions,
} from "./types";

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
	"gitlab-duo-agent",
	"devin-agent",
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
		stream: stream ?? ((model, context, options) => streamSimple(model, context, options as SimpleStreamOptions)),
		streamSimple,
		sourceId,
	});
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
