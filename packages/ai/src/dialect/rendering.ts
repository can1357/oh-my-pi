import { stringifyJson as stringifyJsonValue } from "@oh-my-pi/pi-utils";
import type { AssistantMessage, Message, ToolCall, ToolResultMessage } from "../types";
import type { DialectRenderOptions, DialectToolResult } from "./types";

export function renderToolResponseResults(results: readonly DialectToolResult[]): string {
	return results.map(result => `<tool_response>\n${result.text}\n</tool_response>`).join("\n");
}

export function kimiCallId(name: string, id: string, index: number): string {
	const trimmed = id.trim();
	return trimmed.startsWith("functions.") ? trimmed : `functions.${name}:${index}`;
}

export function harmonyRecipient(name: string): string {
	return name.startsWith("functions.") ? name : `functions.${name}`;
}

export function stringifyJson(value: unknown): string {
	return stringifyJsonValue(value) ?? "null";
}

/**
 * Render `name(key=value, …)` with Python-literal argument values. Top-level
 * multiline strings render as verbatim `"""…"""` blocks so payload-carrying
 * args (file content, scripts, patches) keep real newlines instead of `\n`
 * escape soup; nested values always use escaped single-line literals.
 */
export function pyCall(name: string, args: Record<string, unknown>): string {
	let kwargs = "";
	for (const key in args) {
		kwargs += `${kwargs ? ", " : ""}${key}=${pyArgValue(args[key])}`;
	}
	return `${name}(${kwargs})`;
}

function pyArgValue(value: unknown): string {
	if (typeof value === "string" && value.includes("\n")) {
		// Verbatim `"""` fencing is only unambiguous when the content cannot
		// collide with the fence: no `"""` inside, no quote butting against a
		// fence edge, no trailing backslash swallowing the closer.
		const fenceSafe =
			!value.includes('"""') && !value.startsWith('"') && !value.endsWith('"') && !value.endsWith("\\");
		if (fenceSafe) return `"""${value}"""`;
	}
	return pyValue(value);
}

/** Render a JSON-ish value as a Python literal (`True`/`False`/`None`, escaped strings, lists, dicts). */
export function pyValue(value: unknown): string {
	if (value === null || value === undefined) return "None";
	if (typeof value === "boolean") return value ? "True" : "False";
	if (typeof value === "number") return Number.isFinite(value) ? String(value) : pyString(String(value));
	if (typeof value === "string") return pyString(value);
	if (Array.isArray(value)) return `[${value.map(pyValue).join(", ")}]`;
	if (typeof value === "object") {
		const record = value as Record<string, unknown>;
		let entries = "";
		for (const key in record) {
			entries += `${entries ? ", " : ""}${pyString(key)}: ${pyValue(record[key])}`;
		}
		return `{${entries}}`;
	}
	return pyString(String(value));
}

function pyString(value: string): string {
	const escaped = value
		.replaceAll("\\", "\\\\")
		.replaceAll('"', '\\"')
		.replaceAll("\n", "\\n")
		.replaceAll("\r", "\\r")
		.replaceAll("\t", "\\t");
	return `"${escaped}"`;
}

export function escapeXmlAttr(value: string): string {
	return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

export function escapeXmlText(value: string): string {
	return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

export type AssistantTranscriptParts = {
	readonly text: string;
	readonly thinking: string;
	readonly toolCalls: readonly ToolCall[];
};

export type ToolCallRenderer = (calls: readonly ToolCall[], options?: DialectRenderOptions) => string;
export type ToolResultRenderer = (results: readonly DialectToolResult[], options?: DialectRenderOptions) => string;

export type ChatMlTranscriptConfig = {
	readonly bos?: string;
	readonly toolResultRole: "tool" | "user";
	readonly renderThinking: (text: string) => string;
	readonly renderCalls: ToolCallRenderer;
	readonly renderResultsBody: ToolResultRenderer;
};

export type LegacyTextTranscriptConfig = {
	readonly renderThinking: (text: string) => string;
	readonly renderCalls: ToolCallRenderer;
	readonly renderResults: ToolResultRenderer;
};

export function renderChatMlTranscript(
	messages: readonly Message[],
	options: DialectRenderOptions,
	config: ChatMlTranscriptConfig,
): string {
	if (messages.length === 0) return "";
	let out = config.bos ?? "";
	for (let i = 0; i < messages.length;) {
		const message = messages[i]!;
		if (message.role === "assistant") {
			const parts = assistantTranscriptParts(message);
			out += chatMlTurn(
				"assistant",
				`${config.renderThinking(parts.thinking)}${parts.text}${config.renderCalls(parts.toolCalls, options)}`,
			);
			i++;
			continue;
		}
		if (message.role === "toolResult") {
			const run = collectToolResultRun(messages, i);
			out += chatMlTurn(config.toolResultRole, config.renderResultsBody(run.results, options));
			i = run.next;
			continue;
		}
		const role = message.role === "developer" ? "system" : message.role;
		out += chatMlTurn(role, messageContentText(message.content));
		i++;
	}
	return out;
}

export function renderLegacyTextTranscript(
	messages: readonly Message[],
	options: DialectRenderOptions,
	config: LegacyTextTranscriptConfig,
): string {
	let out = "";
	for (let i = 0; i < messages.length;) {
		const message = messages[i]!;
		if (message.role === "assistant") {
			const parts = assistantTranscriptParts(message);
			out = appendLegacySegment(
				out,
				`Assistant: ${config.renderThinking(parts.thinking)}${parts.text}${config.renderCalls(parts.toolCalls, options)}`,
			);
			i++;
			continue;
		}
		if (message.role === "toolResult") {
			const run = collectToolResultRun(messages, i);
			out = appendLegacySegment(out, `Human: ${config.renderResults(run.results, options)}`);
			i = run.next;
			continue;
		}
		const text = messageContentText(message.content);
		out = message.role === "developer" ? appendLegacyPlain(out, text) : appendLegacySegment(out, `Human: ${text}`);
		i++;
	}
	return out;
}

export function assistantTranscriptParts(message: AssistantMessage): AssistantTranscriptParts {
	let text = "";
	const thinking: string[] = [];
	const toolCalls: ToolCall[] = [];
	for (const block of message.content) {
		if (block.type === "text") text += block.text;
		else if (block.type === "thinking") thinking.push(block.thinking);
		else if (block.type === "toolCall") toolCalls.push(block);
	}
	return { text, thinking: thinking.join("\n"), toolCalls };
}

export function collectToolResultRun(
	messages: readonly Message[],
	start: number,
): { readonly results: readonly DialectToolResult[]; readonly next: number } {
	const results: DialectToolResult[] = [];
	let next = start;
	while (next < messages.length && messages[next]!.role === "toolResult") {
		results.push(toolResultToDialectResult(messages[next] as ToolResultMessage, results.length));
		next++;
	}
	return { results, next };
}

function toolResultToDialectResult(message: ToolResultMessage, index: number): DialectToolResult {
	return {
		id: message.toolCallId,
		name: message.toolName,
		index,
		text: messageContentText(message.content),
		isError: message.isError,
	};
}

export function messageContentText(
	content: string | readonly { readonly type: string; readonly text?: string; readonly mimeType?: string }[],
): string {
	if (typeof content === "string") return content;
	let text = "";
	for (const block of content) {
		if (block.type === "text" && block.text !== undefined) text += block.text;
		else if (block.type === "image") text += block.mimeType ? `[Image: ${block.mimeType}]` : "[Image]";
	}
	return text;
}

function isAsciiWhitespace(code: number): boolean {
	return code === 9 || code === 10 || code === 11 || code === 12 || code === 13 || code === 32;
}

function trimAsciiStart(text: string, start: number, end: number): number {
	let cursor = start;
	while (cursor < end && isAsciiWhitespace(text.charCodeAt(cursor))) cursor++;
	return cursor;
}

function trimAsciiEnd(text: string, start: number, end: number): number {
	let cursor = end;
	while (cursor > start && isAsciiWhitespace(text.charCodeAt(cursor - 1))) cursor--;
	return cursor;
}

function findDelimitedThinkingClose(open: string, close: string, text: string, start: number, end: number): number {
	let depth = 1;
	let cursor = start;
	while (cursor < end) {
		const nextClose = text.indexOf(close, cursor);
		if (nextClose < 0 || nextClose >= end) return -1;
		const nextOpen = text.indexOf(open, cursor);
		if (nextOpen >= 0 && nextOpen < nextClose) {
			depth++;
			cursor = nextOpen + open.length;
			continue;
		}
		depth--;
		if (depth === 0) return nextClose;
		cursor = nextClose + close.length;
	}
	return -1;
}

function unwrapDelimitedThinking(open: string, close: string, text: string): string {
	const end = trimAsciiEnd(text, 0, text.length);
	let cursor = trimAsciiStart(text, 0, end);
	if (cursor >= end || !text.startsWith(open, cursor)) return text;

	const segments: string[] = [];
	while (cursor < end) {
		if (!text.startsWith(open, cursor)) return text;
		const innerStart = cursor + open.length;
		const innerEnd = findDelimitedThinkingClose(open, close, text, innerStart, end);
		if (innerEnd < 0) return text;

		const trimmedInnerEnd = trimAsciiEnd(text, innerStart, innerEnd);
		const trimmedInnerStart = trimAsciiStart(text, innerStart, trimmedInnerEnd);
		segments.push(unwrapDelimitedThinking(open, close, text.slice(trimmedInnerStart, trimmedInnerEnd)));
		cursor = trimAsciiStart(text, innerEnd + close.length, end);
	}
	return segments.join("\n");
}

export function renderDelimitedThinking(open: string, close: string, text: string): string {
	if (!text) return "";
	return `${open}\n${unwrapDelimitedThinking(open, close, text)}\n${close}`;
}

export function chatMlTurn(role: "assistant" | "system" | "tool" | "user", body: string): string {
	return `<|im_start|>${role}\n${body}<|im_end|>\n`;
}

export function kimiTurn(role: "assistant" | "system" | "user", name: string, body: string): string {
	return `<|im_${role}|>${name}<|im_middle|>${body}<|im_end|>`;
}

export function gemmaTurn(role: "model" | "system" | "user", body: string): string {
	return `<|turn>${role}\n${body}<turn|>`;
}

export function geminiTurn(role: "model" | "user", body: string): string {
	return `<start_of_turn>${role}\n${body}<end_of_turn>\n`;
}

export function joinUserBodies(left: string, right: string): string {
	if (!left) return right;
	if (!right) return left;
	return `${left}\n${right}`;
}

function appendLegacyPlain(out: string, text: string): string {
	if (!text) return out;
	return out ? `${out}\n\n${text}` : text;
}

function appendLegacySegment(out: string, segment: string): string {
	return `${out}\n\n${segment}`;
}
