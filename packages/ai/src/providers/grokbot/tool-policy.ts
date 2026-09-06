/**
 * Family-aware Grok Bot sand tool-wire policy.
 *
 * Anthropic identity and catalog `sand-tools-wire` / `supports-tools` decide
 * the advertised field-2 shape. Non-Anthropic families keep raw omp names
 * (`bash` / `read` / `write`) because sand accepts those on grok/gpt/gemini/…
 */
import { classifyModel } from "@oh-my-pi/pi-catalog/compat/taxonomy";
import type { ModelIdentity } from "@oh-my-pi/pi-catalog/compat/types";
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

export const GROKBOT_MATRIX_REPRESENTATIVE_IDS = [
	"claude-opus-5",
	"claude-sonnet-5",
	"claude-haiku-4-5",
	"claude-fable-5",
	"grok-4.6",
	"grok-4.5",
	"gemini-3.7-flash",
	"gpt-5.6-sol",
	"composer-2.5",
	"kimi-k3",
	"glm-5.2",
	"sand-default",
	"sand-cua",
	"sand-automation",
] as const;

/** Extra live-id tokens to pick one openai-family row each (sol already listed). */
const OPENAI_SLICE_TOKENS = ["luna", "terra"] as const;

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
	return { kind: "native", wire, identity };
}

export function applyGrokbotSandToolPolicy(
	input: AnthropicSandToolWireInput,
	policy: GrokbotSandToolPolicy,
): AnthropicSandToolWireResult {
	if (policy.kind === "disabled") return input;
	return applyAnthropicSandToolWire(input, policy.wire);
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
	for (const id of GROKBOT_MATRIX_REPRESENTATIVE_IDS) take(id);
	for (const token of OPENAI_SLICE_TOKENS) {
		const match = liveIds.find(id => id.toLowerCase().includes(token) && !seen.has(id));
		if (match) take(match);
	}
	return picked;
}

export { OMP_TO_SAND_FIELD2, isAnthropicSandModelId, toSandField2Name };
