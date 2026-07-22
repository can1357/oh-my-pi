import type {
	AssistantMessage,
	Message,
	TextContent,
	ToolCall,
	ToolResultMessage,
	UserMessage,
} from "@pk-nerdsaver-ai/pi-ai";
import type { UsageTotals } from "./types";

export function userMessage(content: string): UserMessage {
	return { role: "user", content, timestamp: Date.now() };
}

export function toolResultMessage(toolCall: ToolCall, text: string, isError = false): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: toolCall.id,
		toolName: toolCall.name,
		content: [{ type: "text", text }],
		isError,
		timestamp: Date.now(),
	};
}

/** Extract the concatenated text of a message's text content blocks. */
export function messageText(message: Message): string {
	if (message.role === "toolResult") {
		return message.content
			.filter((block): block is TextContent => block.type === "text")
			.map(block => block.text)
			.join("\n");
	}
	if (typeof message.content === "string") return message.content;
	return message.content
		.filter((block): block is TextContent => block.type === "text")
		.map(block => block.text)
		.join("\n");
}

/** Tool calls contained in an assistant message. */
export function toolCallsOf(message: AssistantMessage): ToolCall[] {
	return message.content.filter((block): block is ToolCall => block.type === "toolCall");
}

/** Render a conversation the way LangChain's get_buffer_string() does ("Human: …\n\nAI: …"). */
export function getBufferString(messages: Message[]): string {
	const roleLabels: Record<Message["role"], string> = {
		user: "Human",
		developer: "System",
		assistant: "AI",
		toolResult: "Tool",
	};
	return messages.map(message => `${roleLabels[message.role]}: ${messageText(message)}`).join("\n\n");
}

/** Contents of every tool-result message — the supervisor's "notes". */
export function getNotesFromToolCalls(messages: Message[]): string[] {
	return messages.filter((message): message is ToolResultMessage => message.role === "toolResult").map(messageText);
}

/** Drop everything from the last assistant message onward (context-overflow shrink). */
export function removeUpToLastAssistantMessage(messages: Message[]): Message[] {
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i].role === "assistant") return messages.slice(0, i);
	}
	return messages;
}

/** Raw notes: concatenated text of tool-result and assistant messages. */
export function rawNotesOf(messages: Message[]): string {
	return messages
		.filter(message => message.role === "toolResult" || message.role === "assistant")
		.map(messageText)
		.join("\n");
}

export function accumulateUsage(totals: UsageTotals, message: AssistantMessage): void {
	totals.input += message.usage.input;
	totals.output += message.usage.output;
	totals.cacheRead += message.usage.cacheRead;
	totals.cacheWrite += message.usage.cacheWrite;
	totals.totalTokens += message.usage.totalTokens;
	totals.cost += message.usage.cost.total;
}
