import type { Message, ToolCall } from "../types";
import { invalidToolCallArguments } from "../utils/tool-call-arguments";
import { buildArgShapes, coerceValue, mintToolCallId, partialSuffixOverlapAny } from "./coercion";
import dialectPrompt from "./minicpm5.md" with { type: "text" };
import {
	escapeXmlAttr,
	escapeXmlText,
	renderDelimitedThinking,
	renderLegacyTextTranscript,
	renderToolResponseResults,
	stringifyJson,
} from "./rendering";
import type {
	DialectDefinition,
	DialectRenderOptions,
	DialectToolResult,
	InbandScanEvent,
	InbandScanner,
	InbandScannerOptions,
} from "./types";

const FUNCTION_OPEN = "<function";
const FUNCTION_CLOSE = "</function>";
const PARAM_CLOSE = "</param>";
const CDATA_OPEN = "<![CDATA[";
const CDATA_CLOSE = "]]>";
const THINK_OPEN = "<think>";
const THINK_CLOSE = "</think>";
const TOKENIZER_SPACE = "\u0120";

const FUNCTION_OPEN_RE = /^<function\s+name=(["'])([^"']+)\1[^>]*>$/;
const PARAM_OPEN_RE = /^<param\s+name=(["'])([^"']+)\1[^>]*>$/;
const TOOL_START_TAGS = [FUNCTION_OPEN] as const;
const START_TAGS = [FUNCTION_OPEN, THINK_OPEN] as const;
const THINK_CLOSE_TAGS = [THINK_CLOSE] as const;

type State = "outside" | "thinking" | "tool";

interface ToolMetadata {
	readonly properties: Record<string, unknown>;
}

function normalizeTagHeader(text: string): string {
	return text
		.replaceAll(TOKENIZER_SPACE, " ")
		.replaceAll("<functionname=", "<function name=")
		.replaceAll("<paramname=", "<param name=");
}

function decodeXmlEntities(value: string): string {
	return value.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/g, (match, entity: string) => {
		switch (entity) {
			case "amp":
				return "&";
			case "lt":
				return "<";
			case "gt":
				return ">";
			case "quot":
				return '"';
			case "apos":
				return "'";
			default: {
				const radix = entity.startsWith("#x") ? 16 : 10;
				const digits = entity.slice(radix === 16 ? 2 : 1);
				const codePoint = Number.parseInt(digits, radix);
				if (!Number.isFinite(codePoint)) return match;
				try {
					return String.fromCodePoint(codePoint);
				} catch {
					return match;
				}
			}
		}
	});
}

export class MiniCPM5InbandScanner implements InbandScanner {
	#buffer = "";
	#state: State = "outside";
	#id = "";
	#name = "";
	#openTag = "";
	#started = false;
	#thinking = "";
	readonly #parseThinking: boolean;
	readonly #tools = new Map<string, ToolMetadata>();

	constructor(options: InbandScannerOptions = {}) {
		this.#parseThinking = options.parseThinking !== false;
		const shapes = buildArgShapes(options.tools);
		for (const tool of options.tools ?? []) {
			this.#tools.set(tool.name, {
				properties: shapes.get(tool.name)?.properties ?? {},
			});
		}
	}

	feed(text: string): InbandScanEvent[] {
		if (text.length === 0) return [];
		this.#buffer += text;
		return this.#consume(false);
	}

	flush(): InbandScanEvent[] {
		return this.#consume(true);
	}

	#consume(final: boolean): InbandScanEvent[] {
		const events: InbandScanEvent[] = [];
		while (this.#buffer.length > 0) {
			if (this.#state === "outside") {
				this.#consumeOutside(final, events);
				if (this.#state === "outside") break;
				continue;
			}

			if (this.#state === "thinking") {
				this.#consumeThinking(final, events);
				if (this.#state === "thinking") break;
				continue;
			}

			this.#consumeTool(final, events);
			if (this.#state === "tool") break;
		}
		if (final && this.#state === "thinking") this.#endThinking(events);
		return events;
	}

	#consumeOutside(final: boolean, events: InbandScanEvent[]): void {
		const tool = this.#buffer.indexOf(FUNCTION_OPEN);
		const think = this.#parseThinking ? this.#buffer.indexOf(THINK_OPEN) : -1;
		let start = tool;
		let isThink = false;
		if (think !== -1 && (start === -1 || think < start)) {
			start = think;
			isThink = true;
		}

		if (start === -1) {
			const tags = this.#parseThinking ? START_TAGS : TOOL_START_TAGS;
			const hold = final ? 0 : partialSuffixOverlapAny(this.#buffer, tags);
			const emit = this.#buffer.slice(0, this.#buffer.length - hold);
			if (emit.length > 0) events.push({ type: "text", text: emit });
			this.#buffer = this.#buffer.slice(this.#buffer.length - hold);
			return;
		}

		if (start > 0) events.push({ type: "text", text: this.#buffer.slice(0, start) });
		this.#buffer = this.#buffer.slice(start);
		if (isThink) {
			this.#buffer = this.#buffer.slice(THINK_OPEN.length);
			this.#state = "thinking";
			this.#thinking = "";
			events.push({ type: "thinkingStart" });
			return;
		}

		this.#state = "tool";
		this.#id = mintToolCallId();
		this.#name = "";
		this.#openTag = "";
		this.#started = false;
	}

	#consumeThinking(final: boolean, events: InbandScanEvent[]): void {
		const close = this.#buffer.indexOf(THINK_CLOSE);
		if (close === -1) {
			const hold = final ? 0 : partialSuffixOverlapAny(this.#buffer, THINK_CLOSE_TAGS);
			const delta = this.#buffer.slice(0, this.#buffer.length - hold);
			this.#emitThinkingDelta(delta, events);
			this.#buffer = this.#buffer.slice(this.#buffer.length - hold);
			if (final) this.#endThinking(events);
			return;
		}

		this.#emitThinkingDelta(this.#buffer.slice(0, close), events);
		this.#buffer = this.#buffer.slice(close + THINK_CLOSE.length);
		this.#endThinking(events);
	}

	#consumeTool(final: boolean, events: InbandScanEvent[]): void {
		if (!this.#started) {
			const openEnd = this.#buffer.indexOf(">");
			if (openEnd === -1) {
				if (final) {
					events.push({ type: "text", text: this.#buffer });
					this.#buffer = "";
					this.#resetTool();
				}
				return;
			}

			const openTag = normalizeTagHeader(this.#buffer.slice(0, openEnd + 1));
			const match = FUNCTION_OPEN_RE.exec(openTag);
			const name = match?.[2]?.trim() ?? "";
			if (!name || (this.#tools.size > 0 && !this.#tools.has(name))) {
				events.push({ type: "text", text: openTag });
				this.#buffer = this.#buffer.slice(openEnd + 1);
				this.#resetTool();
				return;
			}

			this.#name = name;
			this.#openTag = openTag;
			this.#started = true;
			this.#buffer = this.#buffer.slice(openEnd + 1);
			events.push({ type: "toolStart", id: this.#id, name: this.#name });
		}

		const close = this.#buffer.indexOf(FUNCTION_CLOSE);
		if (close === -1) {
			if (final) {
				this.#buffer = "";
				this.#resetTool();
			}
			return;
		}

		const body = this.#buffer.slice(0, close);
		const rawBlock = `${this.#openTag}${body}${FUNCTION_CLOSE}`;
		const parsed = this.#parseArguments(body);
		const argumentsValue = parsed instanceof Error ? invalidToolCallArguments(rawBlock, parsed) : parsed;
		events.push({
			type: "toolEnd",
			id: this.#id,
			name: this.#name,
			arguments: argumentsValue,
			rawBlock,
		});
		this.#buffer = this.#buffer.slice(close + FUNCTION_CLOSE.length);
		this.#resetTool();
	}

	#parseArguments(body: string): Record<string, unknown> | Error {
		const metadata = this.#tools.get(this.#name);
		const argumentsValue: Record<string, unknown> = {};
		const seen = new Set<string>();
		let cursor = 0;

		while (true) {
			const paramStart = body.indexOf("<param", cursor);
			if (paramStart === -1) break;
			const openEnd = body.indexOf(">", paramStart + "<param".length);
			if (openEnd === -1) return new Error("Unterminated MiniCPM5 <param> tag");

			const openTag = normalizeTagHeader(body.slice(paramStart, openEnd + 1));
			const match = PARAM_OPEN_RE.exec(openTag);
			const key = match?.[2]?.trim() ?? "";
			if (!key) return new Error("MiniCPM5 <param> is missing a valid name");
			if (seen.has(key)) return new Error(`Duplicate MiniCPM5 parameter: ${key}`);
			seen.add(key);

			const valueStart = openEnd + 1;
			let closeStart: number;
			let rawValue: string;
			if (body.startsWith(CDATA_OPEN, valueStart)) {
				const cdataEnd = body.indexOf(CDATA_CLOSE, valueStart + CDATA_OPEN.length);
				if (cdataEnd === -1) return new Error(`Unterminated CDATA for MiniCPM5 parameter: ${key}`);
				const afterCdata = cdataEnd + CDATA_CLOSE.length;
				closeStart = body.indexOf(PARAM_CLOSE, afterCdata);
				if (closeStart === -1 || body.slice(afterCdata, closeStart).trim().length > 0) {
					return new Error(`Invalid CDATA framing for MiniCPM5 parameter: ${key}`);
				}
				rawValue = body.slice(valueStart + CDATA_OPEN.length, cdataEnd);
			} else {
				closeStart = body.indexOf(PARAM_CLOSE, valueStart);
				if (closeStart === -1) return new Error(`Unterminated MiniCPM5 parameter: ${key}`);
				rawValue = decodeXmlEntities(body.slice(valueStart, closeStart));
			}

			argumentsValue[key] = coerceValue(rawValue, metadata?.properties[key]);
			cursor = closeStart + PARAM_CLOSE.length;
		}

		return argumentsValue;
	}

	#emitThinkingDelta(delta: string, events: InbandScanEvent[]): void {
		if (delta.length === 0) return;
		this.#thinking += delta;
		events.push({ type: "thinkingDelta", delta });
	}

	#endThinking(events: InbandScanEvent[]): void {
		events.push({ type: "thinkingEnd", thinking: this.#thinking });
		this.#thinking = "";
		this.#state = "outside";
	}

	#resetTool(): void {
		this.#state = "outside";
		this.#id = "";
		this.#name = "";
		this.#openTag = "";
		this.#started = false;
	}
}

function renderParamValue(value: unknown, isString: boolean): string {
	const raw = isString && typeof value === "string" ? value : stringifyJson(value);
	if (raw.includes("]]>")) return escapeXmlText(raw);
	if (raw.includes("<") || raw.includes("&") || raw.includes("\n") || raw.includes("\r")) {
		return `${CDATA_OPEN}${raw}${CDATA_CLOSE}`;
	}
	return escapeXmlText(raw);
}

function renderToolCall(call: ToolCall, options: DialectRenderOptions = {}): string {
	const shape = buildArgShapes(options.tools).get(call.name);
	let body = `<function name="${escapeXmlAttr(call.name)}">`;
	for (const key in call.arguments) {
		const value = call.arguments[key];
		const isString = shape?.stringArgs.has(key) ?? typeof value === "string";
		body += `<param name="${escapeXmlAttr(key)}">${renderParamValue(value, isString)}</param>`;
	}
	return `${body}</function>`;
}

function renderAssistantToolCalls(calls: readonly ToolCall[], options: DialectRenderOptions = {}): string {
	return calls.map(call => renderToolCall(call, options)).join("\n");
}

function renderToolResults(results: readonly DialectToolResult[]): string {
	return renderToolResponseResults(results);
}

function renderThinking(text: string): string {
	return renderDelimitedThinking(THINK_OPEN, THINK_CLOSE, text);
}

function renderTranscript(messages: readonly Message[], options: DialectRenderOptions = {}): string {
	return renderLegacyTextTranscript(messages, options, {
		renderThinking,
		renderCalls: renderAssistantToolCalls,
		renderResults: renderToolResults,
	});
}

const definition: DialectDefinition = {
	dialect: "minicpm5",
	prompt: dialectPrompt,
	createScanner: options => new MiniCPM5InbandScanner(options),
	renderToolCall,
	renderAssistantToolCalls,
	renderToolResults,
	renderThinking,
	renderTranscript,
};

export default definition;
