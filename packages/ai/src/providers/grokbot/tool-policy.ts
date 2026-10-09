/**
 * Family-aware Grok Bot sand tool-wire policy.
 *
 * Anthropic identity and catalog `sand-tools-wire` / `supports-tools` decide
 * the advertised field-2 shape. Non-Anthropic families keep raw omp names
 * (`bash` / `read` / `write`) because sand accepts those on grok/gpt/gemini/…
 */
import { classifyModel } from "@oh-my-pi/pi-catalog/compat/taxonomy";
import type { ModelIdentity } from "@oh-my-pi/pi-catalog/compat/types";
import { adaptSchemaForStrict, normalizeSchemaForGoogle } from "../../utils/schema";
import {
	applyAnthropicSandToolWire,
	isAnthropicSandModelId,
	resolveAnthropicSandToolsWire,
	type AnthropicSandToolsWire,
	type AnthropicSandToolWireInput,
	type AnthropicSandToolWireResult,
	type AnthropicSandWireResolveContext,
} from "./anthropic-sand-wire";
import { OMP_TO_SAND_FIELD2, toSandField2Name, wrapToolParameters } from "./product-wire";

export type GrokbotSandToolKind = "product" | "native" | "disabled";

export type GrokbotSandToolPolicy = {
	kind: GrokbotSandToolKind;
	wire: AnthropicSandToolsWire;
	identity: ModelIdentity;
	reason?: string;
};

/** Catalog row shape needed to pick representative matrix samples. */
export type GrokbotMatrixModelRef = {
	id: string;
	/** Reviewed catalog `sand-tools-wire` — parent-chat/automation mark routers. */
	sandToolsWire?: string;
};

/** Product-wire routers from catalog policy (not id spelling). */
function isGrokbotRouter(model: GrokbotMatrixModelRef): boolean {
	return model.sandToolsWire === "parent-chat" || model.sandToolsWire === "automation";
}

/** Prefer non-parameterized, shorter catalog ids when choosing a class sample. */
function preferMatrixId(a: string, b: string): number {
	const aParam = a.includes("[") ? 1 : 0;
	const bParam = b.includes("[") ? 1 : 0;
	if (aParam !== bParam) return aParam - bParam;
	return a.length - b.length || a.localeCompare(b);
}

export function grokbotToolsSkipReason(model: { id: string; supportsTools?: boolean }): string | undefined {
	if (model.supportsTools === false) {
		return "catalog supports-tools=false (upstream HTTP 422 with any tools payload)";
	}
	return undefined;
}

export function resolveGrokbotSandToolPolicy(opts: {
	modelId: string;
	/**
	 * Canonical AvailableModels name when `modelId` is a variant/legacy selector.
	 * Family-dependent wire policy classifies this id, not the opaque selector.
	 */
	requestModelId?: string;
	toolCount: number;
	sandToolsWire?: AnthropicSandWireResolveContext["sandToolsWire"];
	supportsTools?: boolean;
	envWire?: string;
	optionWire?: AnthropicSandToolsWire;
}): GrokbotSandToolPolicy {
	const policyModelId = opts.requestModelId?.trim() || opts.modelId;
	const identity = classifyModel("grokbot", policyModelId, { lenient: true });
	if (opts.toolCount > 0 && opts.supportsTools === false) {
		return {
			kind: "disabled",
			wire: "error",
			identity,
			reason: grokbotToolsSkipReason({ id: opts.modelId, supportsTools: false }),
		};
	}
	const wire = resolveAnthropicSandToolsWire(opts.envWire, opts.optionWire, {
		modelId: policyModelId,
		toolCount: opts.toolCount,
		sandToolsWire: opts.sandToolsWire,
	});
	if (wire === "keep-model" || wire === "automation" || wire === "parent-chat") {
		return { kind: "product", wire, identity };
	}
	if (wire === "sand-default-fallback") {
		return { kind: "native", wire, identity };
	}
	// Native families (grok/gpt/gemini/…) used to leak resolve's "error"
	// sentinel into matrix `wire:` even when tools passed.
	return { kind: "native", wire: "native", identity };
}

export function applyGrokbotSandToolPolicy(
	input: AnthropicSandToolWireInput,
	policy: GrokbotSandToolPolicy,
): AnthropicSandToolWireResult {
	if (policy.kind === "disabled") return input;
	return applyAnthropicSandToolWire(input, policy.wire);
}

/**
 * Native field-2 parameter schema projection from catalog
 * `sand-native-tool-schema` (not model class). Unset keeps the raw omp schema.
 *
 * `google` strips leftover JSON Schema keywords Gemini backends reject.
 * `strict` forces `additionalProperties: false` for OpenAI-class sand backends.
 */
export function nativeToolParametersForIdentity(
	schema: Record<string, unknown>,
	projection?: "google" | "strict",
): Record<string, unknown> {
	if (projection === "google") {
		const normalized = normalizeSchemaForGoogle(schema);
		// Sand's Gemini adapter reads the AI SDK schema envelope. Sending the
		// bare schema hides its properties and produces calls with empty args.
		if (normalized && typeof normalized === "object" && !Array.isArray(normalized)) {
			return wrapToolParameters(normalized as Record<string, unknown>);
		}
		return wrapToolParameters(schema);
	}
	if (projection === "strict") {
		return adaptSchemaForStrict(schema, true).schema;
	}
	return schema;
}

/** Advertised field-2 names after family mapping (product PascalCase or omp native). */
export function advertisedSandToolNames(ompToolNames: readonly string[], policy: GrokbotSandToolPolicy): string[] {
	if (policy.kind !== "product") return [...ompToolNames];
	const seen = new Set<string>();
	const out: string[] = [];
	if (policy.wire === "parent-chat") {
		out.push("SendToUser");
		seen.add("SendToUser");
	}
	for (const name of ompToolNames) {
		const sand = toSandField2Name(name);
		if (seen.has(sand)) continue;
		seen.add(sand);
		out.push(sand);
	}
	return out;
}

export function selectGrokbotMatrixIds(
	liveModels: readonly GrokbotMatrixModelRef[],
	slice: "representative" | "all",
): string[] {
	const liveIds = liveModels.map(model => model.id);
	if (slice === "all") return [...liveIds];
	const byId = new Map(liveModels.map(model => [model.id, model]));
	const live = new Set(liveIds);
	const picked: string[] = [];
	const seen = new Set<string>();
	const take = (id: string) => {
		if (!id || seen.has(id) || !live.has(id)) return;
		seen.add(id);
		picked.push(id);
	};

	// Routers first — catalog sand-tools-wire parent-chat/automation, not id tokens.
	for (const model of liveModels) {
		if (isGrokbotRouter(model)) take(model.id);
	}

	// One live row per classifyModel identity bucket so renamed catalog ids still gate.
	// OpenAI peers that share class/family but differ by revision (luna/terra/sol
	// generations) each keep a sample — still taxonomy facts, never id substrings.
	const byIdentity = new Map<string, string[]>();
	const unknown: string[] = [];
	for (const id of liveIds) {
		if (seen.has(id)) continue;
		const identity = classifyModel("grokbot", id, { lenient: true });
		if (!identity.class || identity.class === "unknown") {
			unknown.push(id);
			continue;
		}
		const key =
			identity.class === "openai"
				? `${identity.class}:${identity.family ?? "_"}:${identity.revision ?? "_"}`
				: `${identity.class}:${identity.family ?? "_"}`;
		const list = byIdentity.get(key) ?? [];
		list.push(id);
		byIdentity.set(key, list);
	}
	for (const ids of byIdentity.values()) {
		const sorted = [...ids].sort(preferMatrixId);
		take(sorted[0]!);
	}
	// One unclassified product row (e.g. composer) — shortest non-router.
	const unknownSorted = unknown
		.filter(id => {
			const model = byId.get(id);
			return !model || !isGrokbotRouter(model);
		})
		.sort(preferMatrixId);
	if (unknownSorted[0]) take(unknownSorted[0]);

	return picked;
}

export { OMP_TO_SAND_FIELD2, isAnthropicSandModelId, toSandField2Name };
