import type { Message, ToolCall } from "../types";
import { mintToolCallId, partialSuffixOverlapAny } from "./coercion";
import { FencedThinkingScanner } from "./fenced-thinking";
import dialectPrompt from "./gemini.md" with { type: "text" };
import {
	assistantTranscriptParts,
	collectToolResultRun,
	joinUserBodies,
	messageContentText,
	pyValue,
} from "./rendering";
import type {
	DialectDefinition,
	DialectRenderOptions,
	DialectToolResult,
	InbandScanEvent,
	InbandScanner,
	InbandScannerOptions,
} from "./types";

const CODE_OPEN = "```tool_code";
const OUTPUT_OPEN = "```tool_outputs";
const FENCE = "```";
const OPEN_TAGS = [CODE_OPEN] as const;
const THINK_OPEN = "```thinking\n";
const OPEN_TAGS_THINK = [CODE_OPEN, THINK_OPEN] as const;

type State = "outside" | "tool" | "thinking";

interface ParsedCall {
	name: string;
	arguments: Record<string, unknown>;
}

/**
 * Scanner for the hosted-Gemini / Gemma 3 Pythonic tool-calling convention
 * (see `docs/toolconv/gemini.md`). Tool calls arrive as a ```` ```tool_code ````
 * fenced block whose body is one or more Python call expressions, e.g.
 * `print(default_api.search(pattern="x", skip=40))`. Like the qwen3 scanner we
 * buffer the whole block until its closing fence, then parse all calls at once
 * (no incremental argument deltas — Python literals are not worth streaming).
 */
export class GeminiInbandScanner implements InbandScanner {
	#buffer = "";
	#state: State = "outside";
	#thinking = "";
	/** Fence-aware close-matcher while {@link #state} is "thinking"; undefined otherwise. */
	#fenced: FencedThinkingScanner | undefined;
	readonly #parseThinking: boolean;

	constructor(options: InbandScannerOptions = {}) {
		this.#parseThinking = options.parseThinking !== false;
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
		for (;;) {
			if (this.#state === "thinking") {
				// Always run on final so the fenced scanner flushes its held tail even
				// when #buffer is empty (a partial close held from the previous feed).
				this.#consumeThinking(final, events);
				if (this.#state === "thinking") break;
				continue;
			}
			if (this.#buffer.length === 0) break;
			if (this.#state === "outside") {
				this.#consumeOutside(final, events);
				if (this.#state === "outside") break;
				continue;
			}
			this.#consumeTool(final, events);
			if (this.#state === "tool") break;
		}
		return events;
	}

	#consumeOutside(final: boolean, events: InbandScanEvent[]): void {
		const code = this.#buffer.indexOf(CODE_OPEN);
		const think = this.#parseThinking ? this.#buffer.indexOf(THINK_OPEN) : -1;
		let start = code;
		let isThink = false;
		if (think !== -1 && (start === -1 || think < start)) {
			start = think;
			isThink = true;
		}
		if (start === -1) {
			const tags = this.#parseThinking ? OPEN_TAGS_THINK : OPEN_TAGS;
			const hold = final ? 0 : partialSuffixOverlapAny(this.#buffer, tags);
			const emit = this.#buffer.slice(0, this.#buffer.length - hold);
			if (emit.length > 0) events.push({ type: "text", text: emit });
			this.#buffer = this.#buffer.slice(this.#buffer.length - hold);
			return;
		}
		if (start > 0) events.push({ type: "text", text: this.#buffer.slice(0, start) });
		if (isThink) {
			this.#buffer = this.#buffer.slice(start + THINK_OPEN.length);
			this.#thinking = "";
			this.#fenced = new FencedThinkingScanner();
			events.push({ type: "thinkingStart" });
			this.#state = "thinking";
			return;
		}
		this.#buffer = this.#buffer.slice(start + CODE_OPEN.length);
		this.#state = "tool";
	}

	#consumeThinking(final: boolean, events: InbandScanEvent[]): void {
		const result = this.#fenced!.feed(this.#buffer, final);
		this.#buffer = result.closed ? result.rest : "";
		this.#emitThinking(result.thinking, events);
		if (result.closed || final) {
			this.#endThinking(events);
			this.#fenced = undefined;
		}
	}

	#emitThinking(delta: string, events: InbandScanEvent[]): void {
		if (delta.length === 0) return;
		this.#thinking += delta;
		events.push({ type: "thinkingDelta", delta });
	}

	#endThinking(events: InbandScanEvent[]): void {
		events.push({ type: "thinkingEnd", thinking: this.#thinking });
		this.#thinking = "";
		this.#state = "outside";
	}

	#consumeTool(final: boolean, events: InbandScanEvent[]): void {
		const close = this.#buffer.indexOf(FENCE);
		if (close === -1) {
			// Inside the fence we emit nothing until it closes; on a truncated
			// stream the incomplete block is dropped rather than leaked as text.
			if (final) {
				this.#buffer = "";
				this.#state = "outside";
			}
			return;
		}
		const body = this.#buffer.slice(0, close);
		const rawBlock = `${CODE_OPEN}${body}${FENCE}`;
		for (const call of parseGeminiCalls(body)) {
			const id = mintToolCallId();
			events.push({ type: "toolStart", id, name: call.name });
			events.push({ type: "toolEnd", id, name: call.name, arguments: call.arguments, rawBlock });
		}
		this.#buffer = this.#buffer.slice(close + FENCE.length);
		this.#state = "outside";
	}
}

/** Extract every top-level call expression in a `tool_code` body. */
function parseGeminiCalls(body: string): ParsedCall[] {
	const calls: ParsedCall[] = [];
	let i = 0;
	const n = body.length;
	while (i < n) {
		const ch = body[i]!;
		if (ch === '"' || ch === "'") {
			i = skipString(body, i);
			continue;
		}
		if (ch === "#") {
			i = skipComment(body, i);
			continue;
		}
		if (ch === "(") {
			const name = identBefore(body, i);
			if (name && name !== "print") {
				const end = matchParen(body, i);
				if (end !== -1) {
					calls.push({ name, arguments: parsePyArgs(body.slice(i + 1, end)) });
					i = end + 1;
					continue;
				}
			}
		}
		i++;
	}
	return calls;
}

/** Identifier immediately preceding a `(` (the callee's final name segment). */
function identBefore(body: string, parenIndex: number): string | undefined {
	let j = parenIndex - 1;
	while (j >= 0 && /\s/.test(body[j]!)) j--;
	const end = j + 1;
	while (j >= 0 && /[A-Za-z0-9_]/.test(body[j]!)) j--;
	const name = body.slice(j + 1, end);
	return /^[A-Za-z_]\w*$/.test(name) ? name : undefined;
}

/** Index of the `)` matching the `(` at `openIndex`, skipping string contents. */
function matchParen(body: string, openIndex: number): number {
	let depth = 0;
	let i = openIndex;
	const n = body.length;
	while (i < n) {
		const ch = body[i]!;
		if (ch === '"' || ch === "'") {
			i = skipString(body, i);
			continue;
		}
		if (ch === "#") {
			i = skipComment(body, i);
			continue;
		}
		if (ch === "(") depth++;
		else if (ch === ")" && --depth === 0) return i;
		i++;
	}
	return -1;
}

/** Index just past the Python string literal starting at `i` (a quote char). */
function skipString(body: string, i: number): number {
	const quote = body[i]!;
	const triple = quote + quote + quote;
	if (body.startsWith(triple, i)) {
		const close = body.indexOf(triple, i + 3);
		return close === -1 ? body.length : close + 3;
	}
	let j = i + 1;
	const n = body.length;
	while (j < n) {
		const ch = body[j]!;
		if (ch === "\\") {
			j += 2;
			continue;
		}
		if (ch === quote) return j + 1;
		j++;
	}
	return n;
}

function skipComment(body: string, i: number): number {
	const newline = body.indexOf("\n", i + 1);
	return newline === -1 ? body.length : newline + 1;
}

function stripComments(body: string): string {
	let out = "";
	let i = 0;
	const n = body.length;
	while (i < n) {
		const ch = body[i]!;
		if (ch === '"' || ch === "'") {
			const end = skipString(body, i);
			out += body.slice(i, end);
			i = end;
			continue;
		}
		if (ch === "#") {
			const newline = body.indexOf("\n", i + 1);
			if (newline === -1) break;
			out += "\n";
			i = newline + 1;
			continue;
		}
		out += ch;
		i++;
	}
	return out;
}

function parsePyArgs(text: string): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const segment of splitTopLevel(stripComments(text), ",")) {
		const trimmed = segment.trim();
		if (trimmed.length === 0) continue;
		const eq = topLevelIndexOf(trimmed, "=");
		if (eq === -1) continue; // positional args are not part of the convention
		const key = trimmed.slice(0, eq).trim();
		if (!/^[A-Za-z_]\w*$/.test(key)) continue;
		out[key] = parsePyValue(trimmed.slice(eq + 1).trim());
	}
	return out;
}

function parsePyValue(raw: string): unknown {
	const t = raw.trim();
	if (t.length === 0) return "";
	if (t === "True" || t === "true") return true;
	if (t === "False" || t === "false") return false;
	if (t === "None" || t === "null") return null;
	const prefix = stringPrefixLength(t);
	if (prefix !== undefined) return decodeString(t);
	const first = t[0]!;
	if (first === "[") return parseList(t);
	if (first === "{") return parseDict(t);
	if (/^[+-]?(\d|\.)/.test(t)) {
		const num = Number(t);
		if (!Number.isNaN(num)) return num;
	}
	return t;
}

function parseList(t: string): unknown[] {
	const inner = t.slice(1, t.endsWith("]") ? t.length - 1 : t.length);
	return splitTopLevel(stripComments(inner), ",")
		.map(part => part.trim())
		.filter(part => part.length > 0)
		.map(parsePyValue);
}

function parseDict(t: string): Record<string, unknown> {
	const inner = t.slice(1, t.endsWith("}") ? t.length - 1 : t.length);
	const out: Record<string, unknown> = {};
	for (const segment of splitTopLevel(stripComments(inner), ",")) {
		const trimmed = segment.trim();
		if (trimmed.length === 0) continue;
		const colon = topLevelIndexOf(trimmed, ":");
		if (colon === -1) continue;
		const keyRaw = trimmed.slice(0, colon).trim();
		const key = stringPrefixLength(keyRaw) !== undefined ? decodeString(keyRaw) : keyRaw;
		out[key] = parsePyValue(trimmed.slice(colon + 1).trim());
	}
	return out;
}

function decodeString(t: string): string {
	const prefix = stringPrefixLength(t) ?? 0;
	const raw = t.slice(0, prefix).toLowerCase().includes("r");
	const quote = t[prefix]!;
	const triple = quote + quote + quote;
	if (t.startsWith(triple, prefix) && t.length >= prefix + 6 && t.endsWith(triple)) {
		const inner = t.slice(prefix + 3, t.length - 3);
		return raw ? inner : unescapePythonString(inner);
	}
	const inner = t.endsWith(quote) && t.length >= prefix + 2 ? t.slice(prefix + 1, t.length - 1) : t.slice(prefix + 1);
	return raw ? inner : unescapePythonString(inner);
}

function stringPrefixLength(t: string): number | undefined {
	for (const len of [2, 1, 0]) {
		const prefix = t.slice(0, len).toLowerCase();
		if (
			(prefix === "" || prefix === "r" || prefix === "u" || prefix === "b" || prefix === "br" || prefix === "rb") &&
			(t[len] === '"' || t[len] === "'")
		) {
			return len;
		}
	}
	return undefined;
}

function unescapePythonString(s: string): string {
	if (!s.includes("\\")) return s;
	let out = "";
	let i = 0;
	while (i < s.length) {
		const ch = s[i]!;
		if (ch !== "\\") {
			out += ch;
			i++;
			continue;
		}
		const next = s[i + 1];
		if (next && /^[0-7]$/.test(next)) {
			const octal = /^[0-7]{1,3}/.exec(s.slice(i + 1))![0];
			out += String.fromCharCode(parseInt(octal, 8));
			i += octal.length + 1;
			continue;
		}
		switch (next) {
			case "n":
				out += "\n";
				i += 2;
				break;
			case "t":
				out += "\t";
				i += 2;
				break;
			case "r":
				out += "\r";
				i += 2;
				break;
			case "\\":
				out += "\\";
				i += 2;
				break;
			case "'":
				out += "'";
				i += 2;
				break;
			case '"':
				out += '"';
				i += 2;
				break;
			case "0":
				out += "\0";
				i += 2;
				break;
			case "x": {
				const hex = s.slice(i + 2, i + 4);
				if (/^[0-9a-fA-F]{2}$/.test(hex)) {
					out += String.fromCharCode(parseInt(hex, 16));
					i += 4;
				} else {
					out += "x";
					i += 2;
				}
				break;
			}
			case "u": {
				const hex = s.slice(i + 2, i + 6);
				if (/^[0-9a-fA-F]{4}$/.test(hex)) {
					out += String.fromCharCode(parseInt(hex, 16));
					i += 6;
				} else {
					out += "u";
					i += 2;
				}
				break;
			}
			case "U": {
				const hex = s.slice(i + 2, i + 10);
				if (/^[0-9a-fA-F]{8}$/.test(hex)) {
					out += String.fromCodePoint(parseInt(hex, 16));
					i += 10;
				} else {
					out += "U";
					i += 2;
				}
				break;
			}
			case undefined:
				out += "\\";
				i += 1;
				break;
			default:
				out += next;
				i += 2;
				break;
		}
	}
	return out;
}

/** Split on `sep` at bracket depth 0, skipping string literals. */
function splitTopLevel(text: string, sep: string): string[] {
	const parts: string[] = [];
	let depth = 0;
	let start = 0;
	let i = 0;
	const n = text.length;
	while (i < n) {
		const ch = text[i]!;
		if (ch === '"' || ch === "'") {
			i = skipString(text, i);
			continue;
		}
		if (ch === "#") {
			i = skipComment(text, i);
			continue;
		}
		if (ch === "(" || ch === "[" || ch === "{") depth++;
		else if (ch === ")" || ch === "]" || ch === "}") depth--;
		else if (depth === 0 && ch === sep) {
			parts.push(text.slice(start, i));
			start = i + 1;
		}
		i++;
	}
	parts.push(text.slice(start));
	return parts;
}

/** First index of `ch` at bracket depth 0, skipping string literals. */
function topLevelIndexOf(text: string, ch: string): number {
	let depth = 0;
	let i = 0;
	const n = text.length;
	while (i < n) {
		const c = text[i]!;
		if (c === '"' || c === "'") {
			i = skipString(text, i);
			continue;
		}
		if (c === "#") {
			i = skipComment(text, i);
			continue;
		}
		if (c === "(" || c === "[" || c === "{") depth++;
		else if (c === ")" || c === "]" || c === "}") depth--;
		else if (depth === 0 && c === ch) return i;
		i++;
	}
	return -1;
}

function renderToolCall(call: ToolCall, _options: DialectRenderOptions = {}): string {
	// Always escaped single-line literals: the scanner round-trips this wire
	// form through unescapePythonString, so pyCall's verbatim `"""` example
	// blocks would corrupt backslash-bearing content.
	let kwargs = "";
	for (const key in call.arguments) {
		kwargs += `${kwargs ? ", " : ""}${key}=${pyValue(call.arguments[key])}`;
	}
	return `default_api.${call.name}(${kwargs})`;
}

function renderAssistantToolCalls(calls: readonly ToolCall[], options: DialectRenderOptions = {}): string {
	// One call renders bare; parallel calls render as a Python list `[a, b]`.
	const body =
		calls.length === 1
			? renderToolCall(calls[0]!, options)
			: `[${calls.map(call => renderToolCall(call, options)).join(", ")}]`;
	return `${CODE_OPEN}\n${body}\n${FENCE}`;
}

function renderToolResults(results: readonly DialectToolResult[]): string {
	return results.map(result => `${OUTPUT_OPEN}\n${result.text}\n${FENCE}`).join("\n");
}

function renderThinking(text: string): string {
	if (!text) return "";
	return `${THINK_OPEN}${text}\n${FENCE}`;
}

function renderTranscript(messages: readonly Message[], options: DialectRenderOptions = {}): string {
	if (messages.length === 0) return "";
	let out = "<bos>";
	let pendingUserPreamble = "";
	for (let i = 0; i < messages.length;) {
		const message = messages[i]!;
		if (message.role === "developer") {
			pendingUserPreamble = joinUserBodies(pendingUserPreamble, messageContentText(message.content));
			i++;
			continue;
		}
		if (message.role === "user") {
			out += geminiTurn("user", joinUserBodies(pendingUserPreamble, messageContentText(message.content)));
			pendingUserPreamble = "";
			i++;
			continue;
		}
		if (pendingUserPreamble) {
			out += geminiTurn("user", pendingUserPreamble);
			pendingUserPreamble = "";
		}
		if (message.role === "assistant") {
			const parts = assistantTranscriptParts(message);
			const thinking = parts.thinking ? `${renderThinking(parts.thinking)}\n` : "";
			out += geminiTurn("model", `${thinking}${parts.text}${renderAssistantToolCalls(parts.toolCalls, options)}`);
			i++;
			continue;
		}
		const run = collectToolResultRun(messages, i);
		out += geminiTurn("user", renderToolResults(run.results));
		i = run.next;
	}
	if (pendingUserPreamble) out += geminiTurn("user", pendingUserPreamble);
	return out;
}

function geminiTurn(role: "model" | "user", body: string): string {
	return `<start_of_turn>${role}\n${body}<end_of_turn>\n`;
}

const definition: DialectDefinition = {
	dialect: "gemini",
	prompt: dialectPrompt,
	createScanner: options => new GeminiInbandScanner(options),
	renderToolCall,
	renderAssistantToolCalls,
	renderToolResults,
	renderThinking,
	renderTranscript,
};

export default definition;
