/**
 * Utility functions for mapping unified ToolChoice to provider-specific formats.
 */
import { resolveFactoryDroidPolicy } from "@oh-my-pi/pi-catalog/compat/factory-droid";
import type { Effort, Model, ToolChoice } from "../types";

/** OpenAI Completions API tool choice format */
export type OpenAICompletionsToolChoice =
	| "auto"
	| "none"
	| "required"
	| { type: "function"; function: { name: string } }
	| undefined;

/** OpenAI Responses API tool choice format (flat structure) */
export type OpenAIResponsesToolChoice =
	| "auto"
	| "none"
	| "required"
	| { type: "function"; name: string }
	| { type: "custom"; name: string }
	| { type: "computer" }
	| undefined;

/** Anthropic-compatible tool choice format */
export type AnthropicToolChoice = "auto" | "none" | "any" | { type: "tool"; name: string } | undefined;

/**
 * Extract function name from unified ToolChoice.
 */
function extractFunctionName(choice: ToolChoice): string | undefined {
	if (typeof choice === "string") return undefined;
	if (choice.type === "tool" && "name" in choice) return choice.name;
	if (choice.type === "function") {
		if ("function" in choice && choice.function && typeof choice.function === "object") {
			return (choice.function as { name?: string }).name;
		}
		if ("name" in choice) return choice.name;
	}
	return undefined;
}

/**
 * Map unified ToolChoice to OpenAI Completions API format.
 * - "any" → "required"
 * - { type: "tool", name } → { type: "function", function: { name } }
 */
export function mapToOpenAICompletionsToolChoice(choice?: ToolChoice): OpenAICompletionsToolChoice {
	if (!choice) return undefined;
	if (typeof choice === "string") {
		if (choice === "any") return "required";
		if (choice === "auto" || choice === "none" || choice === "required") return choice;
		return undefined;
	}
	const name = extractFunctionName(choice);
	return name ? { type: "function", function: { name } } : undefined;
}

/**
 * Returns true when an OpenAI-completions `tool_choice` value forces a tool
 * call (`"required"` or a function-name pin), as opposed to leaving it open
 * (`"auto"`, `"none"`, or unset). Accepts `unknown` because the param shape
 * pulled from the OpenAI SDK (`ChatCompletionToolChoiceOption`) widens with
 * each release; this check only needs the open/forced bit.
 */
export function isForcedToolChoice(choice: unknown): boolean {
	if (choice === undefined || choice === "auto" || choice === "none") return false;
	return true;
}

/** Whether forced tools can retain this model's enabled, fixed thinking effort. */
export function canForceToolChoiceWhilePreservingEffort(model: Model, reasoning?: Effort): boolean {
	if (model.supportsTools === false) return false;
	const compat = model.compat;
	if (compat && typeof compat === "object") {
		if ("supportsToolChoice" in compat && compat.supportsToolChoice === false) return false;
		if ("supportsForcedToolChoice" in compat && compat.supportsForcedToolChoice === false) return false;
		if ("supportsNamedToolChoice" in compat && compat.supportsNamedToolChoice === false) return false;
	}
	if (reasoning === undefined || !model.reasoning) return true;
	if (
		model.api === "anthropic-messages" ||
		model.api === "bedrock-converse-stream" ||
		(model.api === "factory-droid-agent" && resolveFactoryDroidPolicy(model)?.wire === "anthropic-messages")
	) {
		return false;
	}
	if (compat && typeof compat === "object") {
		if ("disableReasoningOnForcedToolChoice" in compat && compat.disableReasoningOnForcedToolChoice) return false;
		if ("disableReasoningOnToolChoice" in compat && compat.disableReasoningOnToolChoice) return false;
		if ("disableReasoningWithTools" in compat && compat.disableReasoningWithTools) return false;
	}
	return true;
}

/**
 * Map unified ToolChoice to OpenAI Responses API format.
 * - "any" → "required"
 * - { type: "tool", name } → { type: "function", name } (flat structure)
 */
export function mapToOpenAIResponsesToolChoice(choice?: ToolChoice): OpenAIResponsesToolChoice {
	if (!choice) return undefined;
	if (typeof choice === "string") {
		if (choice === "any") return "required";
		if (choice === "auto" || choice === "none" || choice === "required") return choice;
		return undefined;
	}
	if (choice.type === "computer") return { type: "computer" };
	const name = extractFunctionName(choice);
	return name ? { type: "function", name } : undefined;
}

/**
 * Map unified ToolChoice to Anthropic-compatible format.
 * - "required" → "any"
 * - { type: "function", ... } → { type: "tool", name }
 */
export function mapToAnthropicToolChoice(choice?: ToolChoice): AnthropicToolChoice {
	if (!choice) return undefined;
	if (typeof choice === "string") {
		if (choice === "required") return "any";
		if (choice === "auto" || choice === "none" || choice === "any") return choice;
		return undefined;
	}
	const name = extractFunctionName(choice);
	return name ? { type: "tool", name } : undefined;
}
