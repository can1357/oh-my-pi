/**
 * Thinking metadata: runtime field-read helpers.
 *
 * Derivation lives in the compat engine (`compat/resolve`) and runs exactly
 * once per model — from `buildModel` for dynamic specs and from the catalog
 * generator for bundled entries. Everything here reads baked fields only: no
 * id parsing, no host matching, no compat detection per request.
 */
import { Effort, THINKING_EFFORTS } from "./effort";
import type { Api, Model, ModelSpec } from "./types";

/**
 * Runtime helpers read baked metadata only, so they accept both pre-build
 * specs and built models.
 */
type ApiModel<TApi extends Api = Api> = ModelSpec<TApi> | Model<TApi>;

/**
 * Returns the supported thinking efforts declared on the model metadata.
 * Empty for non-reasoning models and for reasoning models without a
 * controllable effort surface (`thinking: undefined`).
 */
export function getSupportedEfforts<TApi extends Api>(model: ApiModel<TApi>): readonly Effort[] {
	if (!model.reasoning) {
		return [];
	}
	return model.thinking?.efforts ?? [];
}

/**
 * Clamps a requested thinking level against explicit model metadata.
 *
 * Non-reasoning models always resolve to `undefined`.
 */
export function clampThinkingLevelForModel<TApi extends Api>(
	model: ApiModel<TApi> | undefined,
	requested: Effort | undefined,
): Effort | undefined {
	if (!model) {
		return requested;
	}
	if (!model.reasoning || requested === undefined) {
		return undefined;
	}

	const levels = getSupportedEfforts(model);
	if (levels.includes(requested)) {
		return requested;
	}

	const requestedIndex = THINKING_EFFORTS.indexOf(requested);
	if (requestedIndex === -1) {
		return undefined;
	}

	let clamped: Effort | undefined;
	for (const effort of levels) {
		if (THINKING_EFFORTS.indexOf(effort) > requestedIndex) {
			break;
		}
		clamped = effort;
	}

	return clamped ?? levels[0];
}

export function requireSupportedEffort<TApi extends Api>(model: ApiModel<TApi>, effort: Effort): Effort {
	if (!model.reasoning) {
		throw new Error(`Model ${model.provider}/${model.id} does not support thinking`);
	}
	const levels = getSupportedEfforts(model);
	if (!levels.includes(effort)) {
		throw new Error(
			`Thinking effort ${effort} is not supported by ${model.provider}/${model.id}. Supported efforts: ${levels.join(", ")}`,
		);
	}
	return effort;
}

/** Maps a normalized thinking effort to Google's `thinkingLevel` enum values.
 * When a collapsed family routes `minimal` onto the same wire id as `low`
 * (Antigravity Gemini 3.6/3.7 Flash), emit `LOW` — Cloud Code Assist rejects
 * `MINIMAL` on those `-low` SKUs.
 */
export function mapEffortToGoogleThinkingLevel<TApi extends Api>(
	effort: Effort,
	model?: ApiModel<TApi>,
): "MINIMAL" | "LOW" | "MEDIUM" | "HIGH" {
	if (effort === Effort.Minimal) {
		const routing = model?.thinking?.effortRouting;
		if (routing?.[Effort.Minimal] && routing[Effort.Minimal] === routing[Effort.Low]) {
			return "LOW";
		}
		return "MINIMAL";
	}
	switch (effort) {
		case Effort.Low:
			return "LOW";
		case Effort.Medium:
			return "MEDIUM";
		case Effort.High:
		case Effort.XHigh:
		case Effort.Max:
			return "HIGH";
	}
}

/**
 * Maps a normalized thinking effort to Anthropic adaptive effort values via
 * the model's baked `thinking.effortMap` (identity for unmapped efforts).
 */
export function mapEffortToAnthropicAdaptiveEffort<TApi extends Api>(
	model: ApiModel<TApi>,
	effort: Effort,
): "low" | "medium" | "high" | "xhigh" | "max" | "adaptive" {
	const supported = requireSupportedEffort(model, effort);
	return (model.thinking?.effortMap?.[supported] ?? supported) as
		| "low"
		| "medium"
		| "high"
		| "xhigh"
		| "max"
		| "adaptive";
}

/**
 * Resolves the upstream wire model id for a request at the given effort
 * (`undefined` = thinking off). Collapsed effort-tier variants route through
 * `thinking.effortRouting`; everything else falls back to
 * `requestModelId ?? id`.
 */
export function resolveWireModelId<TApi extends Api>(model: ApiModel<TApi>, effort: Effort | undefined): string {
	return model.thinking?.effortRouting?.[effort ?? "off"] ?? model.requestModelId ?? model.id;
}

/**
 * Lowest supported effort in canonical order — the clamp target for
 * thinking-off requests on `thinking.requiresEffort` models.
 */
export function minimumSupportedEffort<TApi extends Api>(model: ApiModel<TApi>): Effort | undefined {
	const efforts = model.thinking?.efforts;
	if (!efforts || efforts.length === 0) return undefined;
	for (const effort of THINKING_EFFORTS) {
		if (efforts.includes(effort)) return effort;
	}
	return efforts[0];
}

/**
 * Clamp target for effort-less requests on `thinking.requiresEffort` models:
 * the effort whose wire route equals the model's default wire id
 * (`requestModelId`), so a collapsed row clamps to the tier it already
 * advertises as its default rather than the numerically lowest supported tier
 * (e.g. Cursor Grok 4.5/4.6 default to `medium`, the only tier the Start plan
 * serves). Falls back to {@link minimumSupportedEffort} when no route matches
 * the default id — families whose default already is the minimum, or that
 * expose no routing, are unaffected.
 */
export function defaultSupportedEffort<TApi extends Api>(model: ApiModel<TApi>): Effort | undefined {
	const routing = model.thinking?.effortRouting;
	const defaultWireId = model.requestModelId;
	if (routing !== undefined && defaultWireId !== undefined) {
		const efforts = model.thinking?.efforts;
		for (const effort of THINKING_EFFORTS) {
			if (efforts?.includes(effort) && routing[effort] === defaultWireId) return effort;
		}
	}
	return minimumSupportedEffort(model);
}
