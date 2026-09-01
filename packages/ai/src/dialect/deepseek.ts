import { parseJsonWithRepair } from "@oh-my-pi/pi-utils";
import type { Message, ToolCall } from "../types";
import { asRecord, mintToolCallId, partialSuffixOverlapAny } from "./coercion";
import dialectPrompt from "./deepseek.md" with { type: "text" };
import { assistantTranscriptParts, collectToolResultRun, messageContentText, stringifyJson } from "./rendering";
import type {
	DialectDefinition,
	DialectRenderOptions,
	DialectToolResult,
	InbandScanEvent,
	InbandScanner,
	InbandScannerOptions,
} from "./types";

export const DEEPSEEK_TOOL_CALLS_BEGIN = "<｜tool▁calls▁begin｜>";
export const DEEPSEEK_TOOL_CALLS_END = "<｜tool▁calls▁end｜>";
export const DEEPSEEK_TOOL_CALL_BEGIN = "<｜tool▁call▁begin｜>";
export const DEEPSEEK_TOOL_CALL_END = "<｜tool▁call▁end｜>";
export const DEEPSEEK_TOOL_SEPARATOR = "<｜tool▁sep｜>";
const DEEPSEEK_TOOL_OUTPUT_BEGIN = "<｜tool▁output▁begin｜>";
const DEEPSEEK_TOOL_OUTPUT_END = "<｜tool▁output▁end｜>";
const DEEPSEEK_BOS = "<｜begin▁of▁sentence｜>";
const DEEPSEEK_USER = "<｜User｜>";
const DEEPSEEK_ASSISTANT = "<｜Assistant｜>";
const DEEPSEEK_EOS = "<｜end▁of▁sentence｜>";

const THINK_OPEN = "<think>";
const THINK_CLOSE = "</think>";
const LEGACY_TOOL_TYPE = "function";
const LEGACY_JSON_FENCE = "```json";
const CODE_FENCE = "```";

const DSML_TOOL_CALLS_OPEN_FULLWIDTH = "<｜DSML｜tool_calls>";
const DSML_TOOL_CALLS_CLOSE_FULLWIDTH = "</｜DSML｜tool_calls>";
const DSML_TOOL_CALLS_OPEN_ASCII = "<|DSML|tool_calls>";
const DSML_TOOL_CALLS_CLOSE_ASCII = "</|DSML|tool_calls>";

const CONTROL_TOKENS = [
	DEEPSEEK_BOS,
	DEEPSEEK_EOS,
	"<｜▁pad▁｜>",
	DEEPSEEK_USER,
	DEEPSEEK_ASSISTANT,
	"<|EOT|>",
	"<｜search▁begin｜>",
	"<｜search▁end｜>",
	"<｜fim▁hole｜>",
	"<｜fim▁begin｜>",
	"<｜fim▁end｜>",
	"<｜tool▁outputs▁begin｜>",
	"<｜tool▁outputs▁end｜>",
	DEEPSEEK_TOOL_OUTPUT_BEGIN,
	DEEPSEEK_TOOL_OUTPUT_END,
] as const;

const OUTSIDE_TOKENS = [
	DEEPSEEK_TOOL_CALLS_BEGIN,
	DEEPSEEK_TOOL_CALLS_END,
	DEEPSEEK_TOOL_CALL_BEGIN,
	THINK_OPEN,
	THINK_CLOSE,
	DSML_TOOL_CALLS_OPEN_FULLWIDTH,
	DSML_TOOL_CALLS_OPEN_ASCII,
	DSML_TOOL_CALLS_CLOSE_FULLWIDTH,
	DSML_TOOL_CALLS_CLOSE_ASCII,
	...CONTROL_TOKENS,
] as const;

const SECTION_TOKENS = [DEEPSEEK_TOOL_CALL_BEGIN, DEEPSEEK_TOOL_CALLS_END] as const;
const DSML_SECTION_TOKENS = [
	DSML_TOOL_CALLS_CLOSE_FULLWIDTH,
	DSML_TOOL_CALLS_CLOSE_ASCII,
	"<｜DSML｜invoke",
	"<|DSML|invoke",
] as const;
const DSML_INVOKE_TOKENS = ["</｜DSML｜invoke>", "</|DSML|invoke>", "<｜DSML｜parameter", "<|DSML|parameter"] as const;
const DSML_PARAMETER_CLOSE_TOKENS = ["</｜DSML｜parameter>", "</|DSML|parameter>"] as const;

type State =
	| "outside"
	| "thinking"
	| "section"
	| "header"
	| "args"
	| "legacyName"
	| "legacyArgs"
	| "dsmlSection"
	| "dsmlInvoke"
	| "dsmlParam";

export class DeepSeekInbandScanner implements InbandScanner {
	#buffer = "";
	#state: State = "outside";
	#parseThinking: boolean;
	#inToolSection = false;
	#id = "";
	#name = "";
	#thinking = "";
	#dsmlArgs: Record<string, unknown> = {};
	#dsmlParamName = "";
	#dsmlParamIsString = true;
	#dsmlParamRaw = "";
	#rawBlock = "";
	#stripLeadingWhitespace = false;

	constructor(options: InbandScannerOptions = {}) {
		this.#parseThinking = options.parseThinking ?? true;
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
				if (this.#state !== "outside" && this.#buffer.length > 0) continue;
				break;
			}
			if (this.#state === "thinking") {
				this.#consumeThinking(final, events);
				if (!final && this.#state === "thinking") break;
				continue;
			}
			if (this.#state === "section") {
				if (!this.#consumeSection(final)) break;
				continue;
			}
			if (this.#state === "header") {
				if (!this.#consumeHeader(final, events)) break;
				continue;
			}
			if (this.#state === "legacyName") {
				if (!this.#consumeLegacyName(final, events)) break;
				continue;
			}
			if (this.#state === "args" || this.#state === "legacyArgs") {
				if (!this.#consumeArgs(final, events)) break;
				continue;
			}
			if (this.#state === "dsmlSection") {
				if (!this.#consumeDsmlSection(final, events)) break;
				continue;
			}
			if (this.#state === "dsmlInvoke") {
				if (!this.#consumeDsmlInvoke(final, events)) break;
				continue;
			}
			if (!this.#consumeDsmlParam(final, events)) break;
		}
		if (final && this.#state === "thinking") this.#endThinking(events);
		if (final && this.#buffer.length === 0 && this.#rawBlock.length > 0) this.#rawBlock = "";
		return events;
	}

	#consumeOutside(final: boolean, events: InbandScanEvent[]): void {
		while (this.#buffer.length > 0) {
			if (this.#stripLeadingWhitespace) {
				// A chat-template control token (e.g. `<｜Assistant｜>`) was just dropped;
				// swallow the template whitespace that trails it so it never leaks into
				// visible text. Whitespace can't begin another token, so eager trim is safe.
				const trimmed = this.#buffer.replace(/^\s+/u, "");
				if (trimmed.length === 0) {
					this.#buffer = "";
					return;
				}
				this.#buffer = trimmed;
				this.#stripLeadingWhitespace = false;
			}
			const match = findEarliestToken(this.#buffer, OUTSIDE_TOKENS);
			if (!match) {
				const hold = final ? 0 : partialSuffixOverlapAny(this.#buffer, OUTSIDE_TOKENS);
				const emit = this.#buffer.slice(0, this.#buffer.length - hold);
				if (emit.length > 0) events.push({ type: "text", text: emit });
				this.#buffer = this.#buffer.slice(this.#buffer.length - hold);
				return;
			}
			if (match.index > 0) events.push({ type: "text", text: this.#buffer.slice(0, match.index) });
			this.#buffer = this.#buffer.slice(match.index);
			if (this.#buffer.startsWith(DEEPSEEK_TOOL_CALLS_BEGIN)) {
				this.#buffer = this.#buffer.slice(DEEPSEEK_TOOL_CALLS_BEGIN.length);
				this.#inToolSection = true;
				this.#state = "section";
				return;
			}
			if (this.#buffer.startsWith(DEEPSEEK_TOOL_CALL_BEGIN)) {
				this.#buffer = this.#buffer.slice(DEEPSEEK_TOOL_CALL_BEGIN.length);
				this.#rawBlock = DEEPSEEK_TOOL_CALL_BEGIN;
				this.#inToolSection = false;
				this.#state = "header";
				return;
			}
			if (this.#buffer.startsWith(THINK_OPEN)) {
				this.#buffer = this.#buffer.slice(THINK_OPEN.length);
				this.#state = "thinking";
				this.#thinking = "";
				if (this.#parseThinking) events.push({ type: "thinkingStart" });
				return;
			}
			if (
				this.#buffer.startsWith(DSML_TOOL_CALLS_OPEN_FULLWIDTH) ||
				this.#buffer.startsWith(DSML_TOOL_CALLS_OPEN_ASCII)
			) {
				const openToken = this.#buffer.startsWith(DSML_TOOL_CALLS_OPEN_FULLWIDTH)
					? DSML_TOOL_CALLS_OPEN_FULLWIDTH
					: DSML_TOOL_CALLS_OPEN_ASCII;
				this.#buffer = this.#buffer.slice(openToken.length);
				this.#state = "dsmlSection";
				return;
			}
			const control = this.#matchingControlToken();
			if (control) {
				this.#buffer = this.#buffer.slice(control.length);
				this.#stripLeadingWhitespace = true;
				continue;
			}
			this.#buffer = this.#buffer.slice(match.token.length);
		}
	}

	#consumeThinking(final: boolean, events: InbandScanEvent[]): void {
		const close = this.#buffer.indexOf(THINK_CLOSE);
		if (close === -1) {
			const hold = final ? 0 : partialSuffixOverlapAny(this.#buffer, [THINK_CLOSE]);
			this.#emitThinking(this.#buffer.slice(0, this.#buffer.length - hold), events);
			this.#buffer = this.#buffer.slice(this.#buffer.length - hold);
			if (final) this.#endThinking(events);
			return;
		}
		this.#emitThinking(this.#buffer.slice(0, close), events);
		this.#buffer = this.#buffer.slice(close + THINK_CLOSE.length);
		this.#endThinking(events);
	}

	#consumeSection(final: boolean): boolean {
		while (this.#buffer.length > 0) {
			this.#skipWhitespace();
			if (this.#buffer.startsWith(DEEPSEEK_TOOL_CALLS_END)) {
				this.#buffer = this.#buffer.slice(DEEPSEEK_TOOL_CALLS_END.length);
				this.#inToolSection = false;
				this.#state = "outside";
				return true;
			}
			if (this.#buffer.startsWith(DEEPSEEK_TOOL_CALL_BEGIN)) {
				this.#buffer = this.#buffer.slice(DEEPSEEK_TOOL_CALL_BEGIN.length);
				this.#rawBlock = DEEPSEEK_TOOL_CALL_BEGIN;
				this.#state = "header";
				return true;
			}
			if (!final && partialSuffixOverlapAny(this.#buffer, SECTION_TOKENS) === this.#buffer.length) return false;
			if (this.#buffer.length === 0) return false;
			this.#buffer = this.#buffer.slice(1);
		}
		return final;
	}

	#consumeHeader(final: boolean, events: InbandScanEvent[]): boolean {
		const sep = this.#buffer.indexOf(DEEPSEEK_TOOL_SEPARATOR);
		if (sep === -1) {
			if (final) this.#resetTool();
			return false;
		}
		const rawHead = this.#buffer.slice(0, sep + DEEPSEEK_TOOL_SEPARATOR.length);
		const head = this.#buffer.slice(0, sep).trim();
		this.#rawBlock += rawHead;
		this.#buffer = this.#buffer.slice(rawHead.length);
		if (head === LEGACY_TOOL_TYPE) {
			this.#state = "legacyName";
			return true;
		}
		this.#startTool(head, events);
		this.#state = "args";
		return true;
	}

	#consumeLegacyName(final: boolean, events: InbandScanEvent[]): boolean {
		const fence = this.#buffer.indexOf(LEGACY_JSON_FENCE);
		if (fence === -1) {
			if (final) this.#resetTool();
			return false;
		}
		const rawName = this.#buffer.slice(0, fence + LEGACY_JSON_FENCE.length);
		const name = this.#buffer.slice(0, fence).trim();
		this.#rawBlock += rawName;
		this.#buffer = this.#buffer.slice(rawName.length);
		this.#rawBlock += this.#dropOneLineBreak();
		this.#startTool(name, events);
		this.#state = "legacyArgs";
		return true;
	}

	#consumeArgs(final: boolean, events: InbandScanEvent[]): boolean {
		const end = this.#buffer.indexOf(DEEPSEEK_TOOL_CALL_END);
		if (end === -1) {
			if (final) this.#resetTool();
			return false;
		}
		let rawArgs = this.#buffer.slice(0, end);
		if (this.#state === "legacyArgs") {
			const fence = rawArgs.lastIndexOf(CODE_FENCE);
			if (fence !== -1) rawArgs = rawArgs.slice(0, fence);
		}
		const rawTail = this.#buffer.slice(0, end + DEEPSEEK_TOOL_CALL_END.length);
		this.#rawBlock += rawTail;
		events.push({
			type: "toolEnd",
			id: this.#id,
			name: this.#name,
			arguments: this.#parseArgs(rawArgs),
			rawBlock: this.#rawBlock,
		});
		this.#buffer = this.#buffer.slice(rawTail.length);
		this.#resetTool(this.#inToolSection ? "section" : "outside");
		return true;
	}

	#consumeDsmlSection(final: boolean, events: InbandScanEvent[]): boolean {
		while (this.#buffer.length > 0) {
			this.#skipWhitespace();
			const close = this.#matchingDsmlClose(DSML_TOOL_CALLS_CLOSE_FULLWIDTH, DSML_TOOL_CALLS_CLOSE_ASCII);
			if (close) {
				this.#buffer = this.#buffer.slice(close.length);
				this.#state = "outside";
				return true;
			}
			const invoke = this.#matchDsmlOpen("invoke");
			if (invoke) {
				this.#rawBlock = invoke.raw;
				this.#name = invoke.name;
				this.#id = mintToolCallId();
				this.#dsmlArgs = {};
				events.push({ type: "toolStart", id: this.#id, name: this.#name });
				this.#state = "dsmlInvoke";
				return true;
			}
			if (!final) {
				if (
					(this.#buffer.startsWith("<｜DSML｜invoke") || this.#buffer.startsWith("<|DSML|invoke")) &&
					!this.#buffer.includes(">")
				)
					return false;
				if (partialSuffixOverlapAny(this.#buffer, DSML_SECTION_TOKENS) === this.#buffer.length) return false;
			}
			if (this.#buffer.length === 0) return false;
			this.#buffer = this.#buffer.slice(1);
		}
		return final;
	}

	#consumeDsmlInvoke(final: boolean, events: InbandScanEvent[]): boolean {
		while (this.#buffer.length > 0) {
			const skipped = this.#skipWhitespace();
			if (skipped.length > 0) this.#rawBlock += skipped;
			const close = this.#matchingDsmlClose("</｜DSML｜invoke>", "</|DSML|invoke>");
			if (close) {
				this.#rawBlock += close;
				this.#buffer = this.#buffer.slice(close.length);
				events.push({
					type: "toolEnd",
					id: this.#id,
					name: this.#name,
					arguments: this.#dsmlArgs,
					rawBlock: this.#rawBlock,
				});
				this.#resetDsmlTool();
				this.#state = "dsmlSection";
				return true;
			}
			const param = this.#matchDsmlOpen("parameter");
			if (param) {
				this.#rawBlock += param.raw;
				this.#dsmlParamName = param.name;
				this.#dsmlParamIsString = param.stringAttr !== "false";
				this.#state = "dsmlParam";
				return true;
			}
			if (!final) {
				if (
					(this.#buffer.startsWith("<｜DSML｜parameter") || this.#buffer.startsWith("<|DSML|parameter")) &&
					!this.#buffer.includes(">")
				)
					return false;
				if (partialSuffixOverlapAny(this.#buffer, DSML_INVOKE_TOKENS) === this.#buffer.length) return false;
			}
			const consumed = this.#buffer[0]!;
			this.#rawBlock += consumed;
			this.#buffer = this.#buffer.slice(1);
		}
		return final;
	}

	#consumeDsmlParam(final: boolean, events: InbandScanEvent[]): boolean {
		const close = findEarliestToken(this.#buffer, DSML_PARAMETER_CLOSE_TOKENS);
		if (!close) {
			const hold = final ? 0 : partialSuffixOverlapAny(this.#buffer, DSML_PARAMETER_CLOSE_TOKENS);
			const chunk = this.#buffer.slice(0, this.#buffer.length - hold);
			this.#streamDsmlParam(chunk, events);
			this.#buffer = this.#buffer.slice(this.#buffer.length - hold);
			if (final) this.#resetDsmlTool();
			return false;
		}
		this.#streamDsmlParam(this.#buffer.slice(0, close.index), events);
		this.#dsmlArgs[this.#dsmlParamName] = coerceDsmlValue(this.#dsmlParamRaw, this.#dsmlParamIsString);
		this.#rawBlock += close.token;
		this.#buffer = this.#buffer.slice(close.index + close.token.length);
		this.#dsmlParamName = "";
		this.#dsmlParamIsString = true;
		this.#dsmlParamRaw = "";
		this.#state = "dsmlInvoke";
		return true;
	}

	#startTool(name: string, events: InbandScanEvent[]): void {
		this.#name = name;
		this.#id = mintToolCallId();
		events.push({ type: "toolStart", id: this.#id, name: this.#name });
	}

	#streamDsmlParam(chunk: string, events: InbandScanEvent[]): void {
		if (chunk.length === 0) return;
		this.#dsmlParamRaw += chunk;
		this.#rawBlock += chunk;
		events.push({ type: "toolArgDelta", id: this.#id, name: this.#name, key: this.#dsmlParamName, delta: chunk });
	}

	#emitThinking(delta: string, events: InbandScanEvent[]): void {
		if (delta.length === 0) return;
		if (this.#parseThinking) {
			this.#thinking += delta;
			events.push({ type: "thinkingDelta", delta });
		} else {
			events.push({ type: "text", text: delta });
		}
	}

	#endThinking(events: InbandScanEvent[]): void {
		if (this.#parseThinking) events.push({ type: "thinkingEnd", thinking: this.#thinking });
		this.#thinking = "";
		this.#state = "outside";
	}

	#parseArgs(rawArgs: string): Record<string, unknown> {
		const trimmed = rawArgs.trim();
		if (trimmed.length === 0) return {};
		try {
			return asRecord(parseJsonWithRepair<unknown>(trimmed));
		} catch {
			return {};
		}
	}

	#skipWhitespace(): string {
		let i = 0;
		while (i < this.#buffer.length && /\s/.test(this.#buffer[i]!)) i++;
		if (i === 0) return "";
		const skipped = this.#buffer.slice(0, i);
		this.#buffer = this.#buffer.slice(i);
		return skipped;
	}

	#dropOneLineBreak(): string {
		if (this.#buffer.startsWith("\r\n")) {
			this.#buffer = this.#buffer.slice(2);
			return "\r\n";
		}
		if (this.#buffer.startsWith("\n")) {
			this.#buffer = this.#buffer.slice(1);
			return "\n";
		}
		return "";
	}

	#matchingControlToken(): string | undefined {
		if (this.#buffer.startsWith(DEEPSEEK_TOOL_CALLS_END)) return DEEPSEEK_TOOL_CALLS_END;
		if (this.#buffer.startsWith(THINK_CLOSE)) return THINK_CLOSE;
		if (this.#buffer.startsWith(DSML_TOOL_CALLS_CLOSE_FULLWIDTH)) return DSML_TOOL_CALLS_CLOSE_FULLWIDTH;
		if (this.#buffer.startsWith(DSML_TOOL_CALLS_CLOSE_ASCII)) return DSML_TOOL_CALLS_CLOSE_ASCII;
		for (const token of CONTROL_TOKENS) {
			if (this.#buffer.startsWith(token)) return token;
		}
		return undefined;
	}

	#matchingDsmlClose(fullwidth: string, ascii: string): string | undefined {
		if (this.#buffer.startsWith(fullwidth)) return fullwidth;
		if (this.#buffer.startsWith(ascii)) return ascii;
		return undefined;
	}

	#matchDsmlOpen(
		kind: "invoke" | "parameter",
	): { name: string; stringAttr: string | undefined; raw: string } | undefined {
		if (!this.#buffer.startsWith(`<｜DSML｜${kind}`) && !this.#buffer.startsWith(`<|DSML|${kind}`)) return undefined;
		const end = this.#buffer.indexOf(">");
		if (end === -1) return undefined;
		const tag = this.#buffer.slice(0, end + 1);
		const name = /\sname="([^"]*)"/.exec(tag)?.[1];
		if (name === undefined) return undefined;
		const stringAttr = /\sstring="(true|false)"/.exec(tag)?.[1];
		this.#buffer = this.#buffer.slice(end + 1);
		return { name, stringAttr, raw: tag };
	}

	#resetTool(next: State = "outside"): void {
		this.#state = next;
		this.#id = "";
		this.#name = "";
		this.#rawBlock = "";
	}

	#resetDsmlTool(): void {
		this.#id = "";
		this.#name = "";
		this.#dsmlArgs = {};
		this.#dsmlParamName = "";
		this.#dsmlParamIsString = true;
		this.#dsmlParamRaw = "";
		this.#rawBlock = "";
	}
}

function findEarliestToken(text: string, tokens: readonly string[]): { index: number; token: string } | undefined {
	let bestIndex = -1;
	let bestToken = "";
	for (const token of tokens) {
		const index = text.indexOf(token);
		if (index === -1) continue;
		if (bestIndex === -1 || index < bestIndex || (index === bestIndex && token.length > bestToken.length)) {
			bestIndex = index;
			bestToken = token;
		}
	}
	return bestIndex === -1 ? undefined : { index: bestIndex, token: bestToken };
}

function coerceDsmlValue(raw: string, isString: boolean): unknown {
	if (isString) return raw;
	const trimmed = raw.trim();
	if (trimmed.length === 0) return raw;
	try {
		return parseJsonWithRepair<unknown>(trimmed);
	} catch {
		return raw;
	}
}

function renderToolCall(call: ToolCall, _options: DialectRenderOptions = {}): string {
	return `${DEEPSEEK_TOOL_CALL_BEGIN}${call.name}${DEEPSEEK_TOOL_SEPARATOR}${stringifyJson(call.arguments)}${DEEPSEEK_TOOL_CALL_END}`;
}

function renderAssistantToolCalls(calls: readonly ToolCall[], options: DialectRenderOptions = {}): string {
	if (calls.length === 0) return "";
	const body = calls.map(call => renderToolCall(call, options)).join("");
	return `${DEEPSEEK_TOOL_CALLS_BEGIN}${body}${DEEPSEEK_TOOL_CALLS_END}`;
}

function renderToolResults(results: readonly DialectToolResult[], _options: DialectRenderOptions = {}): string {
	return results.map(result => `${DEEPSEEK_TOOL_OUTPUT_BEGIN}${result.text}${DEEPSEEK_TOOL_OUTPUT_END}`).join("\n");
}

function renderThinking(text: string): string {
	if (!text) return "";
	return `${THINK_OPEN}\n${text}\n${THINK_CLOSE}`;
}

function renderTranscript(messages: readonly Message[], options: DialectRenderOptions = {}): string {
	if (messages.length === 0) return "";
	let out = DEEPSEEK_BOS;
	for (let i = 0; i < messages.length;) {
		const message = messages[i]!;
		if (message.role === "assistant") {
			const parts = assistantTranscriptParts(message);
			out += `${DEEPSEEK_ASSISTANT}${renderThinking(parts.thinking)}${parts.text}${renderAssistantToolCalls(parts.toolCalls, options)}${DEEPSEEK_EOS}`;
			i++;
			continue;
		}
		if (message.role === "toolResult") {
			const run = collectToolResultRun(messages, i);
			out += renderToolResults(run.results, options);
			i = run.next;
			continue;
		}
		if (message.role === "developer") out += messageContentText(message.content);
		else out += `${DEEPSEEK_USER}${messageContentText(message.content)}`;
		i++;
	}
	return out;
}

const definition: DialectDefinition = {
	dialect: "deepseek",
	prompt: dialectPrompt,
	createScanner: options => new DeepSeekInbandScanner(options),
	renderToolCall,
	renderAssistantToolCalls,
	renderToolResults,
	renderThinking,
	renderTranscript,
};

export default definition;
