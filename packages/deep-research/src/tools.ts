import {
	type AssistantMessage,
	type Context,
	completeSimple,
	type Model,
	type SimpleStreamOptions,
	type Tool,
	z,
} from "@pk-nerdsaver-ai/pi-ai";
import thinkToolDescription from "./prompts/think-tool.md" with { type: "text" };
import { assertCompletionOk } from "./utils";

export const THINK_TOOL_NAME = "think_tool";
export const CONDUCT_RESEARCH_TOOL_NAME = "ConductResearch";
export const RESEARCH_COMPLETE_TOOL_NAME = "ResearchComplete";

export const thinkTool: Tool = {
	name: THINK_TOOL_NAME,
	description: thinkToolDescription.trim(),
	parameters: z.object({
		reflection: z.string().describe("Your detailed reflection on research progress, findings, gaps, and next steps"),
	}),
};

export const conductResearchTool: Tool = {
	name: CONDUCT_RESEARCH_TOOL_NAME,
	description: "Call this tool to conduct research on a specific topic.",
	parameters: z.object({
		research_topic: z
			.string()
			.describe(
				"The topic to research. Should be a single topic, and should be described in high detail (at least a paragraph).",
			),
	}),
};

export const researchCompleteTool: Tool = {
	name: RESEARCH_COMPLETE_TOOL_NAME,
	description: "Call this tool to indicate that the research is complete.",
	parameters: z.object({}),
};

export interface StructuredOutputRequest<T> {
	model: Model;
	context: Context;
	/** Tool name + schema the model is forced to call; its arguments are the structured output. */
	tool: Tool;
	schema: z.ZodType<T>;
	maxTokens: number;
	maxRetries: number;
	options?: Partial<SimpleStreamOptions>;
}

/**
 * pi-ai counterpart of LangChain's `with_structured_output(...)`: force a tool
 * call and validate its arguments against the zod schema, retrying when the
 * model fails to produce a valid call.
 */
export async function completeStructured<T>(
	request: StructuredOutputRequest<T>,
): Promise<{ value: T; message: AssistantMessage }> {
	let lastError: Error | undefined;
	for (let attempt = 0; attempt < request.maxRetries; attempt++) {
		const message = await completeSimple(
			request.model,
			{ ...request.context, tools: [request.tool] },
			{
				...request.options,
				maxTokens: request.maxTokens,
				toolChoice: { type: "function", name: request.tool.name },
			},
		);
		assertCompletionOk(message);
		const call = message.content.find(block => block.type === "toolCall" && block.name === request.tool.name);
		if (call && call.type === "toolCall") {
			const parsed = request.schema.safeParse(call.arguments);
			if (parsed.success) return { value: parsed.data, message };
			lastError = new Error(`Structured output failed schema validation: ${parsed.error.message}`);
			continue;
		}
		lastError = new Error("Model did not produce the forced tool call for structured output");
	}
	throw lastError ?? new Error("Structured output failed");
}
