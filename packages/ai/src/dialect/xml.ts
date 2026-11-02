import type { Message, ToolCall } from "../types";
import { AnthropicInbandScanner } from "./anthropic";
import { buildArgShapes } from "./coercion";
import { DeepSeekInbandScanner } from "./deepseek";
import {
	renderDelimitedThinking,
	renderInvoke,
	renderInvokes,
	renderLegacyTextTranscript,
	renderToolResponseResults,
} from "./rendering";
import type {
	DialectDefinition,
	DialectRenderOptions,
	DialectToolResult,
	InbandScanEvent,
	InbandScanner,
	InbandScannerOptions,
} from "./types";
import dialectPrompt from "./xml.md" with { type: "text" };

export class XmlInbandScanner implements InbandScanner {
	readonly #inner: InbandScanner;

	constructor(options: InbandScannerOptions = {}) {
		this.#inner =
			options.xmlTagset === "dsml" ? new DeepSeekInbandScanner(options) : new AnthropicInbandScanner(options);
	}

	feed(text: string): InbandScanEvent[] {
		return this.#inner.feed(text);
	}

	flush(): InbandScanEvent[] {
		return this.#inner.flush();
	}
}

function renderToolCall(call: ToolCall, options: DialectRenderOptions = {}): string {
	return renderInvoke(call, buildArgShapes(options.tools).get(call.name));
}

function renderAssistantToolCalls(calls: readonly ToolCall[], options: DialectRenderOptions = {}): string {
	return renderInvokes(calls, options.tools ?? []);
}

function renderToolResults(results: readonly DialectToolResult[]): string {
	return renderToolResponseResults(results);
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

const definition: DialectDefinition = {
	dialect: "xml",
	prompt: dialectPrompt,
	createScanner: options => new XmlInbandScanner(options),
	renderToolCall,
	renderAssistantToolCalls,
	renderToolResults,
	renderThinking,
	renderTranscript,
};

export default definition;
