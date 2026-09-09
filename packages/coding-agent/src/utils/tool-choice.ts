import type { Api, Model, ToolChoice } from "@oh-my-pi/pi-ai";

/**
 * Build a provider-aware tool choice that targets one specific tool when supported.
 * Providers that only expose required/any forcing may still honor named choices by
 * narrowing their request tool list before transport.
 */
export function buildNamedToolChoice(toolName: string, model?: Model<Api>): ToolChoice | undefined {
	if (!model) return undefined;

	if (model.api === "anthropic-messages" || model.api === "bedrock-converse-stream") {
		return { type: "tool", name: toolName };
	}

	if (
		model.api === "openai-codex-responses" ||
		model.api === "openai-responses" ||
		model.api === "openai-completions" ||
		model.api === "azure-openai-responses"
	) {
		return { type: "function", name: toolName };
	}

	if (model.api === "ollama-chat") {
		return { type: "function", name: toolName };
	}

	if (model.api === "google-generative-ai" || model.api === "google-gemini-cli" || model.api === "google-vertex") {
		return "required";
	}

	return undefined;
}

/**
 * Whether the given tool choice can be satisfied by the active tool set for the
 * upcoming turn. Non-named choices (`"none"`, `"required"`, etc.) do not name a
 * specific tool and are therefore always active.
 */
export function isToolChoiceActive(toolChoice: ToolChoice | undefined, tools: readonly { name: string }[]): boolean {
	if (!toolChoice || typeof toolChoice === "string") return true;
	if (toolChoice.type === "computer") return tools.some(tool => tool.name === "computer");
	const name =
		toolChoice.type === "tool"
			? toolChoice.name
			: "function" in toolChoice
				? toolChoice.function.name
				: toolChoice.name;
	return tools.some(tool => tool.name === name);
}
