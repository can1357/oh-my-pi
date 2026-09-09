import { parseJsonWithRepair } from "@oh-my-pi/pi-utils";
import type { Message, ToolCall } from "../types";
import dialectPrompt from "./anthropic.md" with { type: "text" };
import { buildArgShapes, buildStringArgsResolver, mintToolCallId, type ToolArgShape } from "./coercion";
import {
	escapeXmlAttr,
	escapeXmlText,
	renderDelimitedThinking,
	renderLegacyTextTranscript,
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

const MAX_PARTIAL_TAG_LENGTH = 256;
const MAX_PARAMETER_VALUE_LENGTH = 1_000_000;

const WRAPPER_TAGS: Readonly<Record<string, true>> = { function_calls: true, tool_calls: true };
const THINKING_TAGS: Record<string, true> = { thinking: true, think: true, scratchpad: true };
const BASE_TAG_PREFIXES = [
	"<function_calls",
	"</function_calls",
	"<tool_calls",
	"</tool_calls",
	"<invoke",
	"</invoke",
	"<parameter",
	"</parameter",
	"<antml:function_calls",
	"</antml:function_calls",
	"<antml:tool_calls",
	"</antml:tool_calls",
	"<antml:invoke",
	"</antml:invoke",
	"<antml:parameter",
	"</antml:parameter",
] as const;
export const ANTHROPIC_THINKING_TAG_PREFIXES = [
	"<thinking",
	"</thinking",
	"<think",
	"</think",
	"<scratchpad",
	"</scratchpad",
	"<antml:thinking",
	"</antml:thinking",
	"<antml:think",
	"</antml:think",
	"<antml:scratchpad",
	"</antml:scratchpad",
] as const;

export interface AnthropicInbandScannerConfig {
	readonly wrapperTags?: Readonly<Record<string, true>>;
	readonly baseTagPrefixes?: readonly string[];
	readonly allTagPrefixes?: readonly string[];
}
type ScannerState = "outside" | "section" | "invoke" | "parameter" | "thinking";
type ReturnState = "outside" | "section";

interface ParsedTag {
	readonly raw: string;
	readonly localName: string;
	readonly prefix: string;
	readonly closing: boolean;
	readonly selfClosing: boolean;
	readonly attrs: ReadonlyMap<string, string>;
}

type TagRead = ParsedTag | "partial" | undefined;

export class AnthropicInbandScanner implements InbandScanner {
	#buffer = "";
	#state: ScannerState = "outside";
	#returnState: ReturnState = "outside";
	#afterThinkingState: ReturnState = "outside";
	#id = "";
	#name = "";
	#args: Record<string, unknown> = {};
	#started = false;
	#paramName = "";
	#paramValue = "";
	#paramString: boolean | undefined;
	#paramTruncated = false;
	#paramClosePrefixes: readonly string[] = [];
	#rawBlock = "";
	#thinking = "";
	#thinkingTag = "";
	#thinkingClosePrefixes: readonly string[] = [];
	readonly #wrapperTags: Readonly<Record<string, true>>;
	readonly #baseTagPrefixes: readonly string[];
	readonly #allTagPrefixes: readonly string[];
	readonly #stringArgs: (toolName: string) => ReadonlySet<string>;
	readonly #parseThinking: boolean;

	constructor(options: InbandScannerOptions = {}, config: AnthropicInbandScannerConfig = {}) {
		this.#wrapperTags = config.wrapperTags ?? WRAPPER_TAGS;
		this.#baseTagPrefixes = config.baseTagPrefixes ?? BASE_TAG_PREFIXES;
		this.#allTagPrefixes = config.allTagPrefixes ?? ALL_TAG_PREFIXES;
		this.#stringArgs = options.stringArgs ?? buildStringArgsResolver(options.tools);
		this.#parseThinking = options.parseThinking === true;
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
			let progressed: boolean;
			switch (this.#state) {
				case "outside":
					progressed = this.#consumeOutside(final, events);
					break;
				case "section":
					progressed = this.#consumeSection(final, events);
					break;
				case "invoke":
					progressed = this.#consumeInvoke(final, events);
					break;
				case "parameter":
					progressed = this.#consumeParameter(final, events);
					break;
				case "thinking":
					progressed = this.#consumeThinking(final, events);
					break;
			}
			if (!progressed) break;
		}
		if (final) this.#flushFinal(events);
		return events;
	}

	#consumeOutside(final: boolean, events: InbandScanEvent[]): boolean {
		const tagStart = this.#buffer.indexOf("<");
		if (tagStart === -1) {
			this.#emitText(this.#buffer, events);
			this.#buffer = "";
			return false;
		}
		if (tagStart > 0) {
			this.#emitText(this.#buffer.slice(0, tagStart), events);
			this.#buffer = this.#buffer.slice(tagStart);
			return true;
		}

		const tag = this.#peekTag(final, this.#relevantPrefixes());
		if (tag === "partial") return false;
		if (!tag) {
			this.#emitText(this.#buffer[0]!, events);
			this.#buffer = this.#buffer.slice(1);
			return true;
		}

		if (!tag.closing && this.#wrapperTags[tag.localName] === true) {
			this.#buffer = this.#buffer.slice(tag.raw.length);
			this.#state = "section";
			return true;
		}
		if (!tag.closing && tag.localName === "invoke") {
			this.#buffer = this.#buffer.slice(tag.raw.length);
			this.#startInvoke(tag, "outside", events);
			return true;
		}
		if (this.#isThinkingOpen(tag)) {
			this.#buffer = this.#buffer.slice(tag.raw.length);
			this.#startThinking(tag, "outside", events);
			return true;
		}
		if (tag.closing && this.#wrapperTags[tag.localName] === true) {
			this.#buffer = this.#buffer.slice(tag.raw.length);
			return true;
		}

		this.#emitText(this.#buffer[0]!, events);
		this.#buffer = this.#buffer.slice(1);
		return true;
	}

	#consumeSection(final: boolean, events: InbandScanEvent[]): boolean {
		const tagStart = this.#buffer.indexOf("<");
		if (tagStart === -1) {
			this.#buffer = "";
			return false;
		}
		if (tagStart > 0) {
			this.#buffer = this.#buffer.slice(tagStart);
			return true;
		}

		const tag = this.#peekTag(final, this.#relevantPrefixes());
		if (tag === "partial") return false;
		if (!tag) {
			this.#buffer = this.#buffer.slice(1);
			return true;
		}

		this.#buffer = this.#buffer.slice(tag.raw.length);
		if (tag.closing && this.#wrapperTags[tag.localName] === true) {
			this.#state = "outside";
			return true;
		}
		if (!tag.closing && tag.localName === "invoke") {
			this.#startInvoke(tag, "section", events);
			return true;
		}
		if (this.#parseThinking && !tag.closing && THINKING_TAGS[tag.localName] === true) {
			this.#startThinking(tag, "section", events);
		}
		return true;
	}

	#consumeInvoke(final: boolean, events: InbandScanEvent[]): boolean {
		const tagStart = this.#buffer.indexOf("<");
		if (tagStart === -1) {
			if (final) this.#resetCall(this.#returnState);
			else {
				this.#rawBlock += this.#buffer;
				this.#buffer = "";
			}
			return false;
		}
		if (tagStart > 0) {
			const consumed = this.#buffer.slice(0, tagStart);
			this.#rawBlock += consumed;
			this.#buffer = this.#buffer.slice(tagStart);
			return true;
		}

		const tag = this.#peekTag(final, this.#relevantPrefixes());
		if (tag === "partial") return false;
		if (!tag) {
			const consumed = this.#buffer[0]!;
			this.#rawBlock += consumed;
			this.#buffer = this.#buffer.slice(1);
			return true;
		}

		this.#rawBlock += tag.raw;
		this.#buffer = this.#buffer.slice(tag.raw.length);
		if (tag.closing && tag.localName === "invoke") {
			if (this.#started) {
				events.push({
					type: "toolEnd",
					id: this.#id,
					name: this.#name,
					arguments: this.#args,
					rawBlock: this.#rawBlock,
				});
			}
			this.#resetCall(this.#returnState);
			return true;
		}
		if (!tag.closing && tag.localName === "parameter") {
			this.#startParameter(tag);
			if (tag.selfClosing) this.#finishParameter();
			return true;
		}
		return true;
	}

	#consumeParameter(final: boolean, events: InbandScanEvent[]): boolean {
		const tagStart = this.#buffer.indexOf("<");
		if (tagStart === -1) {
			if (final) {
				this.#resetCall(this.#returnState);
				this.#buffer = "";
				return false;
			}
			this.#appendParameterValue(this.#buffer, events);
			this.#rawBlock += this.#buffer;
			this.#buffer = "";
			return false;
		}
		if (tagStart > 0) {
			const consumed = this.#buffer.slice(0, tagStart);
			this.#appendParameterValue(consumed, events);
			this.#rawBlock += consumed;
			this.#buffer = this.#buffer.slice(tagStart);
			return true;
		}

		const tag = this.#peekTag(final, this.#paramClosePrefixes);
		if (tag === "partial") return false;
		if (tag?.closing && tag.localName === "parameter") {
			this.#rawBlock += tag.raw;
			this.#buffer = this.#buffer.slice(tag.raw.length);
			this.#finishParameter();
			return true;
		}
		if (final && !tag) {
			this.#resetCall(this.#returnState);
			this.#buffer = "";
			return false;
		}
		const consumed = this.#buffer[0]!;
		this.#appendParameterValue(consumed, events);
		this.#rawBlock += consumed;
		this.#buffer = this.#buffer.slice(1);
		return true;
	}

	#consumeThinking(final: boolean, events: InbandScanEvent[]): boolean {
		const tagStart = this.#buffer.indexOf("<");
		if (tagStart === -1) {
			if (final) {
				this.#appendThinking(this.#buffer, events);
				this.#buffer = "";
				this.#finishThinking(events);
				return false;
			}
			this.#appendThinking(this.#buffer, events);
			this.#buffer = "";
			return false;
		}
		if (tagStart > 0) {
			this.#appendThinking(this.#buffer.slice(0, tagStart), events);
			this.#buffer = this.#buffer.slice(tagStart);
			return true;
		}

		const tag = this.#peekTag(final, this.#thinkingClosePrefixes);
		if (tag === "partial") return false;
		if (tag?.closing && tag.localName === this.#thinkingTag) {
			this.#buffer = this.#buffer.slice(tag.raw.length);
			this.#finishThinking(events);
			return true;
		}
		if (final && !tag) {
			this.#appendThinking(this.#buffer, events);
			this.#buffer = "";
			this.#finishThinking(events);
			return false;
		}
		this.#appendThinking(this.#buffer[0]!, events);
		this.#buffer = this.#buffer.slice(1);
		return true;
	}

	#flushFinal(events: InbandScanEvent[]): void {
		if (this.#state === "outside") return;
		if (this.#state === "thinking") this.#finishThinking(events);
		else this.#resetCall(this.#returnState);
		this.#state = "outside";
		this.#buffer = "";
	}

	#startInvoke(tag: ParsedTag, returnState: ReturnState, events: InbandScanEvent[]): void {
		this.#returnState = returnState;
		this.#id = mintToolCallId();
		this.#name = tag.attrs.get("name")?.trim() ?? "";
		this.#args = {};
		this.#rawBlock = tag.raw;
		this.#started = this.#name.length > 0;
		this.#state = "invoke";
		if (this.#started) events.push({ type: "toolStart", id: this.#id, name: this.#name });
	}

	#startParameter(tag: ParsedTag): void {
		this.#paramName = tag.attrs.get("name")?.trim() ?? "";
		this.#paramValue = "";
		this.#paramTruncated = false;
		this.#paramString = parseStringAttribute(tag.attrs.get("string"));
		this.#paramClosePrefixes = closePrefixes("parameter", tag.prefix);
		this.#state = "parameter";
	}

	#appendParameterValue(delta: string, events: InbandScanEvent[]): void {
		if (delta.length === 0) return;
		const remaining = MAX_PARAMETER_VALUE_LENGTH - this.#paramValue.length;
		const accepted = remaining > 0 ? delta.slice(0, remaining) : "";
		if (accepted.length > 0) {
			this.#paramValue += accepted;
			if (this.#started && this.#paramName.length > 0) {
				events.push({
					type: "toolArgDelta",
					id: this.#id,
					name: this.#name,
					key: this.#paramName,
					delta: accepted,
				});
			}
		}
		if (delta.length > remaining) this.#paramTruncated = true;
	}

	#finishParameter(): void {
		if (this.#paramName.length > 0) {
			const value = this.#paramTruncated
				? `${this.#paramValue}\n…[parameter truncated: exceeded ${MAX_PARAMETER_VALUE_LENGTH} bytes]`
				: this.#paramValue;
			this.#args[this.#paramName] = this.#coerceParameterValue(this.#paramName, value, this.#paramString);
		}
		this.#paramName = "";
		this.#paramValue = "";
		this.#paramString = undefined;
		this.#paramTruncated = false;
		this.#paramClosePrefixes = [];
		this.#state = "invoke";
	}

	#coerceParameterValue(name: string, raw: string, explicitString: boolean | undefined): unknown {
		if (explicitString ?? this.#stringArgs(this.#name).has(name)) return raw;
		const trimmed = raw.trim();
		if (trimmed.length === 0) return raw;
		try {
			return parseJsonWithRepair<unknown>(trimmed);
		} catch {
			return raw;
		}
	}

	#startThinking(tag: ParsedTag, afterState: ReturnState, events: InbandScanEvent[]): void {
		this.#afterThinkingState = afterState;
		this.#thinking = "";
		this.#thinkingTag = tag.localName;
		this.#thinkingClosePrefixes = closePrefixes(tag.localName, tag.prefix);
		this.#state = "thinking";
		events.push({ type: "thinkingStart" });
		if (tag.selfClosing) this.#finishThinking(events);
	}

	#appendThinking(delta: string, events: InbandScanEvent[]): void {
		if (delta.length === 0) return;
		this.#thinking += delta;
		events.push({ type: "thinkingDelta", delta });
	}

	#finishThinking(events: InbandScanEvent[]): void {
		events.push({ type: "thinkingEnd", thinking: this.#thinking });
		this.#thinking = "";
		this.#thinkingTag = "";
		this.#thinkingClosePrefixes = [];
		this.#state = this.#afterThinkingState;
		this.#afterThinkingState = "outside";
	}

	#resetCall(nextState: ReturnState): void {
		this.#id = "";
		this.#name = "";
		this.#args = {};
		this.#started = false;
		this.#paramName = "";
		this.#paramValue = "";
		this.#paramString = undefined;
		this.#paramTruncated = false;
		this.#paramClosePrefixes = [];
		this.#rawBlock = "";
		this.#state = nextState;
	}

	#peekTag(final: boolean, relevantPrefixes: readonly string[]): TagRead {
		const close = this.#buffer.indexOf(">");
		if (close === -1) {
			if (
				!final &&
				this.#buffer.length <= MAX_PARTIAL_TAG_LENGTH &&
				couldBeTagPrefix(this.#buffer, relevantPrefixes)
			) {
				return "partial";
			}
			return undefined;
		}
		const raw = this.#buffer.slice(0, close + 1);
		return parseTag(raw);
	}

	#isThinkingOpen(tag: ParsedTag): boolean {
		if (!this.#parseThinking || tag.closing) return false;
		return THINKING_TAGS[tag.localName] === true;
	}

	#relevantPrefixes(): readonly string[] {
		return this.#parseThinking ? this.#allTagPrefixes : this.#baseTagPrefixes;
	}

	#emitText(text: string, events: InbandScanEvent[]): void {
		if (text.length > 0) events.push({ type: "text", text });
	}
}

const ALL_TAG_PREFIXES = [...BASE_TAG_PREFIXES, ...ANTHROPIC_THINKING_TAG_PREFIXES] as const;

function parseTag(raw: string): ParsedTag | undefined {
	const match = /^<\s*(\/?)\s*(?:(?<prefix>[A-Za-z_][\w.-]*):)?(?<localName>[A-Za-z_][\w.-]*)(?<attrs>[^>]*)>$/s.exec(
		raw,
	);
	const localName = match?.groups?.localName;
	if (!match || !localName) return undefined;
	const attrsText = match.groups?.attrs ?? "";
	return {
		raw,
		localName: localName.toLowerCase(),
		prefix: match.groups?.prefix ?? "",
		closing: match[1] === "/",
		selfClosing: match[1] !== "/" && /\/\s*$/.test(attrsText),
		attrs: parseAttributes(attrsText),
	};
}

function parseAttributes(text: string): ReadonlyMap<string, string> {
	const attrs = new Map<string, string>();
	const pattern = /([A-Za-z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>/=]+))/g;
	for (const match of text.matchAll(pattern)) {
		const rawName = match[1];
		if (!rawName) continue;
		const colon = rawName.lastIndexOf(":");
		const name = (colon === -1 ? rawName : rawName.slice(colon + 1)).toLowerCase();
		attrs.set(name, match[2] ?? match[3] ?? match[4] ?? "");
	}
	return attrs;
}

function parseStringAttribute(value: string | undefined): boolean | undefined {
	if (value === undefined) return undefined;
	const normalized = value.trim().toLowerCase();
	if (normalized === "false" || normalized === "0" || normalized === "no") return false;
	return true;
}

function closePrefixes(localName: string, prefix: string): readonly string[] {
	const unprefixed = `</${localName}`;
	const antml = `</antml:${localName}`;
	if (prefix.length === 0 || prefix === "antml") return [unprefixed, antml];
	return [`</${prefix}:${localName}`, unprefixed, antml];
}

function couldBeTagPrefix(buffer: string, prefixes: readonly string[]): boolean {
	if (!buffer.startsWith("<")) return false;
	for (const prefix of prefixes) {
		if (prefix.startsWith(buffer) || buffer.startsWith(prefix)) return true;
	}
	return false;
}

function renderToolCall(call: ToolCall, options: DialectRenderOptions = {}): string {
	return renderInvoke(call, buildArgShapes(options.tools).get(call.name));
}

function renderAssistantToolCalls(calls: readonly ToolCall[], options: DialectRenderOptions = {}): string {
	if (calls.length === 0) return "";
	return `<function_calls>\n${renderInvokes(calls, options.tools ?? [])}\n</function_calls>`;
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
	dialect: "anthropic",
	prompt: dialectPrompt,
	createScanner: options => new AnthropicInbandScanner(options),
	renderToolCall,
	renderAssistantToolCalls,
	renderToolResults,
	renderThinking,
	renderTranscript,
};

export default definition;
