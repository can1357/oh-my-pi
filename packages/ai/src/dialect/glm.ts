import type { Message, ToolCall } from "../types";
import {
	buildArgShapes,
	buildStringArgsResolver,
	decodeValue,
	mintToolCallId,
	partialSuffixOverlap,
	partialSuffixOverlapAny,
	type ToolArgShape,
} from "./coercion";
import dialectPrompt from "./glm.md" with { type: "text" };
import {
	assistantTranscriptParts,
	collectToolResultRun,
	messageContentText,
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

const TOOL_OPEN = "<tool_call>";
const TOOL_CLOSE = "</tool_call>";
const ARG_KEY_OPEN = "<arg_key>";
const ARG_KEY_CLOSE = "</arg_key>";
const ARG_VALUE_OPEN = "<arg_value>";
const ARG_VALUE_CLOSE = "</arg_value>";
const RESPONSE_OPEN = "<tool_response>";
const RESPONSE_CLOSE = "</tool_response>";
const THINK_OPEN = "<think>";
const THINK_CLOSE = "</think>";

const OUTSIDE_TAGS = [
	TOOL_OPEN,
	ARG_KEY_OPEN,
	ARG_KEY_CLOSE,
	ARG_VALUE_OPEN,
	ARG_VALUE_CLOSE,
	RESPONSE_OPEN,
	RESPONSE_CLOSE,
	THINK_OPEN,
	THINK_CLOSE,
] as const;
const OUTSIDE_TAGS_NO_THINK = [
	TOOL_OPEN,
	ARG_KEY_OPEN,
	ARG_KEY_CLOSE,
	ARG_VALUE_OPEN,
	ARG_VALUE_CLOSE,
	RESPONSE_OPEN,
	RESPONSE_CLOSE,
] as const;
const BODY_TAGS = [ARG_KEY_OPEN, TOOL_CLOSE] as const;

type State = "outside" | "thinking" | "name" | "body" | "key" | "afterkey" | "value";

interface OpenCall {
	id: string;
	name: string;
	stringArgs: ReadonlySet<string>;
	arguments: Record<string, unknown>;
	key: string | null;
	valueRaw: string;
	rawBlock: string;
}

interface TagMatch {
	index: number;
	tag: string;
}

export class GLMInbandScanner implements InbandScanner {
	#buffer = "";
	#state: State = "outside";
	#call: OpenCall | null = null;
	#thinking = "";
	#parseThinking: boolean;
	#stringArgs: (toolName: string) => ReadonlySet<string>;

	constructor(options: InbandScannerOptions = {}) {
		this.#parseThinking = options.parseThinking !== false;
		this.#stringArgs = options.stringArgs ?? buildStringArgsResolver(options.tools);
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
				if (!this.#consumeOutside(final, events)) break;
				continue;
			}

			if (this.#state === "thinking") {
				this.#consumeThinking(final, events);
				if (this.#state === "thinking") break;
				continue;
			}

			if (this.#state === "name") {
				if (!this.#consumeName(final, events)) break;
				continue;
			}

			if (this.#state === "body") {
				if (!this.#consumeBody(final, events)) break;
				continue;
			}

			if (this.#state === "key") {
				if (!this.#consumeKey(final)) break;
				continue;
			}

			if (this.#state === "afterkey") {
				if (!this.#consumeAfterKey(final)) break;
				continue;
			}

			if (!this.#consumeValue(final, events)) break;
		}
		if (final && this.#state === "thinking") this.#endThinking(events);
		return events;
	}

	#consumeOutside(final: boolean, events: InbandScanEvent[]): boolean {
		const tags = this.#parseThinking ? OUTSIDE_TAGS : OUTSIDE_TAGS_NO_THINK;
		const match = findFirstTag(this.#buffer, tags);
		if (!match) {
			const hold = final ? 0 : partialSuffixOverlapAny(this.#buffer, tags);
			const emit = this.#buffer.slice(0, this.#buffer.length - hold);
			if (emit.length > 0) events.push({ type: "text", text: emit });
			this.#buffer = this.#buffer.slice(this.#buffer.length - hold);
			return false;
		}

		if (match.index > 0) events.push({ type: "text", text: this.#buffer.slice(0, match.index) });
		this.#buffer = this.#buffer.slice(match.index + match.tag.length);

		if (match.tag === TOOL_OPEN) {
			this.#state = "name";
			return true;
		}
		if (match.tag === THINK_OPEN && this.#parseThinking) {
			this.#thinking = "";
			events.push({ type: "thinkingStart" });
			this.#state = "thinking";
			return true;
		}
		if (match.tag === RESPONSE_OPEN) {
			this.#buffer = "";
			return false;
		}
		return true;
	}

	#consumeThinking(final: boolean, events: InbandScanEvent[]): void {
		const close = this.#buffer.indexOf(THINK_CLOSE);
		if (close === -1) {
			const hold = final ? 0 : partialSuffixOverlap(this.#buffer, THINK_CLOSE);
			const emit = this.#buffer.slice(0, this.#buffer.length - hold);
			this.#emitThinking(emit, events);
			this.#buffer = this.#buffer.slice(this.#buffer.length - hold);
			if (final) this.#endThinking(events);
			return;
		}
		this.#emitThinking(this.#buffer.slice(0, close), events);
		this.#buffer = this.#buffer.slice(close + THINK_CLOSE.length);
		this.#endThinking(events);
		this.#state = "outside";
	}

	#consumeName(final: boolean, events: InbandScanEvent[]): boolean {
		const newline = this.#buffer.indexOf("\n");
		const key = this.#buffer.indexOf(ARG_KEY_OPEN);
		const close = this.#buffer.indexOf(TOOL_CLOSE);
		const delimiter = minFound(newline, key, close);
		if (delimiter === -1) {
			if (!final) return false;
			this.#beginCall(this.#buffer, events);
			this.#buffer = "";
			this.#endCall(events);
			return false;
		}

		const rawName = this.#buffer.slice(0, delimiter);
		this.#beginCall(rawName, events);
		if (delimiter === newline) {
			this.#appendCallRaw("\n");
			this.#buffer = this.#buffer.slice(delimiter + 1);
			this.#state = "body";
			return true;
		}
		if (delimiter === key) {
			this.#appendCallRaw(ARG_KEY_OPEN);
			this.#buffer = this.#buffer.slice(delimiter + ARG_KEY_OPEN.length);
			this.#state = "key";
			return true;
		}
		this.#appendCallRaw(TOOL_CLOSE);
		this.#buffer = this.#buffer.slice(delimiter + TOOL_CLOSE.length);
		this.#endCall(events);
		return true;
	}

	#consumeBody(final: boolean, events: InbandScanEvent[]): boolean {
		this.#appendCallRaw(this.#skipWhitespace());
		if (this.#buffer.length === 0) return false;
		if (this.#buffer.startsWith(ARG_KEY_OPEN)) {
			this.#appendCallRaw(ARG_KEY_OPEN);
			this.#buffer = this.#buffer.slice(ARG_KEY_OPEN.length);
			this.#state = "key";
			return true;
		}
		if (this.#buffer.startsWith(TOOL_CLOSE)) {
			this.#appendCallRaw(TOOL_CLOSE);
			this.#buffer = this.#buffer.slice(TOOL_CLOSE.length);
			this.#endCall(events);
			return true;
		}
		if (!final && partialSuffixOverlapAny(this.#buffer, BODY_TAGS) === this.#buffer.length) return false;
		this.#appendCallRaw(this.#buffer[0] ?? "");
		this.#buffer = this.#buffer.slice(1);
		return true;
	}

	#consumeKey(final: boolean): boolean {
		const close = this.#buffer.indexOf(ARG_KEY_CLOSE);
		if (close === -1) {
			if (final) this.#dropCall();
			return false;
		}
		if (this.#call) {
			this.#call.key = this.#buffer.slice(0, close).trim();
			this.#appendCallRaw(this.#buffer.slice(0, close + ARG_KEY_CLOSE.length));
		}
		this.#buffer = this.#buffer.slice(close + ARG_KEY_CLOSE.length);
		this.#state = "afterkey";
		return true;
	}

	#consumeAfterKey(final: boolean): boolean {
		this.#appendCallRaw(this.#skipWhitespace());
		if (this.#buffer.length === 0) return false;
		if (this.#buffer.startsWith(ARG_VALUE_OPEN)) {
			this.#appendCallRaw(ARG_VALUE_OPEN);
			this.#buffer = this.#buffer.slice(ARG_VALUE_OPEN.length);
			if (this.#call) this.#call.valueRaw = "";
			this.#state = "value";
			return true;
		}
		if (!final && ARG_VALUE_OPEN.startsWith(this.#buffer)) return false;
		this.#appendCallRaw(this.#buffer[0] ?? "");
		this.#buffer = this.#buffer.slice(1);
		return true;
	}

	#consumeValue(final: boolean, events: InbandScanEvent[]): boolean {
		const close = this.#buffer.indexOf(ARG_VALUE_CLOSE);
		const heal = scanValueHeal(this.#buffer, close === -1 ? this.#buffer.length : close);
		if (heal.kind === "heal") {
			this.#streamValue(this.#buffer.slice(0, heal.valueEnd), events);
			if (heal.trimValue && this.#call) this.#call.valueRaw = this.#call.valueRaw.trimEnd();
			this.#appendCallRaw(this.#buffer.slice(heal.valueEnd, heal.resumeAt));
			this.#buffer = this.#buffer.slice(heal.resumeAt);
			this.#endValue();
			this.#state = "body";
			return true;
		}
		if (close === -1) {
			const healHold = heal.kind === "partial" ? this.#buffer.length - heal.start : 0;
			const hold = final ? 0 : Math.max(partialSuffixOverlap(this.#buffer, ARG_VALUE_CLOSE), healHold);
			const emit = this.#buffer.slice(0, this.#buffer.length - hold);
			this.#streamValue(emit, events);
			this.#buffer = this.#buffer.slice(this.#buffer.length - hold);
			if (final) this.#dropCall();
			return false;
		}
		this.#streamValue(this.#buffer.slice(0, close), events);
		this.#appendCallRaw(ARG_VALUE_CLOSE);
		this.#buffer = this.#buffer.slice(close + ARG_VALUE_CLOSE.length);
		this.#endValue();
		this.#state = "body";
		return true;
	}

	#beginCall(rawName: string, events: InbandScanEvent[]): void {
		const name = rawName.trim();
		if (name.length === 0) {
			this.#dropCall();
			return;
		}
		const id = mintToolCallId();
		this.#call = {
			id,
			name,
			stringArgs: this.#stringArgs(name),
			arguments: {},
			key: null,
			valueRaw: "",
			rawBlock: `${TOOL_OPEN}${rawName}`,
		};
		events.push({ type: "toolStart", id, name });
	}

	#streamValue(chunk: string, events: InbandScanEvent[]): void {
		const call = this.#call;
		if (!call || call.key === null || chunk.length === 0) return;
		call.valueRaw += chunk;
		call.rawBlock += chunk;
		events.push({ type: "toolArgDelta", id: call.id, name: call.name, key: call.key, delta: chunk });
	}

	#endValue(): void {
		const call = this.#call;
		if (!call || call.key === null) return;
		call.arguments[call.key] = call.stringArgs.has(call.key) ? call.valueRaw : decodeValue(call.valueRaw);
		call.key = null;
		call.valueRaw = "";
	}

	#endCall(events: InbandScanEvent[]): void {
		const call = this.#call;
		if (!call) {
			this.#state = "outside";
			return;
		}
		events.push({
			type: "toolEnd",
			id: call.id,
			name: call.name,
			arguments: call.arguments,
			rawBlock: call.rawBlock,
		});
		this.#call = null;
		this.#state = "outside";
	}

	#dropCall(): void {
		this.#call = null;
		this.#state = "outside";
	}

	#appendCallRaw(text: string): void {
		if (this.#call && text.length > 0) this.#call.rawBlock += text;
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

	#skipWhitespace(): string {
		let i = 0;
		while (i < this.#buffer.length && " \n\t\r".includes(this.#buffer[i]!)) i++;
		const skipped = this.#buffer.slice(0, i);
		if (i > 0) this.#buffer = this.#buffer.slice(i);
		return skipped;
	}
}

function findFirstTag(text: string, tags: readonly string[]): TagMatch | null {
	let best: TagMatch | null = null;
	for (const tag of tags) {
		const index = text.indexOf(tag);
		if (index === -1) continue;
		if (!best || index < best.index) best = { index, tag };
	}
	return best;
}

function minFound(...values: readonly number[]): number {
	let best = -1;
	for (const value of values) {
		if (value === -1) continue;
		if (best === -1 || value < best) best = value;
	}
	return best;
}

/** Max whitespace tolerated between heal-signature tags before giving up. */
const HEAL_WS_MAX = 32;
/** Max key length considered plausible for an inlined `<arg_key>…</arg_key>` pair. */
const HEAL_KEY_MAX = 128;

/**
 * Result of scanning a streaming `<arg_value>` body for a forgotten or
 * mistyped `</arg_value>` closer.
 *
 * - `heal`: a repair signature starts inside the value; the value ends at
 *   `valueEnd` and parsing resumes at `resumeAt` in "body" state.
 *   `trimValue` marks boundaries inferred from separator formatting, whose
 *   trailing whitespace belongs to the syntax, not the value.
 * - `partial`: a signature may be forming at `start` but the buffer ends
 *   before it can be confirmed; the caller must hold `start..` back from
 *   streaming.
 */
type ValueHealScan =
	| { kind: "none" }
	| { kind: "partial"; start: number }
	| { kind: "heal"; valueEnd: number; resumeAt: number; trimValue: boolean };

type HealFollow = { kind: "match"; resumeAt: number } | { kind: "partial" } | { kind: "none" };

type TagPrefixMatch = "match" | "partial" | "none";

/**
 * Finds the earliest heal signature starting before `limit` (the legit
 * `</arg_value>` close, or end of buffer when absent). Two signatures repair
 * a value whose closer the model botched:
 *
 * - Wrong closer: `</arg_key>` followed by `<arg_key>`, `</tool_call>`, or
 *   `</arg_value>` — the model closed the value with the wrong tag.
 * - Missing closer: a complete `<arg_key>…</arg_key>` + `<arg_value>`
 *   sequence — the model started the next pair without closing the value.
 *
 * Without repair, either mistake swallows every following pair into the
 * current value until the next `</arg_value>` anywhere in the stream.
 */
function scanValueHeal(text: string, limit: number): ValueHealScan {
	for (let at = text.indexOf("<"); at !== -1 && at < limit; at = text.indexOf("<", at + 1)) {
		const scan = matchHealSignature(text, at);
		if (scan.kind !== "none") return scan;
	}
	return { kind: "none" };
}

function matchHealSignature(text: string, start: number): ValueHealScan {
	const wrongCloser = matchTagPrefix(text, start, ARG_KEY_CLOSE);
	if (wrongCloser === "partial") return { kind: "partial", start };
	if (wrongCloser === "match") {
		const follow = matchHealFollow(text, start + ARG_KEY_CLOSE.length);
		if (follow.kind === "partial") return { kind: "partial", start };
		if (follow.kind === "match")
			return { kind: "heal", valueEnd: start, resumeAt: follow.resumeAt, trimValue: false };
		return { kind: "none" };
	}

	const nextKey = matchTagPrefix(text, start, ARG_KEY_OPEN);
	if (nextKey === "partial") return { kind: "partial", start };
	if (nextKey === "none") return { kind: "none" };
	let at = start + ARG_KEY_OPEN.length;
	const keyEnd = Math.min(text.length, at + HEAL_KEY_MAX);
	while (at < keyEnd && text[at] !== "<" && text[at] !== "\n") at++;
	if (at === text.length) return { kind: "partial", start };
	if (text[at] !== "<") return { kind: "none" };
	const keyClose = matchTagPrefix(text, at, ARG_KEY_CLOSE);
	if (keyClose === "partial") return { kind: "partial", start };
	if (keyClose === "none") return { kind: "none" };
	at = skipHealWhitespace(text, at + ARG_KEY_CLOSE.length);
	if (at === -1) return { kind: "none" };
	if (at === text.length) return { kind: "partial", start };
	const value = matchTagPrefix(text, at, ARG_VALUE_OPEN);
	if (value === "partial") return { kind: "partial", start };
	if (value === "none") return { kind: "none" };
	return { kind: "heal", valueEnd: start, resumeAt: start, trimValue: true };
}

/** Matches the tag expected after a wrong `</arg_key>` closer. */
function matchHealFollow(text: string, from: number): HealFollow {
	const at = skipHealWhitespace(text, from);
	if (at === -1) return { kind: "none" };
	if (at === text.length) return { kind: "partial" };
	for (const tag of [ARG_KEY_OPEN, TOOL_CLOSE]) {
		const match = matchTagPrefix(text, at, tag);
		if (match === "match") return { kind: "match", resumeAt: at };
		if (match === "partial") return { kind: "partial" };
	}
	const close = matchTagPrefix(text, at, ARG_VALUE_CLOSE);
	if (close === "match") return { kind: "match", resumeAt: at + ARG_VALUE_CLOSE.length };
	if (close === "partial") return { kind: "partial" };
	return { kind: "none" };
}

/** Skips whitespace from `from`; -1 when the run exceeds {@link HEAL_WS_MAX}. */
function skipHealWhitespace(text: string, from: number): number {
	let at = from;
	while (at < text.length && " \n\t\r".includes(text[at]!)) {
		at++;
		if (at - from > HEAL_WS_MAX) return -1;
	}
	return at;
}

function matchTagPrefix(text: string, at: number, tag: string): TagPrefixMatch {
	const available = Math.min(text.length - at, tag.length);
	for (let k = 0; k < available; k++) {
		if (text.charCodeAt(at + k) !== tag.charCodeAt(k)) return "none";
	}
	return available === tag.length ? "match" : "partial";
}

function renderToolCall(call: ToolCall, options: DialectRenderOptions = {}): string {
	return glmInvocation(call, buildArgShapes(options.tools).get(call.name));
}

function glmInvocation(call: ToolCall, shape: ToolArgShape | undefined): string {
	let body = `${TOOL_OPEN}${call.name}`;
	for (const key in call.arguments) {
		const value = call.arguments[key];
		const rendered = shape?.stringArgs.has(key) && typeof value === "string" ? value : stringifyJson(value);
		body += `\n${ARG_KEY_OPEN}${key}${ARG_KEY_CLOSE}\n${ARG_VALUE_OPEN}${rendered}${ARG_VALUE_CLOSE}`;
	}
	return `${body}\n${TOOL_CLOSE}`;
}

function renderAssistantToolCalls(calls: readonly ToolCall[], options: DialectRenderOptions = {}): string {
	const shapes = buildArgShapes(options.tools);
	return calls.map(call => glmInvocation(call, shapes.get(call.name))).join("\n");
}

function renderToolResults(results: readonly DialectToolResult[]): string {
	return `<observation>\n${renderToolResponseResults(results)}\n</observation>`;
}

function renderThinking(text: string): string {
	if (!text) return "";
	return `${THINK_OPEN}\n${text}\n${THINK_CLOSE}`;
}

function renderTranscript(messages: readonly Message[], options: DialectRenderOptions = {}): string {
	if (messages.length === 0) return "";
	let out = "[gMASK]<sop>";
	for (let i = 0; i < messages.length;) {
		const message = messages[i]!;
		if (message.role === "assistant") {
			const parts = assistantTranscriptParts(message);
			const thinking = parts.thinking ? `\n${renderThinking(parts.thinking)}` : "";
			out += `<|assistant|>\n${thinking}${parts.text}${renderAssistantToolCalls(parts.toolCalls, options)}`;
			i++;
			continue;
		}
		if (message.role === "toolResult") {
			const run = collectToolResultRun(messages, i);
			out += `<|observation|>\n${renderToolResponseResults(run.results)}`;
			i = run.next;
			continue;
		}
		const role = message.role === "developer" ? "system" : message.role;
		out += `<|${role}|>\n${messageContentText(message.content)}`;
		i++;
	}
	return out;
}

const definition: DialectDefinition = {
	dialect: "glm",
	prompt: dialectPrompt,
	createScanner: options => new GLMInbandScanner(options),
	renderToolCall,
	renderAssistantToolCalls,
	renderToolResults,
	renderThinking,
	renderTranscript,
};

export default definition;
