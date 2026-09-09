import type { Message, ToolCall } from "../types";
import {
	ANTHROPIC_THINKING_TAG_PREFIXES,
	AnthropicInbandScanner,
	type AnthropicInbandScannerConfig,
} from "./anthropic";
import { buildArgShapes, type ToolArgShape } from "./coercion";
import dialectPrompt from "./minimax.md" with { type: "text" };
import {
	escapeXmlAttr,
	escapeXmlText,
	renderDelimitedThinking,
	renderLegacyTextTranscript,
	stringifyJson,
} from "./rendering";
import type { DialectDefinition, DialectRenderOptions, DialectToolResult } from "./types";

const MINIMAX_WRAPPER_TAGS: Readonly<Record<string, true>> = { tool_call: true };
const MINIMAX_BASE_TAG_PREFIXES = [
	"<minimax:tool_call",
	"</minimax:tool_call",
	"<tool_call",
	"</tool_call",
	"<invoke",
	"</invoke",
	"<parameter",
	"</parameter",
] as const;
const MINIMAX_ALL_TAG_PREFIXES = [...MINIMAX_BASE_TAG_PREFIXES, ...ANTHROPIC_THINKING_TAG_PREFIXES] as const;
const MINIMAX_SCANNER_CONFIG: AnthropicInbandScannerConfig = {
	wrapperTags: MINIMAX_WRAPPER_TAGS,
	baseTagPrefixes: MINIMAX_BASE_TAG_PREFIXES,
	allTagPrefixes: MINIMAX_ALL_TAG_PREFIXES,
};

function renderToolCall(call: ToolCall, options: DialectRenderOptions = {}): string {
	return renderInvoke(call, buildArgShapes(options.tools).get(call.name));
}

function renderAssistantToolCalls(calls: readonly ToolCall[], options: DialectRenderOptions = {}): string {
	if (calls.length === 0) return "";
	return `<minimax:tool_call>\n${renderInvokes(calls, options.tools ?? [])}\n</minimax:tool_call>`;
}

function renderToolResults(results: readonly DialectToolResult[]): string {
	const body = results
		.map(result => {
			const tag = result.isError ? "error" : "result";
			const streamTag = result.isError ? "stderr" : "stdout";
			return `<${tag}>\n<tool_name>${escapeXmlText(result.name)}</tool_name>\n<${streamTag}>${result.text}</${streamTag}>\n</${tag}>`;
		})
		.join("\n");
	return `<function_results>\n${body}\n</function_results>`;
}

function renderThinking(text: string): string {
	return renderDelimitedThinking("<thinking>", "</thinking>", text);
}

function renderTranscript(messages: readonly Message[], options: DialectRenderOptions = {}): string {
	return renderLegacyTextTranscript(messages, options, {
		renderThinking,
		renderCalls: renderAssistantToolCalls,
		renderResults: renderToolResults,
	});
}

function renderInvoke(call: ToolCall, shape: ToolArgShape | undefined): string {
	let body = `<invoke name="${escapeXmlAttr(call.name)}">`;
	for (const key in call.arguments) {
		const value = call.arguments[key];
		const isString = shape?.stringArgs.has(key) === true;
		const rendered = isString && typeof value === "string" ? value : stringifyJson(value);
		body += `<parameter name="${escapeXmlAttr(key)}">${rendered}</parameter>`;
	}
	return `${body}</invoke>`;
}

function renderInvokes(calls: readonly ToolCall[], tools: NonNullable<DialectRenderOptions["tools"]>): string {
	const shapes = buildArgShapes(tools);
	return calls.map(call => renderInvoke(call, shapes.get(call.name))).join("\n");
}

const definition: DialectDefinition = {
	dialect: "minimax",
	prompt: dialectPrompt,
	createScanner: options => new AnthropicInbandScanner(options, MINIMAX_SCANNER_CONFIG),
	renderToolCall,
	renderAssistantToolCalls,
	renderToolResults,
	renderThinking,
	renderTranscript,
};

export default definition;
