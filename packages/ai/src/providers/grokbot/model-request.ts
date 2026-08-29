/** Map omp model ids to Grok Bot InferenceRequestedModel. */

import type { Effort } from "@oh-my-pi/pi-catalog/effort";

export type GrokbotRequestedParameter = { id: string; value: string };

export type GrokbotRequestedModel = {
	modelId: string;
	maxMode?: boolean;
	parameters?: GrokbotRequestedParameter[];
};

export type GrokbotRequestedModelOptions = {
	/** omp effort level; mapped onto sand `effort` or `reasoning` when allowed. */
	effort?: Effort | string;
	/**
	 * Optional effort → wire remap from model `thinking.effortMap`.
	 * Identity for omitted keys so discovered `minimal` / `max` stay on the wire.
	 */
	effortMap?: Partial<Record<string, string>>;
	/** sand `fast` parameter; only sent when the model lists `fast` (defaults to true). */
	fast?: boolean;
	/**
	 * Allowed parameter ids from live `parameterDefinitions` / catalog `sandParameterIds`.
	 * Empty/undefined ⇒ bare `{ modelId }` (routers and Auto).
	 */
	sandParameterIds?: readonly string[];
	/** When true, set `maxMode` on the wire. Default false. */
	sandMaxMode?: boolean;
	/** Canonical wire model id when `modelId` was an alias. */
	canonicalModelId?: string;
};

/** Sand router / Auto ids — always bare `{ modelId }`, never rewritten to grok-*. */
const BARE_ALIASES = new Set([
	"default",
	"auto",
	"auto-low",
	"auto-medium",
	"auto-high",
	"auto-smart",
	"sand-default",
	"sand-cua",
	"sand-automation",
	"sand-mock",
	"premium",
]);

/**
 * Map omp Effort / string to Grok Bot effort wire values.
 * Preserves the discovered value (`minimal`, `max`, …) unless `effortMap` aliases it.
 */
export function toSandEffortValue(
	effort: Effort | string | undefined,
	effortMap?: Partial<Record<string, string>>,
): string | undefined {
	if (typeof effort !== "string" || !effort) return undefined;
	const mapped = effortMap?.[effort];
	return typeof mapped === "string" && mapped.length > 0 ? mapped : effort;
}

export function resolveGrokbotRequestedModel(
	modelId: string,
	options?: GrokbotRequestedModelOptions,
): GrokbotRequestedModel {
	const raw = typeof modelId === "string" ? modelId : "sand-default";
	const slug = raw.startsWith("grokbot/") ? raw.slice("grokbot/".length) : raw;
	const wireId = options?.canonicalModelId?.trim() || slug;

	if (BARE_ALIASES.has(slug) || BARE_ALIASES.has(wireId)) {
		return { modelId: BARE_ALIASES.has(slug) ? slug : wireId };
	}

	const allowed = new Set(options?.sandParameterIds ?? []);
	const parameters: GrokbotRequestedParameter[] = [];

	if (allowed.size > 0) {
		const effortValue = toSandEffortValue(options?.effort, options?.effortMap);
		if (effortValue) {
			if (allowed.has("effort")) {
				parameters.push({ id: "effort", value: effortValue });
			} else if (allowed.has("reasoning")) {
				parameters.push({ id: "reasoning", value: effortValue });
			}
		}
		if (allowed.has("fast")) {
			// Documented default is fast:true when the model advertises the param;
			// explicit false is preserved.
			const fast = options?.fast !== undefined ? options.fast : true;
			parameters.push({ id: "fast", value: fast ? "true" : "false" });
		}
		// `context` is only sent when explicitly provided later; do not invent tiers.
	}

	const requested: GrokbotRequestedModel = { modelId: wireId };
	if (options?.sandMaxMode === true) {
		requested.maxMode = true;
	}
	if (parameters.length > 0) {
		requested.parameters = parameters;
	}
	return requested;
}

export function isGrokbotBareAlias(modelId: string): boolean {
	const slug = modelId.startsWith("grokbot/") ? modelId.slice("grokbot/".length) : modelId;
	return BARE_ALIASES.has(slug);
}
