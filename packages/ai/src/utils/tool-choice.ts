/**
 * Utility functions for mapping unified ToolChoice to provider-specific formats.
 */
import { logger } from "@oh-my-pi/pi-utils";
import type { ToolChoice } from "../types";

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

const FORCED_TOOL_CHOICE_REJECTION_PATTERNS: readonly RegExp[] = [
	/(?:tool_choice:\s*)?type\s+\\?["']?tool\\?["']?\s+and\s+\\?["']?any\\?["']?\s+are not supported for this model/i,
	/tool_choice forces tool use is not compatible with this model/i,
	/tool_choice\s+\\?["']?specified\\?["']?\s+is incompatible with thinking enabled/i,
	/only\s+\\?["']?auto\\?["']?\s+is supported for\s+\\?["']?tool_choice\\?["']?/i,
	/thinking mode does not support this tool_choice/i,
];

/**
 * Returns true if an HTTP error status and body text represent a model's
 * refusal to accept a forced tool_choice selector. Matches only wordings
 * documented in this repository.
 */
export function isForcedToolChoiceRejection(status: number | undefined, errorText: string | undefined): boolean {
	if (status !== 400 || !errorText || typeof errorText !== "string") return false;
	return FORCED_TOOL_CHOICE_REJECTION_PATTERNS.some(pattern => pattern.test(errorText));
}

const rejectedModels = new Set<string>();
const warnedKeys = new Set<string>();

export function normalizeToolChoiceBaseUrl(baseUrl?: string): string {
	if (!baseUrl) return "";
	const trimmed = baseUrl.trim().replace(/\/+$/, "");
	return trimmed.endsWith("/v1") ? trimmed.slice(0, -3) : trimmed;
}

export function createForcedToolChoiceKey(
	model: { provider: string; baseUrl?: string; id: string },
	baseUrlOverride?: string,
): string {
	const rawBaseUrl = baseUrlOverride ?? model.baseUrl;
	return `${model.provider}:${normalizeToolChoiceBaseUrl(rawBaseUrl)}:${model.id}`;
}

export function noteForcedToolChoiceRejected(
	model: { provider: string; baseUrl?: string; id: string },
	baseUrlOverride?: string,
): void {
	const key = createForcedToolChoiceKey(model, baseUrlOverride);
	rejectedModels.add(key);
	if (baseUrlOverride) {
		rejectedModels.add(createForcedToolChoiceKey(model));
	}
	if (model.baseUrl) {
		rejectedModels.add(createForcedToolChoiceKey(model, model.baseUrl));
	}
	if (!warnedKeys.has(key)) {
		warnedKeys.add(key);
		logger.warn("forced tool_choice rejected by model, downgrading to auto", {
			model: model.id,
			provider: model.provider,
			hint: "catalog compat supportsForcedToolChoice: false is missing",
		});
	}
}

export function isForcedToolChoiceRejected(
	model: { provider: string; baseUrl?: string; id: string },
	baseUrlOverride?: string,
): boolean {
	if (baseUrlOverride && rejectedModels.has(createForcedToolChoiceKey(model, baseUrlOverride))) {
		return true;
	}
	if (model.baseUrl && rejectedModels.has(createForcedToolChoiceKey(model, model.baseUrl))) {
		return true;
	}
	return rejectedModels.has(createForcedToolChoiceKey(model));
}

export function supportsForcedToolChoice(
	model: { provider: string; baseUrl?: string; id: string; compat?: { supportsForcedToolChoice?: boolean } },
	baseUrlOverride?: string,
): boolean {
	if (model.compat?.supportsForcedToolChoice === false) return false;
	if (isForcedToolChoiceRejected(model, baseUrlOverride)) return false;
	return true;
}

export function clearForcedToolChoiceRejectedForTests(): void {
	rejectedModels.clear();
	warnedKeys.clear();
}
