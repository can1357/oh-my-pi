import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { type Component, Markdown } from "@oh-my-pi/pi-tui";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import { getMarkdownTheme, type Theme } from "../modes/theme/theme";

/** Whether a model transport can suppress native reasoning while private scratchpad thoughts are active. */
export function supportsExternalThinking(model: Model | null | undefined): boolean {
	if (!model) return false;
	const compat = model.compat;
	const requiresThinking =
		model.api === "anthropic-messages" &&
		compat !== undefined &&
		"requiresThinkingEnabled" in compat &&
		compat.requiresThinkingEnabled === true;
	if (model.reasoning && (requiresThinking || (model.thinking?.requiresEffort && !model.thinking.suppressWhenOff))) {
		return false;
	}
	// Transports that reject `reasoning.effort` (xAI Grok 4 and the other
	// reasoning-only Responses models) cannot honour `forceReasoningOff`, so the
	// scratchpad would run alongside native reasoning instead of replacing it.
	if (
		model.reasoning &&
		compat !== undefined &&
		(("omitReasoningEffort" in compat && compat.omitReasoningEffort === true) ||
			("supportsReasoningEffort" in compat && compat.supportsReasoningEffort === false))
	) {
		return false;
	}
	if (model.api === "google-generative-ai" || model.api === "google-gemini-cli" || model.api === "google-vertex") {
		return !model.reasoning || model.thinking?.mode === "budget" || model.thinking?.suppressWhenOff === true;
	}
	return (
		model.api === "openai-responses" ||
		model.api === "azure-openai-responses" ||
		model.api === "openai-codex-responses" ||
		model.api === "anthropic-messages"
	);
}

const thinkSchema = type({
	thoughts: type("string").describe("private scratchpad; not shown to user"),
	"+": "reject",
}).describe("private scratchpad; not shown to user");

type ThinkParams = typeof thinkSchema.infer;

export type ThinkRenderArgs = {
	thoughts?: string;
};

export const thinkToolRenderer = {
	inline: true,
	renderCall(args: ThinkRenderArgs, _options: RenderResultOptions, uiTheme: Theme): Component {
		const thoughts =
			typeof args === "object" && args !== null && "thoughts" in args && typeof args.thoughts === "string"
				? args.thoughts
				: "";
		return new Markdown(thoughts, 1, 0, getMarkdownTheme(), {
			color: (text: string) => uiTheme.fg("thinkingText", text),
			italic: true,
		});
	},
	renderResult(): Component {
		return undefined as unknown as Component;
	},
};

interface ThinkToolDetails {
	recorded: true;
}

/** Records private scratchpad thoughts while native model reasoning is disabled. */
export class ThinkTool implements AgentTool<typeof thinkSchema, ThinkToolDetails> {
	readonly name = "think";
	readonly approval = "read" as const;
	readonly label = "Think";
	readonly summary = "Record private scratchpad thoughts";
	readonly description = "private scratchpad; not shown to user";
	readonly parameters = thinkSchema;
	readonly strict = true;
	readonly intent = "omit" as const;

	async execute(_toolCallId: string, _params: ThinkParams): Promise<AgentToolResult<ThinkToolDetails>> {
		return {
			content: [
				{
					type: "text",
					text: "------",
				},
			],
			details: { recorded: true },
		};
	}
}
