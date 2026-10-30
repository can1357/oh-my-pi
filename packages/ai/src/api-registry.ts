/**
 * Custom API provider registry.
 *
 * Allows extensions to register streaming functions for custom API types
 * (e.g., "vertex-claude-api") that are not built into stream.ts.
 */

import {
	callThroughGate,
	type GatedRegistration,
	type ProviderCallGate,
	selectLiveRegistration,
} from "./auth/provider-gate";
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

/** One registration of a custom API. `registered` holds the functions as they were registered;
 *  `view` is what {@link getCustomApi} hands out: `registered` itself for the host, or a record
 *  whose functions run `registered`'s as the owning session's work. */
interface CustomApiRegistration extends GatedRegistration {
	readonly registered: RegisteredCustomApi;
	readonly view: RegisteredCustomApi;
}

/** Registrations by API id, oldest first. A parent session and a subagent that rebinds its
 *  extensions register the same id; the newest live one answers. A retired registration stays
 *  until it is unregistered: retirement only stops it being selected. */
const customApiRegistry = new Map<string, CustomApiRegistration[]>();

function assertCustomApiName(api: string): void {
	if (BUILTIN_APIS.has(api as KnownApi)) {
		throw new AIError.ConfigurationError(`Cannot register custom API "${api}": built-in API names are reserved.`);
	}
}

/**
 * Register a custom API streaming function. `gate` is the lifetime of the session that registered
 * it, omitted for the host's own. Registering an API again with the same gate (or, for the host,
 * again without one) replaces that registration in place.
 */
export function registerCustomApi(
	api: string,
	streamSimple: CustomStreamSimpleFn,
	sourceId?: string,
	stream?: CustomStreamFn,
	gate?: ProviderCallGate,
): void {
	assertCustomApiName(api);
	const registered: RegisteredCustomApi = {
		stream: stream ?? ((model, context, options) => streamSimple(model, context, options as SimpleStreamOptions)),
		streamSimple,
		sourceId,
	};
	const registration: CustomApiRegistration = {
		registered,
		// A session's view is this registry's own record, so its functions can run the registered
		// ones through the gate. Those are called unchanged, on `registered`: the receiver they had
		// when the registry handed out `registered` itself.
		view: gate
			? {
					stream: (model, context, options) =>
						callThroughGate(gate, () => registered.stream(model, context, options)),
					streamSimple: (model, context, options) =>
						callThroughGate(gate, () => registered.streamSimple(model, context, options)),
					sourceId,
				}
			: registered,
		gate,
	};
	const registrations = customApiRegistry.get(api);
	if (!registrations) {
		customApiRegistry.set(api, [registration]);
		return;
	}
	const index = registrations.findIndex(entry => entry.gate === gate);
	if (index === -1) {
		registrations.push(registration);
	} else {
		registrations[index] = registration;
	}
}

/**
 * Get a custom API provider by API identifier: the newest registration whose session is still
 * live.
 */
export function getCustomApi(api: string): RegisteredCustomApi | undefined {
	const registrations = customApiRegistry.get(api);
	return registrations ? selectLiveRegistration(registrations)?.view : undefined;
}

/**
 * Remove the custom APIs registered by a specific source (e.g., extension path): only `gate`'s
 * registrations when a gate is given, every session's otherwise.
 */
export function unregisterCustomApis(sourceId: string, gate?: ProviderCallGate): void {
	for (const [api, registrations] of customApiRegistry) {
		const kept = registrations.filter(
			entry => entry.registered.sourceId !== sourceId || (gate !== undefined && entry.gate !== gate),
		);
		if (kept.length === 0) {
			customApiRegistry.delete(api);
		} else if (kept.length !== registrations.length) {
			customApiRegistry.set(api, kept);
		}
	}
}

/**
 * Clear all custom API registrations.
 */
export function clearCustomApis(): void {
	customApiRegistry.clear();
}
