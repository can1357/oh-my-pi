import { classifyJsonPrefix, parseJsonWithRepair } from "@oh-my-pi/pi-utils";
import type { Message, ToolCall } from "../types";
import { parseToolCallArguments } from "../utils/tool-call-arguments";
import { asRecord, mintToolCallId, partialSuffixOverlapAny } from "./coercion";
import dialectPrompt from "./deepseek.md" with { type: "text" };
import { assistantTranscriptParts, collectToolResultRun, messageContentText, stringifyJson } from "./rendering";
import { TerminatorWait } from "./terminator-wait";
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
const DSML_INVOKE_CLOSE_FULLWIDTH = "</｜DSML｜invoke>";
const DSML_INVOKE_CLOSE_ASCII = "</|DSML|invoke>";
const DSML_PARAMETER_CLOSE_FULLWIDTH = "</｜DSML｜parameter>";
const DSML_PARAMETER_CLOSE_ASCII = "</|DSML|parameter>";

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

// Bare DSML invoke/parameter close tags with no matching open — leaked into
// visible text once a session's history is poisoned (issue #10556). Stripped in
// the `outside` state so they never reach stored assistant content and reinforce
// the model's XML-protocol mimicry. Inside a well-formed envelope these closers
// are consumed by the `dsmlInvoke`/`dsmlParam` states and never reach `outside`.
const DSML_ORPHAN_CLOSE_TOKENS = [
	DSML_INVOKE_CLOSE_FULLWIDTH,
	DSML_INVOKE_CLOSE_ASCII,
	DSML_PARAMETER_CLOSE_FULLWIDTH,
	DSML_PARAMETER_CLOSE_ASCII,
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
	...DSML_ORPHAN_CLOSE_TOKENS,
	...CONTROL_TOKENS,
] as const;
/** Outside-state tokens dropped from visible text (closers with nothing open, template control tokens). */
const OUTSIDE_DROPPED_TOKENS: Readonly<Record<string, true>> = Object.fromEntries(
	[
		DEEPSEEK_TOOL_CALLS_END,
		THINK_CLOSE,
		DSML_TOOL_CALLS_CLOSE_FULLWIDTH,
		DSML_TOOL_CALLS_CLOSE_ASCII,
		...CONTROL_TOKENS,
	].map(token => [token, true]),
);

// DeepSeek's chat template delimits special tokens with fullwidth bars (U+FF5C)
// and joins words with the tokenizer's `▁` (U+2581). Hosts that detokenize them
// into text, and models degraded by long contexts, re-spell them: `_` for `▁`
// (wholly or partly), or one bar dropped (`<tool_call_begin｜>`). Those spellings
// resolve to the canonical token wherever the grammar expects one. At least one
// fullwidth bar is required: ASCII `<|…|>` tokens belong to other templates
// (Kimi's `<|tool_call_begin|>`, Harmony), and a bare `<word>` is prose or XML.
const TEMPLATE_TOKEN_SPELLING = /<(｜?)([A-Za-z]+(?:[▁_][A-Za-z]+)*)(｜?)>/gu;
const TEMPLATE_TOKEN_SPELLING_AT_START = new RegExp(TEMPLATE_TOKEN_SPELLING.source, "uy");
// A trailing fragment that may still grow into a template token spelling.
const TEMPLATE_TOKEN_PARTIAL = /^<｜?([A-Za-z▁_]*)(｜?)$/u;
// Every accepted spelling carries at least one bar, so text without one cannot
// complete a template token; argument bodies are deferred until a bar arrives.
const TEMPLATE_TOKEN_BAR = "｜";
/**
 * Canonical template token by spelling-independent key (`tool_calls_begin`).
 * A Map, not a Record: keys come from model output, so `constructor` and friends
 * must not resolve through the prototype.
 */
const TEMPLATE_TOKEN_BY_KEY: ReadonlyMap<string, string> = new Map(
	[
		DEEPSEEK_TOOL_CALLS_BEGIN,
		DEEPSEEK_TOOL_CALLS_END,
		DEEPSEEK_TOOL_CALL_BEGIN,
		DEEPSEEK_TOOL_CALL_END,
		DEEPSEEK_TOOL_SEPARATOR,
		...CONTROL_TOKENS,
	].flatMap(token => {
		// `<｜▁pad▁｜>` and ASCII `<|EOT|>` fall outside the re-spelling grammar and stay literal.
		const name = /^<｜([A-Za-z]+(?:▁[A-Za-z]+)*)｜>$/u.exec(token)?.[1];
		return name === undefined ? [] : [[templateTokenKey(name), token] as const];
	}),
);
const TEMPLATE_TOKEN_KEYS = [...TEMPLATE_TOKEN_BY_KEY.keys()];
// `<`, both bars, the longest name, `>`.
const TEMPLATE_TOKEN_MAX_SPELLING = Math.max(...TEMPLATE_TOKEN_KEYS.map(key => key.length)) + 4;

const OUTSIDE_TEMPLATE_TOKENS: Readonly<Record<string, true>> = Object.fromEntries(
	[DEEPSEEK_TOOL_CALLS_BEGIN, DEEPSEEK_TOOL_CALLS_END, DEEPSEEK_TOOL_CALL_BEGIN, ...CONTROL_TOKENS].map(token => [
		token,
		true,
	]),
);
const SEPARATOR_TOKENS: Readonly<Record<string, true>> = { [DEEPSEEK_TOOL_SEPARATOR]: true };
// A call's arguments end at its own close or, when the model skips that close,
// at the section close or the next call's open (left in the buffer for the next
// state to consume). Only the canonical close ends them unconditionally; a
// re-spelled close and both fallbacks count once the arguments before them are
// no longer an open JSON prefix (see `#consumeArgs`).
const ARGS_TERMINATOR_TOKENS: Readonly<Record<string, true>> = {
	[DEEPSEEK_TOOL_CALL_END]: true,
	[DEEPSEEK_TOOL_CALLS_END]: true,
	[DEEPSEEK_TOOL_CALL_BEGIN]: true,
};
/** DeepSeek template tokens that structure a tool call. */
export const DEEPSEEK_TOOL_CALL_TOKENS: Readonly<Record<string, true>> = {
	[DEEPSEEK_TOOL_CALLS_BEGIN]: true,
	[DEEPSEEK_TOOL_CALLS_END]: true,
	[DEEPSEEK_TOOL_CALL_BEGIN]: true,
	[DEEPSEEK_TOOL_CALL_END]: true,
	[DEEPSEEK_TOOL_SEPARATOR]: true,
};

/** A token found in text: its canonical spelling and the text actually written. */
export interface DeepSeekTokenMatch {
	readonly token: string;
	readonly raw: string;
	readonly index: number;
}

function templateTokenKey(name: string): string {
	return name.replaceAll("▁", "_");
}

function resolveTemplateSpelling(match: RegExpExecArray): string | undefined {
	if (match[1]!.length === 0 && match[3]!.length === 0) return undefined;
	return TEMPLATE_TOKEN_BY_KEY.get(templateTokenKey(match[2]!));
}

/**
 * Find the earliest of `tokens` in `text` at or after `from`, in its canonical
 * spelling or any re-spelling described at {@link TEMPLATE_TOKEN_SPELLING}.
 */
export function findDeepSeekTemplateToken(
	text: string,
	tokens: Readonly<Record<string, true>>,
	from = 0,
): DeepSeekTokenMatch | undefined {
	TEMPLATE_TOKEN_SPELLING.lastIndex = from;
	for (let match = TEMPLATE_TOKEN_SPELLING.exec(text); match; match = TEMPLATE_TOKEN_SPELLING.exec(text)) {
		const token = resolveTemplateSpelling(match);
		if (token !== undefined && tokens[token]) return { token, raw: match[0], index: match.index };
	}
	return undefined;
}

function templateTokenAtStart(text: string): DeepSeekTokenMatch | undefined {
	TEMPLATE_TOKEN_SPELLING_AT_START.lastIndex = 0;
	const match = TEMPLATE_TOKEN_SPELLING_AT_START.exec(text);
	if (!match) return undefined;
	const token = resolveTemplateSpelling(match);
	return token === undefined ? undefined : { token, raw: match[0], index: 0 };
}

/** Length of a trailing fragment of `text` that could still complete into a template token spelling. */
function templateTokenPartialLength(text: string): number {
	const start = text.lastIndexOf("<");
	if (start === -1 || text.length - start >= TEMPLATE_TOKEN_MAX_SPELLING) return 0;
	const match = TEMPLATE_TOKEN_PARTIAL.exec(text.slice(start));
	if (!match) return 0;
	const key = templateTokenKey(match[1]!);
	const viable =
		match[2]!.length > 0 ? TEMPLATE_TOKEN_BY_KEY.has(key) : TEMPLATE_TOKEN_KEYS.some(known => known.startsWith(key));
	return viable ? text.length - start : 0;
}

const DSML_SECTION_TOKENS = [
	DSML_TOOL_CALLS_CLOSE_FULLWIDTH,
	DSML_TOOL_CALLS_CLOSE_ASCII,
	"<｜DSML｜invoke",
	"<|DSML|invoke",
] as const;
const DSML_INVOKE_TOKENS = [
	DSML_INVOKE_CLOSE_FULLWIDTH,
	DSML_INVOKE_CLOSE_ASCII,
	"<｜DSML｜parameter",
	"<|DSML|parameter",
] as const;
const DSML_PARAMETER_CLOSE_TOKENS = [DSML_PARAMETER_CLOSE_FULLWIDTH, DSML_PARAMETER_CLOSE_ASCII] as const;

// A DSML invoke/parameter opener in visible text: a call whose `tool_calls`
// wrapper is missing, so the envelope scanner never consumed it.
const BARE_DSML_OPEN = /<[｜|]DSML[｜|](?:invoke|parameter)\b/u;
const VISIBLE_TAIL_LIMIT = 48;

/**
 * Markdown code the model has written in visible text, tracked so re-spelled
 * template tokens it quotes (`` `<｜tool_calls_begin｜>` ``) stay prose. `fence`
 * is the backtick run that opened the current span or block (0 outside code),
 * `run` a backtick run still being read, `newline` whether the last
 * non-blank character was a line break.
 */
interface CodeState {
	readonly fence: number;
	readonly run: number;
	readonly newline: boolean;
}
const OUTSIDE_CODE: CodeState = { fence: 0, run: 0, newline: false };
const BACKTICK = 0x60;
const LINE_FEED = 0x0a;

/** A finished backtick run opens code, or closes it when it matches the opening run. */
function settleBacktickRun(fence: number, run: number): number {
	if (run === 0) return fence;
	if (fence === 0) return run;
	return run === fence ? 0 : fence;
}

function advanceCodeState(state: CodeState, text: string): CodeState {
	let { fence, run, newline } = state;
	for (let i = 0; i < text.length; i++) {
		const c = text.charCodeAt(i);
		if (c === BACKTICK) {
			run++;
			newline = false;
			continue;
		}
		fence = settleBacktickRun(fence, run);
		run = 0;
		if (c === LINE_FEED) {
			// A blank line ends the paragraph and any inline span left open in it.
			if (newline && fence < 3) fence = 0;
			newline = true;
		} else if (!/\s/.test(text[i]!)) {
			newline = false;
		}
	}
	return { fence, run, newline };
}

/**
 * Whether an inline span opened by a `fence`-long backtick run closes in
 * `text` before its paragraph ends. Markdown renders an unmatched run as plain
 * text, so only a closed span is code. `undefined` until the stream decides.
 */
function inlineSpanCloses(text: string, fence: number, final: boolean): boolean | undefined {
	let run = 0;
	let newline = false;
	for (let i = 0; i < text.length; i++) {
		const c = text.charCodeAt(i);
		if (c === BACKTICK) {
			run++;
			newline = false;
			continue;
		}
		if (run === fence) return true;
		run = 0;
		if (c === LINE_FEED) {
			if (newline) return false;
			newline = true;
		} else if (!/\s/.test(text[i]!)) {
			newline = false;
		}
	}
	if (!final) return undefined;
	return run === fence;
}

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
	/** Unclassified wrapper text is kept until an invoke proves it is a tool call. */
	#pendingDsmlSection: string | undefined;
	#rawBlock = "";
	#stripLeadingWhitespace = false;
	/**
	 * Visible text already carries a bare DSML `invoke`/`parameter` opener (a
	 * malformed call missing its `tool_calls` wrapper). Its closers are then kept
	 * verbatim instead of stripped as orphans, so the agent loop can find where
	 * the broken call ends and remove exactly that span, keeping prose after it.
	 */
	#bareDsmlOpenVisible = false;
	/** Last few visible characters, so a bare opener split across chunks is still seen. */
	#visibleTail = "";
	/** Markdown code state of the visible text emitted so far. */
	#code = OUTSIDE_CODE;
	readonly #closeWait = new TerminatorWait();

	constructor(options: InbandScannerOptions = {}) {
		this.#parseThinking = options.parseThinking ?? true;
	}

	feed(text: string): InbandScanEvent[] {
		if (text.length === 0) return [];
		if (this.#closeWait.absorb(text)) return [];
		this.#buffer = this.#closeWait.release(this.#buffer) + text;
		const events = this.#consume(false);
		// Arguments end at a template token in any accepted spelling, so defer
		// deltas until a bar arrives — unless a fragment already pending at the
		// tail could complete without one (`<tool_call_end` + `｜>`).
		if ((this.#state === "args" || this.#state === "legacyArgs") && templateTokenPartialLength(this.#buffer) === 0) {
			this.#closeWait.arm(TEMPLATE_TOKEN_BAR, this.#buffer);
		}
		return events;
	}

	flush(): InbandScanEvent[] {
		this.#buffer = this.#closeWait.release(this.#buffer);
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
				if (!this.#consumeSection(final, events)) break;
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
		if (final && this.#pendingDsmlSection !== undefined) {
			this.#emitText(this.#pendingDsmlSection + this.#buffer, events);
			this.#pendingDsmlSection = undefined;
			this.#buffer = "";
			this.#state = "outside";
		}
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
			const match = this.#findOutsideToken(final);
			if (typeof match === "number") {
				this.#emitText(this.#buffer.slice(0, match), events);
				this.#buffer = this.#buffer.slice(match);
				return;
			}
			if (!match) {
				const hold = final
					? 0
					: Math.max(
							partialSuffixOverlapAny(this.#buffer, OUTSIDE_TOKENS),
							templateTokenPartialLength(this.#buffer),
						);
				this.#emitText(this.#buffer.slice(0, this.#buffer.length - hold), events);
				this.#buffer = this.#buffer.slice(this.#buffer.length - hold);
				return;
			}
			this.#emitText(this.#buffer.slice(0, match.index), events);
			this.#buffer = this.#buffer.slice(match.index + match.raw.length);
			// Markup inside an open inline span proves its backticks never closed.
			if (match.raw !== match.token) {
				const fence = settleBacktickRun(this.#code.fence, this.#code.run);
				if (fence > 0 && fence < 3) this.#code = OUTSIDE_CODE;
			}
			if (match.token === DEEPSEEK_TOOL_CALLS_BEGIN) {
				this.#inToolSection = true;
				this.#state = "section";
				return;
			}
			if (match.token === DEEPSEEK_TOOL_CALL_BEGIN) {
				this.#rawBlock = match.raw;
				this.#inToolSection = false;
				this.#state = "header";
				return;
			}
			if (match.token === THINK_OPEN) {
				this.#state = "thinking";
				this.#thinking = "";
				if (this.#parseThinking) events.push({ type: "thinkingStart" });
				return;
			}
			if (match.token === DSML_TOOL_CALLS_OPEN_FULLWIDTH || match.token === DSML_TOOL_CALLS_OPEN_ASCII) {
				this.#pendingDsmlSection = match.raw;
				this.#state = "dsmlSection";
				return;
			}
			if ((DSML_ORPHAN_CLOSE_TOKENS as readonly string[]).includes(match.token)) {
				if (this.#bareDsmlOpenVisible) this.#emitText(match.raw, events);
				continue;
			}
			if (
				this.#bareDsmlOpenVisible &&
				(match.token === DSML_TOOL_CALLS_CLOSE_FULLWIDTH || match.token === DSML_TOOL_CALLS_CLOSE_ASCII)
			) {
				// Closes the malformed call: keep it as its end marker.
				this.#emitText(match.raw, events);
				this.#bareDsmlOpenVisible = false;
				continue;
			}
			if (OUTSIDE_DROPPED_TOKENS[match.token]) this.#stripLeadingWhitespace = true;
		}
	}

	#emitText(text: string, events: InbandScanEvent[]): void {
		if (text.length === 0) return;
		events.push({ type: "text", text });
		this.#visibleTail = (this.#visibleTail + text).slice(-VISIBLE_TAIL_LIMIT);
		this.#code = advanceCodeState(this.#code, text);
		if (!this.#bareDsmlOpenVisible && BARE_DSML_OPEN.test(this.#visibleTail)) this.#bareDsmlOpenVisible = true;
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

	#consumeSection(final: boolean, events: InbandScanEvent[]): boolean {
		while (this.#buffer.length > 0) {
			// Whitespace before a token is template layout and is dropped with it;
			// whitespace before prose belongs to the prose. Peek, don't skip, so a
			// chunk boundary cannot decide which.
			const indent = this.#buffer.length - this.#buffer.trimStart().length;
			const rest = this.#buffer.slice(indent);
			const lead = templateTokenAtStart(rest);
			if (lead?.token === DEEPSEEK_TOOL_CALLS_END) {
				this.#buffer = rest.slice(lead.raw.length);
				this.#inToolSection = false;
				this.#state = "outside";
				return true;
			}
			if (lead?.token === DEEPSEEK_TOOL_CALL_BEGIN) {
				this.#buffer = rest.slice(lead.raw.length);
				this.#rawBlock = lead.raw;
				this.#state = "header";
				return true;
			}
			if (lead) {
				// Any other template token here (`<｜end▁of▁sentence｜>`, a stray
				// `<｜tool▁sep｜>`) is template structure, never prose: drop it.
				this.#buffer = rest.slice(lead.raw.length);
				continue;
			}
			if (rest.length === 0 || templateTokenPartialLength(rest) === rest.length) {
				if (!final) return false;
				// The stream ended on layout whitespace or mid-token
				// (`<｜tool_call_begin｜`): markup, not prose.
				this.#buffer = "";
				return true;
			}
			// The template puts nothing but calls in a section, so anything else is
			// the model writing prose after a stray section open: keep it visible.
			// Trailing whitespace stays buffered until what follows it decides.
			const next = rest.indexOf("<", 1);
			const run = this.#buffer.slice(0, next === -1 ? this.#buffer.length : indent + next);
			const prose = run.trimEnd();
			this.#emitText(prose, events);
			this.#buffer = this.#buffer.slice(prose.length);
		}
		return final;
	}

	#consumeHeader(final: boolean, events: InbandScanEvent[]): boolean {
		const sep = findDeepSeekTemplateToken(this.#buffer, SEPARATOR_TOKENS);
		if (!sep) {
			if (final) this.#resetTool();
			return false;
		}
		const rawHead = this.#buffer.slice(0, sep.index + sep.raw.length);
		const head = this.#buffer.slice(0, sep.index).trim();
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
		let end: DeepSeekTokenMatch | undefined;
		let rawArgs = "";
		for (
			let candidate = findDeepSeekTemplateToken(this.#buffer, ARGS_TERMINATOR_TOKENS);
			candidate;
			candidate = findDeepSeekTemplateToken(
				this.#buffer,
				ARGS_TERMINATOR_TOKENS,
				candidate.index + candidate.raw.length,
			)
		) {
			rawArgs = this.#buffer.slice(0, candidate.index);
			if (this.#state === "legacyArgs") {
				const fence = rawArgs.lastIndexOf(CODE_FENCE);
				if (fence !== -1) rawArgs = rawArgs.slice(0, fence);
			}
			// The call's own close in its canonical spelling always ends it, even
			// after malformed JSON (the parser repairs or flags it). A re-spelled
			// close and the fallbacks are inferred: inside a still-open JSON string
			// or container they are argument text — e.g. a grep for the token, or
			// a write of this very file.
			const trimmed = rawArgs.trim();
			if (
				candidate.raw === DEEPSEEK_TOOL_CALL_END ||
				trimmed.length === 0 ||
				classifyJsonPrefix(trimmed) !== "prefix"
			) {
				end = candidate;
				break;
			}
		}
		if (!end) {
			if (final) this.#resetTool();
			return false;
		}
		// Only the call's own close belongs to it; a section close or the next
		// call's open stays buffered for the state that owns it.
		const consumed = end.index + (end.token === DEEPSEEK_TOOL_CALL_END ? end.raw.length : 0);
		this.#rawBlock += this.#buffer.slice(0, consumed);
		events.push({
			type: "toolEnd",
			id: this.#id,
			name: this.#name,
			arguments: this.#parseArgs(rawArgs),
			rawBlock: this.#rawBlock,
		});
		this.#buffer = this.#buffer.slice(consumed);
		this.#resetTool(this.#inToolSection ? "section" : "outside");
		return true;
	}

	#consumeDsmlSection(final: boolean, events: InbandScanEvent[]): boolean {
		const initial = this.#buffer;
		while (this.#buffer.length > 0) {
			this.#skipWhitespace();
			const close = this.#matchingDsmlClose(DSML_TOOL_CALLS_CLOSE_FULLWIDTH, DSML_TOOL_CALLS_CLOSE_ASCII);
			if (close) {
				if (this.#pendingDsmlSection !== undefined) {
					this.#emitText(
						this.#pendingDsmlSection + initial.slice(0, initial.length - this.#buffer.length) + close,
						events,
					);
					this.#pendingDsmlSection = undefined;
				}
				this.#buffer = this.#buffer.slice(close.length);
				this.#state = "outside";
				return true;
			}
			const invoke = this.#matchDsmlOpen("invoke");
			if (invoke) {
				this.#pendingDsmlSection = undefined;
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
					break;
				if (partialSuffixOverlapAny(this.#buffer, DSML_SECTION_TOKENS) === this.#buffer.length) break;
			}
			if (this.#buffer.length === 0) break;
			this.#buffer = this.#buffer.slice(1);
		}
		if (this.#pendingDsmlSection !== undefined) {
			this.#pendingDsmlSection += initial.slice(0, initial.length - this.#buffer.length);
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
		return asRecord(parseToolCallArguments(trimmed));
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

	/**
	 * Earliest outside-state token: a literal (`<think>`, DSML tags, canonical
	 * template tokens) or a re-spelled template token. Ties keep the literal.
	 * A re-spelled token inside code the model quoted is prose about the token,
	 * not markup; canonical spellings keep their long-standing handling. An
	 * inline span is code only once its closing run arrives, so a token after an
	 * unclosed run returns its index to hold from until the paragraph decides.
	 */
	#findOutsideToken(final: boolean): DeepSeekTokenMatch | number | undefined {
		const literal = findEarliestToken(this.#buffer, OUTSIDE_TOKENS);
		let template = findDeepSeekTemplateToken(this.#buffer, OUTSIDE_TEMPLATE_TOKENS);
		while (template && template.raw !== template.token && (!literal || template.index < literal.index)) {
			const code = advanceCodeState(this.#code, this.#buffer.slice(0, template.index));
			const fence = settleBacktickRun(code.fence, code.run);
			if (fence === 0) break;
			if (fence < 3) {
				const closes = inlineSpanCloses(this.#buffer.slice(template.index + template.raw.length), fence, final);
				if (closes === undefined) return template.index;
				if (!closes) break;
			}
			template = findDeepSeekTemplateToken(
				this.#buffer,
				OUTSIDE_TEMPLATE_TOKENS,
				template.index + template.raw.length,
			);
		}
		if (template && (!literal || template.index < literal.index)) return template;
		return literal && { token: literal.token, raw: literal.token, index: literal.index };
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
