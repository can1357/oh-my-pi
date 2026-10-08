import { type ToolCall, validateToolArguments } from "@oh-my-pi/pi-ai";
import type { AgentTool } from "./types";

/**
 * Where a call's `__parseError`/`__rawJson` keys came from.
 * - `"parsed"`: a provider stream parsed the arguments, so `__parseError` is a
 *   genuine parse-failure sentinel and is never handed to a tool.
 * - `"payload"`: the arguments are a payload the model wrote (eval tool bridge,
 *   `xd://` device content), so those keys are forged and only stripped.
 */
export type ToolArgumentSource = "parsed" | "payload";

/**
 * Validate a call's arguments against `tool`'s schema, honoring
 * {@link AgentTool.lenientArgValidation}: on a schema mismatch a lenient tool
 * receives its raw arguments minus the internal `__parseError`/`__rawJson`
 * sentinels. Malformed JSON from a provider stream is never lenient.
 *
 * @throws the validation error when the tool is strict or the arguments failed to parse.
 */
export function validateAgentToolArguments(
	tool: AgentTool,
	toolCall: ToolCall,
	source: ToolArgumentSource = "parsed",
): ToolCall["arguments"] {
	try {
		return validateToolArguments(tool, toolCall);
	} catch (error) {
		const args: unknown = toolCall.arguments;
		if (!tool.lenientArgValidation) throw error;
		if (args === null || typeof args !== "object" || Array.isArray(args)) return args as ToolCall["arguments"];
		if (source === "parsed" && "__parseError" in args) throw error;
		const fallback = { ...(args as Record<string, unknown>) };
		delete fallback.__parseError;
		delete fallback.__rawJson;
		return fallback;
	}
}
