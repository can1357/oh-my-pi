import type {
	AssistantMessage,
	Context,
	ImageContent,
	Message,
	TextContent,
	ToolCall,
	ToolResultMessage,
} from "../types";
import { getDialectDefinition } from "./factory";
import type { Dialect, DialectDefinition, DialectToolResult, InbandTool } from "./types";

export function encodeInbandToolHistory(
	messages: Context["messages"],
	dialect: Dialect,
	tools: readonly InbandTool[] = [],
): Context["messages"] {
	const definition = getDialectDefinition(dialect);
	const out: Message[] = [];
	for (let i = 0; i < messages.length; i++) {
		const message = messages[i]!;
		if (message.role === "assistant") {
			out.push(encodeAssistantMessage(message, definition, tools));
			continue;
		}
		if (message.role === "toolResult") {
			const run: ToolResultMessage[] = [];
			let j = i;
			while (j < messages.length && messages[j]!.role === "toolResult") {
				run.push(messages[j] as ToolResultMessage);
				j++;
			}
			out.push(encodeToolResults(run, definition));
			i = j - 1;
			continue;
		}
		out.push(message);
	}
	return out;
}

function encodeAssistantMessage(
	message: AssistantMessage,
	definition: DialectDefinition,
	tools: readonly InbandTool[],
): AssistantMessage {
	const toolCalls = message.content.filter((block): block is ToolCall => block.type === "toolCall");
	if (toolCalls.length === 0) return message;
	const prose = message.content
		.filter((block): block is TextContent => block.type === "text")
		.map(block => block.text)
		.join("\n");
	const rendered = definition.renderAssistantToolCalls(toolCalls, { tools });
	const text = prose.trim().length > 0 ? `${prose.trimEnd()}\n${rendered}` : rendered;
	return { ...message, content: [{ type: "text", text }] };
}

function encodeToolResults(results: readonly ToolResultMessage[], definition: DialectDefinition): Message {
	const dialectResults: DialectToolResult[] = [];
	const images: ImageContent[] = [];
	for (let index = 0; index < results.length; index++) {
		const result = results[index]!;
		let text = "";
		for (const block of result.content) {
			if (block.type === "text") text += block.text;
			else if (block.type === "image") images.push(block);
		}
		dialectResults.push({
			id: result.toolCallId,
			name: result.toolName,
			index,
			text,
			isError: result.isError,
		});
	}
	const content: (TextContent | ImageContent)[] = [
		{ type: "text", text: definition.renderToolResults(dialectResults) },
		...images,
	];
	return { role: "user", content, timestamp: results[0]?.timestamp ?? Date.now() };
}
