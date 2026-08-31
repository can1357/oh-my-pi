/**
 * Sand InferenceService wire policy for explicit Anthropic model ids + agent tools.
 *
 * Live probes (2026-08-31): explicit `claude-*` + omp field-2 tools → HTTP 400.
 * Product routes coding tasks through sand-automation + generalPurpose with
 * PascalCase field-2 tools and jsonSchema envelopes (see product-wire.ts).
 */
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
	| "sand-default-fallback"
	| "automation"
	| "parent-chat"
	| "auto";

export function isAnthropicSandModelId(modelId: string): boolean {
	const id = modelId.trim().toLowerCase();
	return id.startsWith("claude-") || id.startsWith("claude_");
}

export type AnthropicSandWireResolveContext = {
	modelId: string;
	toolCount: number;
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
	if (raw === "parent-chat" || raw === "parent") return "parent-chat";
	if (raw === "error") return "error";
	if (raw !== "auto") return "error";

	const toolCount = context?.toolCount ?? 0;
	const modelId = context?.modelId?.trim() ?? "";
	if (toolCount === 0) return "error";
	if (isAnthropicSandModelId(modelId)) return "automation";
	if (modelId === "sand-default") return "parent-chat";
	if (modelId === "sand-automation") return "automation";
	return "error";
}

export type AnthropicSandToolWireInput = {
	requestedModel: GrokbotRequestedModel;
	tools: unknown[];
	/** User-facing catalog model id (before requestModelId resolution). */
	modelId?: string;
	/** Raw omp tools for product mapping. */
	ompTools?: unknown[];
};

export type AnthropicSandToolWireResult = AnthropicSandToolWireInput & {
	wireMode?: AnthropicSandToolsWire;
	originalModelId?: string;
	subagentType?: string;
	automationId?: string;
	acceptedUnadvertisedToolNames?: string[];
};

function productProfileForWire(wire: AnthropicSandToolsWire): ProductWireProfile | undefined {
	if (wire === "automation") return "automation";
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
		subagentType: options.subagentType,
		automationId: options.automationId,
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

	const profile = productProfileForWire(wire);
	if (profile) {
		if (
			profile === "automation" &&
			!isAnthropicSandModelId(modelId) &&
			modelId !== "sand-automation"
		) {
			return input;
		}
		if (
			profile === "parent-chat" &&
			!isAnthropicSandModelId(modelId) &&
			modelId !== "sand-default"
		) {
			return input;
		}
		const automationModel = resolveGrokbotRequestedModel("sand-automation", {
			sandParameterIds: [],
			sandMaxMode: false,
		});
		const parentModel = resolveGrokbotRequestedModel("sand-default", {
			sandParameterIds: [],
			sandMaxMode: false,
		});
		if (profile === "automation") {
			return applyProductWire(input, profile, wire, {
				requestedModel:
					modelId === "sand-automation" ? input.requestedModel : automationModel,
				subagentType: "generalPurpose",
				automationId: crypto.randomUUID(),
				originalModelId: isAnthropicSandModelId(modelId) ? modelId : undefined,
			});
		}
		return applyProductWire(input, profile, wire, {
			requestedModel: modelId === "sand-default" ? input.requestedModel : parentModel,
			originalModelId: isAnthropicSandModelId(modelId) ? modelId : undefined,
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
			`Options: set GROKBOT_ANTHROPIC_TOOLS_WIRE=automation (product sand-automation wire); ` +
			`use grokbot/sand-default or grokbot/grok-4.6 for direct InferenceService tools; ` +
			`use cursor/claude-opus-5:max for Opus AgentService; ` +
			`or set GROKBOT_ANTHROPIC_TOOLS_WIRE=sand-default-fallback to route via sand-default (model not guaranteed Opus).`,
	);
}
