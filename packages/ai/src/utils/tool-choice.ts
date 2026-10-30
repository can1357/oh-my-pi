/**
 * Utility functions for mapping unified ToolChoice to provider-specific formats.
 */
import type { ToolChoice } from "../types";
import { extractHttpStatusFromError } from "@oh-my-pi/pi-utils";
import type { CapturedHttpErrorResponse } from "./http-inspector";

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
export function isForcedToolChoiceRejection(
	error: unknown,
	capturedErrorResponse?: CapturedHttpErrorResponse,
): boolean {
	const status = extractHttpStatusFromError(error) ?? capturedErrorResponse?.status;
	if (status !== 400) return false;

	let errorJson: string | undefined;
	let bodyJson: string | undefined;
	if (error && typeof error === "object") {
		if ("error" in error && typeof error.error === "object" && error.error !== null) {
			try {
				errorJson = JSON.stringify(error.error);
			} catch {
				// ignore
			}
		}
		if ("body" in error && typeof error.body === "object" && error.body !== null) {
			try {
				bodyJson = JSON.stringify(error.body);
			} catch {
				// ignore
			}
		}
	}

	const parts = [
		error instanceof Error ? error.message : typeof error === "string" ? error : undefined,
		errorJson,
		bodyJson,
		capturedErrorResponse?.bodyText,
	]
		.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
		.join("\n");

	if (!parts) return false;
	return FORCED_TOOL_CHOICE_REJECTION_PATTERNS.some(pattern => pattern.test(parts));
}
