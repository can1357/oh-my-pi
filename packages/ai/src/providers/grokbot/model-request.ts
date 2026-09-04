/** Map omp model ids to Grok Bot InferenceRequestedModel. */

import type { Effort } from "@oh-my-pi/pi-catalog/effort";

export type GrokbotRequestedParameter = { id: string; value: string };

export type GrokbotRequestedModel = {
	modelId: string;
	maxMode?: boolean;
	parameters?: GrokbotRequestedParameter[];
	isVariantStringRepresentation?: boolean;
};

export type GrokbotRequestedModelOptions = {
	/** omp effort level; mapped onto sand `effort` or `reasoning` when allowed. */
	effort?: Effort | string;
	/**
	 * Optional effort → wire remap from model `thinking.effortMap`.
	 * Identity for omitted keys so discovered `minimal` / `max` stay on the wire.
	 */
	effortMap?: Partial<Record<string, string>>;
	/**
	 * sand `fast` parameter; only sent when the model lists `fast`.
	 * Default: `false` when `thinking` is also advertised (Cursor Anthropic defaults),
	 * otherwise `true` (Cursor composer / Grok defaults).
	 * Note: Grok models reject `fast=false` with tools (sand HTTP 422); keep the default.
	 */
	fast?: boolean;
	/**
	 * sand `thinking` boolean; only sent when the model lists `thinking`.
	 * Default: explicit `thinking`, then `sandParameterDefaults.thinking`, then
	 * `true` when an effort/reasoning value is being sent, else `false`.
	 */
	thinking?: boolean;
	/**
	 * sand `context` tier (e.g. `300k` / `1m` / `272k`); only sent when the model lists `context`.
	 * Default: explicit `context`, then `sandParameterDefaults.context`, then
	 * `1m` when `sandMaxMode`, otherwise `300k` when discovery left no default.
	 */
	context?: string;
	/**
	 * Default sand parameter values from live AvailableModels variants.
	 */
	sandParameterDefaults?: Readonly<Record<string, string>>;
	/**
	 * Allowed parameter ids from live `parameterDefinitions` / catalog `sandParameterIds`.
	 * Empty/undefined ⇒ bare `{ modelId }` (routers and Auto) — the catalog fact
	 * that drives bare-wire routing; do not name-match model ids here.
	 */
	sandParameterIds?: readonly string[];
	/** When true, set `maxMode` on the wire. Default false. */
	sandMaxMode?: boolean;
	/** Canonical wire model id when `modelId` was an alias. */
	canonicalModelId?: string;
	/** When true, set `isVariantStringRepresentation` on the sand requestedModel wire. */
	sandVariantStringRepresentation?: boolean;
};

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

function resolveSandEffortWireValue(
	options: GrokbotRequestedModelOptions | undefined,
	allowed: Set<string>,
): string | undefined {
	const explicit = toSandEffortValue(options?.effort, options?.effortMap);
	if (explicit) return explicit;
	const defaults = options?.sandParameterDefaults;
	if (allowed.has("effort")) {
		const value = defaults?.effort?.trim();
		if (value) return value;
	}
	if (allowed.has("reasoning")) {
		const value = defaults?.reasoning?.trim();
		if (value) return value;
	}
	return undefined;
}

export function resolveGrokbotRequestedModel(
	modelId: string,
	options?: GrokbotRequestedModelOptions,
): GrokbotRequestedModel {
	const raw = typeof modelId === "string" ? modelId : "sand-default";
	const slug = raw.startsWith("grokbot/") ? raw.slice("grokbot/".length) : raw;
	const wireId = options?.canonicalModelId?.trim() || slug;

	// Bare-wire routing is a catalog fact: empty/absent `sandParameterIds` means
	// routers/Auto omit parameters (and `sandMaxMode` alone controls maxMode).
	const allowed = new Set(options?.sandParameterIds ?? []);
	const parameters: GrokbotRequestedParameter[] = [];
	const defaults = options?.sandParameterDefaults;

	if (allowed.size > 0) {
		const effortValue = resolveSandEffortWireValue(options, allowed);
		// Cursor AvailableModels variants always send the full advertised set
		// (thinking/context/effort/fast). Partial sets work for some vendors but
		// Anthropic variants are defined as complete combinations.
		if (allowed.has("thinking")) {
			const discoveredThinking = defaults?.thinking?.trim();
			const thinking =
				options?.thinking !== undefined
					? options.thinking
					: discoveredThinking === "true"
						? true
						: discoveredThinking === "false"
							? false
							: Boolean(effortValue);
			parameters.push({ id: "thinking", value: thinking ? "true" : "false" });
		}
		if (allowed.has("context")) {
			const discoveredDefault = options?.sandParameterDefaults?.context?.trim();
			const context =
				typeof options?.context === "string" && options.context.trim()
					? options.context.trim()
					: discoveredDefault && discoveredDefault.length > 0
						? discoveredDefault
						: options?.sandMaxMode === true
							? "1m"
							: "300k";
			parameters.push({ id: "context", value: context });
		}
		if (effortValue) {
			if (allowed.has("effort")) {
				parameters.push({ id: "effort", value: effortValue });
			} else if (allowed.has("reasoning")) {
				parameters.push({ id: "reasoning", value: effortValue });
			}
		}
		if (allowed.has("fast")) {
			const defaultFast = !allowed.has("thinking");
			const fast = options?.fast !== undefined ? options.fast : defaultFast;
			parameters.push({ id: "fast", value: fast ? "true" : "false" });
		}
	}

	const requested: GrokbotRequestedModel = { modelId: wireId };
	if (options?.sandVariantStringRepresentation === true) {
		requested.isVariantStringRepresentation = true;
	}
	if (options?.sandMaxMode === true) {
		requested.maxMode = true;
	}
	if (parameters.length > 0) {
		requested.parameters = parameters;
	}
	return requested;
}
