/**
 * Compatibility shim for legacy extensions importing the package root of
 * `@oh-my-pi/pi-ai` (or one of its aliased scopes like `@earendil-works/pi-ai`
 * or `@mariozechner/pi-ai`).
 *
 * pi-ai 15.1.0 removed the historical TypeBox root exports (`Type`, plus the
 * runtime-relevant half of the `Static`/`TSchema` pair) from the package
 * entrypoint. Legacy extensions still author parameter schemas as
 * `Type.Object({ ... })`, so this file is served by `legacy-pi-compat.ts` in
 * place of the real pi-ai entrypoint whenever a legacy extension imports the
 * bare package root. Subpath imports (`@oh-my-pi/pi-ai/oauth`, etc.)
 * continue to resolve directly against the bundled pi-ai package.
 *
 * The `Type` runtime and legacy `StringEnum()` helper are borrowed from the
 * Zod-backed TypeBox shim that already serves TypeBox imports for the same
 * extension class, keeping the legacy-compat surface internally consistent.
 *
 * Type-level `Static` and `TSchema` continue to come from pi-ai's own
 * `types.ts` via the `export *` below — pi-ai still exports both as types,
 * only the runtime `Type` builder and `StringEnum()` helper were removed.
 */
import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Context,
	type Model,
	type SimpleStreamOptions,
	streamSimple,
} from "@oh-my-pi/pi-ai";
import type { Effort } from "@oh-my-pi/pi-catalog/effort";
import { clampThinkingLevelForModel } from "@oh-my-pi/pi-catalog/model-thinking";
import {
	calculateCost,
	getBundledModel,
	getBundledModels,
	getBundledProviders,
	modelsAreEqual,
} from "@oh-my-pi/pi-catalog/models";
import { type TSchema, Type } from "./legacy-typebox";

export interface StringEnumOptions<T extends string> {
	description?: string;
	default?: T;
	examples?: T[];
	[key: string]: unknown;
}

function stringEnumWireSchema<T extends string | number>(
	values: readonly T[] | Record<string, T>,
	options: StringEnumOptions<any> | undefined,
) {
	const enumValues = Array.isArray(values) ? [...values] : Object.values(values);
	const schema: Record<string, unknown> = {
		type: "string",
		enum: enumValues,
	};
	if (!options) return schema;
	for (const key in options) {
		if (options[key] !== undefined) {
			schema[key] = options[key];
		}
	}
	return schema;
}

export function StringEnum<T extends string | number>(
	values: readonly T[] | Record<string, T>,
	options?: StringEnumOptions<any>,
): TSchema {
	const opts = {
		description: options?.description ?? "Legacy string enum compatibility schema",
		...options,
	};
	const schema: TSchema = Array.isArray(values) && values.length === 0 ? Type.Never(opts) : Type.Enum(values, opts);
	Object.defineProperty(schema, "toJSON", {
		value: () => stringEnumWireSchema(values, options),
		enumerable: false,
		writable: true,
		configurable: true,
	});
	return schema;
}

/** Clamp a historical Pi thinking level against OMP's model metadata. */
export function clampThinkingLevel<TApi extends Api>(model: Model<TApi>, level: Effort | "off"): Effort | "off" {
	if (level === "off") return "off";
	return clampThinkingLevelForModel(model, level) ?? "off";
}

/**
 * Provider-error classification patterns ported verbatim from historical pi-ai
 * (`@earendil-works/pi-ai` `utils/retry.ts`). Legacy extensions call
 * {@link isRetryableAssistantError} to decide whether to restart a failed
 * assistant turn, so the wording tables must match the upstream semantics they
 * were authored against rather than OMP's own `Error`-based classifiers.
 */
const NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN =
	/GoUsageLimitError|FreeUsageLimitError|Monthly usage limit reached|available balance|insufficient_quota|out of budget|quota exceeded|billing/i;
const RETRYABLE_PROVIDER_ERROR_PATTERN =
	/overloaded|rate.?limit|too many requests|429|500|502|503|504|524|service.?unavailable|server.?error|internal.?error|provider.?returned.?error|network.?error|connection.?error|connection.?refused|connection.?lost|other side closed|fetch failed|getaddrinfo|ENOTFOUND|EAI_AGAIN|upstream.?connect|reset before headers|socket hang up|socket connection was closed|timed? out|timeout|terminated|websocket.?closed|websocket.?error|ended without|stream ended before message_stop|stream ended before a terminal response event|http2 request did not get a response|retry delay|you can retry your request|try your request again|please retry your request|ResourceExhausted/i;

/**
 * Compatibility implementation of historical pi-ai's `isRetryableAssistantError`.
 *
 * Classifies whether a failed assistant message looks like a transient provider
 * or transport error so legacy extensions can decide if the last assistant turn
 * should be restarted. Account/quota limits are treated as non-retryable. This
 * does not implement any retry policy; callers own budget, backoff, and reporting.
 */
export function isRetryableAssistantError(message: AssistantMessage): boolean {
	if (message.stopReason !== "error" || !message.errorMessage) return false;
	const errorMessage = message.errorMessage;
	if (NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN.test(errorMessage)) return false;
	return RETRYABLE_PROVIDER_ERROR_PATTERN.test(errorMessage);
}

export * from "@oh-my-pi/pi-ai";
/**
 * Compatibility re-exports for catalog symbols that pi-ai historically exposed
 * from its own barrel prior to the `refactor(catalog)!: split model catalog
 * from pi-ai` change. Legacy extensions still import these from the pi-ai
 * root, so the shim bridges them through to their new home in
 * `@oh-my-pi/pi-catalog/models`. `getModel`/`getModels` are the historical
 * pi-ai names for `getBundledModel`/`getBundledModels`; the remaining symbols
 * kept their names across the move.
 */
export { calculateCost, getBundledModel, getBundledModels, getBundledProviders, modelsAreEqual, Type };
export const getModel = getBundledModel;
export const getModels = getBundledModels;

/**
 * Stream OpenAI Responses through the historical simple-options contract.
 *
 * Legacy `/compat` callers pass {@link SimpleStreamOptions}; routing through
 * `streamSimple` preserves option normalization before provider dispatch.
 *
 * Transient-failure retry (overload, rate-limit, 5xx) is the **caller's
 * responsibility**. Oneshot callers that collect the full result before acting
 * should wrap with `retryTransientCompletion` from `@oh-my-pi/pi-ai`.
 */
export function streamSimpleOpenAIResponses(
	model: Model<"openai-responses">,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	return streamSimple(model, context, options);
}
/**
 * Compatibility re-exports for runtime helpers that upstream
 * `@earendil-works/pi-ai` exposed from its package root but omp's
 * `@oh-my-pi/pi-ai` barrel no longer forwards. Each symbol still exists in the
 * host graph — only its root re-export was dropped — so bridging it here keeps
 * legacy extensions importing it from the pi-ai root resolving through Bun's
 * static named-export check (e.g. `omp plugin install pi-blackhole`).
 *
 * This is the full set derived from an audit of the upstream root surface: the
 * error-classification predicate `isContextOverflow` (now under
 * `@oh-my-pi/pi-ai/error`) and the JSON-repair helpers that omp relocated to
 * `@oh-my-pi/pi-utils`. Upstream root symbols with no omp equivalent are
 * intentionally not shimmed — the package has diverged and there is nothing to
 * forward.
 */
export { isContextOverflow } from "@oh-my-pi/pi-ai/error";
export { parseJsonWithRepair, parseStreamingJson, repairJson } from "@oh-my-pi/pi-utils";
