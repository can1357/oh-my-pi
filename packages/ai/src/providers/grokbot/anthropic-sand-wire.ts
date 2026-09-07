/**
 * Sand InferenceService wire policy for explicit Anthropic model ids + agent tools.
 *
 * Raw omp field-2 tools on explicit Anthropic ids fail ERROR_PROVIDER_ERROR.
 * Product PascalCase field-2 tools with jsonSchema envelopes on the original
 * Anthropic requestedModel work (keep-model). automation remains an opt-in
 * grok worker rewrite to sand-automation + generalPurpose.
 *
 * Anthropic identity comes from catalog taxonomy (`classifyModel`), not id spelling.
 */
import { classifyModel } from "@oh-my-pi/pi-catalog/compat/taxonomy";
import type { GrokbotRequestedModel } from "./model-request";
import { resolveGrokbotRequestedModel } from "./model-request";
import {
	field9AllowlistForProfile,
	toProductField2Tools,
	type ProductWireProfile,
	type ProductWireTool,
} from "./product-wire";

export type AnthropicSandToolsWire =
	| "error"
	| "native"
	| "sand-default-fallback"
	| "automation"
	| "keep-model"
	| "parent-chat"
	| "auto";

export function isAnthropicSandModelId(modelId: string, provider = "grokbot"): boolean {
	const id = modelId.trim();
	if (!id) return false;
	return classifyModel(provider, id, { lenient: true }).class === "anthropic";
}

export type AnthropicSandWireResolveContext = {
	modelId: string;
	toolCount: number;
	/**
	 * Reviewed catalog fact (`sand-tools-wire`) for synthetic routers.
	 * When set, auto mode uses this instead of comparing model ids.
	 */
	sandToolsWire?: "parent-chat" | "automation" | "keep-model" | "error" | "native" | "sand-default-fallback";
};

export function resolveAnthropicSandToolsWire(
	envValue: string | undefined,
	optionValue: AnthropicSandToolsWire | undefined,
	context?: AnthropicSandWireResolveContext,
): AnthropicSandToolsWire {
	const raw = (optionValue ?? envValue ?? "auto").trim().toLowerCase();
	if (raw === "sand-default-fallback" || raw === "sand-default" || raw === "fallback") {
		return "sand-default-fallback";
	}
	if (raw === "automation" || raw === "product") return "automation";
	if (raw === "keep-model" || raw === "keep-id" || raw === "keep") return "keep-model";
	if (raw === "parent-chat" || raw === "parent") return "parent-chat";
	if (raw === "native") return "native";
	if (raw === "error") return "error";
	if (raw !== "auto") return "error";

	const toolCount = context?.toolCount ?? 0;
	const modelId = context?.modelId?.trim() ?? "";
	if (toolCount === 0) return "error";
	if (isAnthropicSandModelId(modelId)) return "keep-model";
	const catalogWire = context?.sandToolsWire;
	if (
		catalogWire === "parent-chat" ||
		catalogWire === "automation" ||
		catalogWire === "keep-model" ||
		catalogWire === "error" ||
		catalogWire === "native" ||
		catalogWire === "sand-default-fallback"
	) {
		return catalogWire;
	}
	return "native";
}

export type AnthropicSandToolWireInput = {
	requestedModel: GrokbotRequestedModel;
	tools: unknown[];
	/** User-facing catalog model id (before requestModelId resolution). */
	modelId?: string;
	/** Raw omp tools for product mapping. */
	ompTools?: unknown[];
	/**
	 * Catalog `sand-tools-wire` for this row. Lets router ids (sand-cua, …)
	 * take the product profile without TypeScript id compares.
	 */
	sandToolsWire?: AnthropicSandWireResolveContext["sandToolsWire"];
};

export type AnthropicSandToolWireResult = AnthropicSandToolWireInput & {
	wireMode?: AnthropicSandToolsWire;
	originalModelId?: string;
	subagentType?: string;
	automationId?: string;
	acceptedUnadvertisedToolNames?: string[];
};

function productProfileForWire(wire: AnthropicSandToolsWire): ProductWireProfile | undefined {
	if (wire === "automation" || wire === "keep-model") return "automation";
	if (wire === "parent-chat") return "parent-chat";
	return undefined;
}

function applyProductWire(
	input: AnthropicSandToolWireInput,
	profile: ProductWireProfile,
	wireMode: AnthropicSandToolsWire,
	options: {
		requestedModel: GrokbotRequestedModel;
		subagentType?: string;
		automationId?: string;
		originalModelId?: string;
	},
): AnthropicSandToolWireResult {
	const ompTools = (input.ompTools ?? input.tools) as Parameters<typeof toProductField2Tools>[0];
	const productTools: ProductWireTool[] = toProductField2Tools(ompTools, profile);
	return {
		...input,
		requestedModel: options.requestedModel,
		tools: productTools,
		wireMode,
		originalModelId: options.originalModelId,
		...(options.subagentType !== undefined ? { subagentType: options.subagentType } : {}),
		...(options.automationId !== undefined ? { automationId: options.automationId } : {}),
		acceptedUnadvertisedToolNames: [...field9AllowlistForProfile(profile)],
	};
}

export function applyAnthropicSandToolWire(
	input: AnthropicSandToolWireInput,
	wire: AnthropicSandToolsWire,
): AnthropicSandToolWireResult {
	const toolCount = Array.isArray(input.tools) ? input.tools.length : 0;
	const modelId = input.modelId?.trim() || input.requestedModel.modelId;
	if (toolCount === 0) return input;
	if (wire === "native") return { ...input, wireMode: "native" };

	if (wire === "keep-model") {
		const anthropic = isAnthropicSandModelId(modelId);
		const catalogOwns = input.sandToolsWire === "keep-model";
		// Anthropic keep-model is identity-owned. Catalog can also opt a
		// non-Anthropic row onto product tools without rewriting requestedModel.
		if (!anthropic && !catalogOwns) return input;
		return applyProductWire(input, "automation", "keep-model", {
			requestedModel: anthropic ? input.requestedModel : { modelId: input.requestedModel.modelId },
			originalModelId: modelId,
		});
	}

	const profile = productProfileForWire(wire);
	if (profile) {
		const anthropic = isAnthropicSandModelId(modelId);
		const catalogOwns = input.sandToolsWire === wire;
		// Non-Anthropic rows need an explicit catalog `sand-tools-wire` match —
		// do not special-case router ids in TypeScript (KDL owns that policy).
		if (profile === "automation" && !anthropic && !catalogOwns) {
			return input;
		}
		if (profile === "parent-chat" && !anthropic && !catalogOwns) {
			return input;
		}
		const automationModel = resolveGrokbotRequestedModel("sand-automation", {
			sandParameterIds: [],
			sandMaxMode: false,
		});
		if (profile === "automation") {
			// Routers already on this catalog wire keep their id, but drop
			// thinking/effort/fast — the historical working automation probe
			// used a bare `{ modelId: "sand-automation" }`. Extra params pin
			// cursor-grok-4.5-high into a JSON-as-text dump instead of toolCallPart.
			const keepRouter = !anthropic && catalogOwns;
			return applyProductWire(input, profile, wire, {
				requestedModel: keepRouter ? { modelId: input.requestedModel.modelId } : automationModel,
				subagentType: "generalPurpose",
				automationId: crypto.randomUUID(),
				originalModelId: anthropic ? modelId : undefined,
			});
		}
		// sand-default / sand-cua keep their router id but drop thinking/effort
		// params (same bare-wire lesson as automation). Auto aliases
		// (`default`, `default[]`, `auto`) rewrite to bare sand-default so a
		// Read/Write follow-up does not hang mid-tool on cursor-grok-4.5-high.
		const keepCua = modelId === "sand-cua" || input.requestedModel.modelId === "sand-cua";
		return applyProductWire(input, profile, wire, {
			requestedModel: keepCua ? { modelId: "sand-cua" } : { modelId: "sand-default" },
			originalModelId: anthropic ? modelId : undefined,
		});
	}

	if (!isAnthropicSandModelId(modelId)) return input;

	if (wire === "sand-default-fallback") {
		return {
			...input,
			wireMode: "sand-default-fallback",
			originalModelId: modelId,
			requestedModel: resolveGrokbotRequestedModel("sand-default", {
				sandParameterIds: [],
				sandMaxMode: false,
			}),
		};
	}

	throw new Error(
		`Grok Bot sand rejects field-2 agent tools on explicit Anthropic model "${modelId}" (HTTP 400). ` +
			`Options: set GROKBOT_ANTHROPIC_TOOLS_WIRE=keep-model (product tools on original Anthropic requestedModel); ` +
			`set GROKBOT_ANTHROPIC_TOOLS_WIRE=automation (product sand-automation wire); ` +
			`use grokbot/sand-default or grokbot/grok-4.6 for direct InferenceService tools; ` +
			`or set GROKBOT_ANTHROPIC_TOOLS_WIRE=sand-default-fallback to route via sand-default (model not guaranteed Opus).`,
	);
}
