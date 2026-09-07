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
import { OMP_TO_SAND_FIELD2, toSandField2Name } from "./product-wire";

export type GrokbotSandToolKind = "product" | "native" | "disabled";

export type GrokbotSandToolPolicy = {
	kind: GrokbotSandToolKind;
	wire: AnthropicSandToolsWire;
	identity: ModelIdentity;
	reason?: string;
};

/** Extra live-id tokens to pick one openai-family row each (sol already listed). */
const OPENAI_SLICE_TOKENS = ["luna", "terra", "sol"] as const;

/** Sand / Auto routers — product wire ids, not versioned model lines. */
function isGrokbotRouterId(id: string): boolean {
	const base = id.split("[")[0]?.trim().toLowerCase() ?? "";
	return base === "default" || base === "auto" || base.startsWith("sand-");
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
	toolCount: number;
	sandToolsWire?: AnthropicSandWireResolveContext["sandToolsWire"];
	supportsTools?: boolean;
	envWire?: string;
	optionWire?: AnthropicSandToolsWire;
}): GrokbotSandToolPolicy {
	const identity = classifyModel("grokbot", opts.modelId, { lenient: true });
	if (opts.toolCount > 0 && opts.supportsTools === false) {
		return {
			kind: "disabled",
			wire: "error",
			identity,
			reason: grokbotToolsSkipReason({ id: opts.modelId, supportsTools: false }),
		};
	}
	const wire = resolveAnthropicSandToolsWire(opts.envWire, opts.optionWire, {
		modelId: opts.modelId,
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
 * Family-specific native field-2 parameter schema.
 *
 * Gemini backends reject leftover JSON Schema keywords (`additionalProperties`,
 * `format`, …). OpenAI mini/strict backends require `additionalProperties: false`.
 * Other families keep the raw omp JSON Schema (the working grok/composer path).
 */
export function nativeToolParametersForIdentity(
	schema: Record<string, unknown>,
	identity: Pick<ModelIdentity, "class">,
): Record<string, unknown> {
	if (identity.class === "gemini") {
		const normalized = normalizeSchemaForGoogle(schema);
		if (normalized && typeof normalized === "object" && !Array.isArray(normalized)) {
			return normalized as Record<string, unknown>;
		}
		return schema;
	}
	if (identity.class === "openai") {
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

export function selectGrokbotMatrixIds(liveIds: readonly string[], slice: "representative" | "all"): string[] {
	if (slice === "all") return [...liveIds];
	const live = new Set(liveIds);
	const picked: string[] = [];
	const seen = new Set<string>();
	const take = (id: string) => {
		if (!id || seen.has(id) || !live.has(id)) return;
		seen.add(id);
		picked.push(id);
	};

	// Routers first (product wire ids — not versioned model lines).
	for (const id of liveIds) {
		if (isGrokbotRouterId(id)) take(id);
	}

	// One live row per classifyModel class/family so renamed catalog ids still gate.
	const byClassFamily = new Map<string, string[]>();
	const unknown: string[] = [];
	for (const id of liveIds) {
		if (seen.has(id)) continue;
		const identity = classifyModel("grokbot", id, { lenient: true });
		if (!identity.class || identity.class === "unknown") {
			unknown.push(id);
			continue;
		}
		const key = `${identity.class}:${identity.family ?? "_"}`;
		const list = byClassFamily.get(key) ?? [];
		list.push(id);
		byClassFamily.set(key, list);
	}
	for (const ids of byClassFamily.values()) {
		const sorted = [...ids].sort(preferMatrixId);
		take(sorted[0]!);
	}
	// OpenAI deployments also keep one luna/terra/sol peer when present.
	for (const token of OPENAI_SLICE_TOKENS) {
		const match = liveIds.find(
			id =>
				!seen.has(id) &&
				id.toLowerCase().includes(token) &&
				classifyModel("grokbot", id, { lenient: true }).class === "openai",
		);
		if (match) take(match);
	}
	// One unclassified product row (e.g. composer) — shortest non-router.
	const unknownSorted = unknown.filter(id => !isGrokbotRouterId(id)).sort(preferMatrixId);
	if (unknownSorted[0]) take(unknownSorted[0]);

	return picked;
}

export { OMP_TO_SAND_FIELD2, isAnthropicSandModelId, toSandField2Name };
