import { parseJsonWithRepair } from "@oh-my-pi/pi-utils";
import type { Message, ToolCall } from "../types";
import { asRecord, normalizeKimiFunctionName, partialSuffixOverlapAny } from "./coercion";
import dialectPrompt from "./kimi.md" with { type: "text" };
import { assistantTranscriptParts, collectToolResultRun, messageContentText, stringifyJson } from "./rendering";
import type {
	DialectDefinition,
	DialectRenderOptions,
	DialectToolResult,
	InbandScanEvent,
	InbandScanner,
	InbandScannerOptions,
} from "./types";

export const KIMI_SECTION_BEGIN = "<|tool_calls_section_begin|>";
export const KIMI_SECTION_END = "<|tool_calls_section_end|>";
export const KIMI_CALL_BEGIN = "<|tool_call_begin|>";
export const KIMI_CALL_END = "<|tool_call_end|>";
export const KIMI_ARG_BEGIN = "<|tool_call_argument_begin|>";

const TOKENS = [KIMI_SECTION_BEGIN, KIMI_SECTION_END, KIMI_CALL_BEGIN, KIMI_CALL_END, KIMI_ARG_BEGIN] as const;
const THINK_OPEN = "<think>";
const THINK_CLOSE = "</think>";
const TOKENS_THINK = [
	KIMI_SECTION_BEGIN,
	KIMI_SECTION_END,
	KIMI_CALL_BEGIN,
	KIMI_CALL_END,
	KIMI_ARG_BEGIN,
	THINK_OPEN,
] as const;

type State = "outside" | "section" | "header" | "args" | "thinking";

export class KimiInbandScanner implements InbandScanner {
	#buffer = "";
	#state: State = "outside";
	#id = "";
	#name = "";
	#rawBlock = "";
	#thinking = "";
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
		while (this.#buffer.length > 0) {
			if (this.#state === "outside") {
				if (!this.#consumeOutside(final, events)) break;
				continue;
			}

			if (this.#state === "thinking") {
				if (!this.#consumeThinking(final, events)) break;
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

			if (!this.#consumeArgs(final, events)) break;
		}
		if (final && this.#state === "thinking") this.#endThinking(events);
		return events;
	}

	#consumeOutside(final: boolean, events: InbandScanEvent[]): boolean {
		const tokenStart = this.#nextTokenIndex();
		const thinkStart = this.#parseThinking ? this.#buffer.indexOf(THINK_OPEN) : -1;
		let start = tokenStart;
		if (thinkStart !== -1 && (start === -1 || thinkStart < start)) start = thinkStart;
		if (start === -1) {
			const tags = this.#parseThinking ? TOKENS_THINK : TOKENS;
			const hold = final ? 0 : partialSuffixOverlapAny(this.#buffer, tags);
			const emitEnd = this.#buffer.length - hold;
			if (emitEnd > 0) events.push({ type: "text", text: this.#buffer.slice(0, emitEnd) });
			this.#buffer = this.#buffer.slice(emitEnd);
			return false;
		}

		if (start > 0) events.push({ type: "text", text: this.#buffer.slice(0, start) });
		this.#buffer = this.#buffer.slice(start);
		if (this.#parseThinking && this.#buffer.startsWith(THINK_OPEN)) {
			this.#buffer = this.#buffer.slice(THINK_OPEN.length);
			this.#thinking = "";
			events.push({ type: "thinkingStart" });
			this.#state = "thinking";
			return true;
		}
		const token = this.#tokenAtStart();
		if (!token) return false;
		this.#buffer = this.#buffer.slice(token.length);
		if (token === KIMI_SECTION_BEGIN) this.#state = "section";
		else events.push({ type: "text", text: token });
		return true;
	}

	#consumeThinking(final: boolean, events: InbandScanEvent[]): boolean {
		const close = this.#buffer.indexOf(THINK_CLOSE);
		if (close === -1) {
			const hold = final ? 0 : partialSuffixOverlapAny(this.#buffer, [THINK_CLOSE]);
			this.#emitThinking(this.#buffer.slice(0, this.#buffer.length - hold), events);
			this.#buffer = this.#buffer.slice(this.#buffer.length - hold);
			if (final) {
				this.#endThinking(events);
				this.#state = "outside";
			}
			return false;
		}
		this.#emitThinking(this.#buffer.slice(0, close), events);
		this.#buffer = this.#buffer.slice(close + THINK_CLOSE.length);
		this.#endThinking(events);
		this.#state = "outside";
		return true;
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

	#consumeSection(final: boolean): boolean {
		this.#skipWhitespace();
		if (this.#buffer.length === 0) return false;

		const token = this.#tokenAtStart();
		if (token === KIMI_SECTION_END) {
			this.#buffer = this.#buffer.slice(KIMI_SECTION_END.length);
			this.#state = "outside";
			return true;
		}
		if (token === KIMI_CALL_BEGIN) {
			this.#buffer = this.#buffer.slice(KIMI_CALL_BEGIN.length);
			this.#state = "header";
			return true;
		}
		if (token) {
			this.#buffer = this.#buffer.slice(token.length);
			return true;
		}

		if (!final && partialSuffixOverlapAny(this.#buffer, TOKENS) === this.#buffer.length) return false;
		this.#buffer = this.#buffer.slice(1);
		return true;
	}

	#consumeHeader(final: boolean, events: InbandScanEvent[]): boolean {
		const sep = this.#buffer.indexOf(KIMI_ARG_BEGIN);
		if (sep === -1) {
			if (final) this.#dropBufferedCall();
			return false;
		}

		const rawHeader = this.#buffer.slice(0, sep);
		this.#id = rawHeader.trim();
		this.#name = normalizeKimiFunctionName(this.#id);
		this.#rawBlock = `${KIMI_CALL_BEGIN}${rawHeader}${KIMI_ARG_BEGIN}`;
		events.push({ type: "toolStart", id: this.#id, name: this.#name });
		this.#buffer = this.#buffer.slice(sep + KIMI_ARG_BEGIN.length);
		this.#state = "args";
		return true;
	}

	#consumeArgs(final: boolean, events: InbandScanEvent[]): boolean {
		const end = this.#buffer.indexOf(KIMI_CALL_END);
		if (end === -1) {
			if (final) this.#dropBufferedCall();
			return false;
		}

		const rawArgsBlock = this.#buffer.slice(0, end);
		const rawArgs = rawArgsBlock.trim();
		events.push({
			type: "toolEnd",
			id: this.#id,
			name: this.#name,
			arguments: this.#parseArgs(rawArgs),
			rawBlock: `${this.#rawBlock}${rawArgsBlock}${KIMI_CALL_END}`,
		});
		this.#buffer = this.#buffer.slice(end + KIMI_CALL_END.length);
		this.#resetCall();
		this.#state = "section";
		return true;
	}

	#parseArgs(rawArgs: string): Record<string, unknown> {
		if (rawArgs.length === 0) return {};
		try {
			return asRecord(parseJsonWithRepair<unknown>(rawArgs));
		} catch {
			return {};
		}
	}

	#nextTokenIndex(): number {
		let best = -1;
		for (const token of TOKENS) {
			const index = this.#buffer.indexOf(token);
			if (index !== -1 && (best === -1 || index < best)) best = index;
		}
		return best;
	}

	#tokenAtStart(): string | undefined {
		for (const token of TOKENS) {
			if (this.#buffer.startsWith(token)) return token;
		}
		return undefined;
	}

	#skipWhitespace(): void {
		let i = 0;
		while (i < this.#buffer.length && isWhitespace(this.#buffer.charCodeAt(i))) i++;
		if (i > 0) this.#buffer = this.#buffer.slice(i);
	}

	#dropBufferedCall(): void {
		this.#buffer = "";
		this.#resetCall();
		this.#state = "outside";
	}

	#resetCall(): void {
		this.#id = "";
		this.#name = "";
		this.#rawBlock = "";
	}
}

function isWhitespace(cp: number): boolean {
	return cp === 0x20 || cp === 0x09 || cp === 0x0a || cp === 0x0d || cp === 0x0b || cp === 0x0c;
}

function renderToolCall(call: ToolCall, _options?: DialectRenderOptions): string {
	return kimiInvocation(call, 0);
}

function kimiInvocation(call: ToolCall, index: number): string {
	return `${KIMI_CALL_BEGIN}${kimiCallId(call.name, call.id, index)}${KIMI_ARG_BEGIN}${stringifyJson(call.arguments)}${KIMI_CALL_END}`;
}

function renderAssistantToolCalls(calls: readonly ToolCall[], _options?: DialectRenderOptions): string {
	if (calls.length === 0) return "";
	const body = calls.map((call, index) => kimiInvocation(call, index)).join("");
	return `${KIMI_SECTION_BEGIN}${body}${KIMI_SECTION_END}`;
}

function renderToolResults(results: readonly DialectToolResult[], _options?: DialectRenderOptions): string {
	return results
		.map(result =>
			kimiTurn(
				"system",
				result.name,
				`## Return of ${kimiCallId(result.name, result.id, result.index)}\n${result.text}`,
			),
		)
		.join("");
}

function renderThinking(text: string): string {
	if (!text) return "";
	return `${THINK_OPEN}\n${text}\n${THINK_CLOSE}`;
}

function renderTranscript(messages: readonly Message[], _options?: DialectRenderOptions): string {
	let out = "";
	for (let i = 0; i < messages.length;) {
		const message = messages[i]!;
		if (message.role === "assistant") {
			const parts = assistantTranscriptParts(message);
			out += kimiTurn(
				"assistant",
				"assistant",
				`${renderThinking(parts.thinking)}${parts.text}${renderAssistantToolCalls(parts.toolCalls)}`,
			);
			i++;
			continue;
		}
		if (message.role === "toolResult") {
			const run = collectToolResultRun(messages, i);
			out += renderToolResults(run.results);
			i = run.next;
			continue;
		}
		const name = message.role === "developer" ? "system" : message.role;
		const role = message.role === "developer" ? "system" : message.role;
		out += kimiTurn(role, name, messageContentText(message.content));
		i++;
	}
	return out;
}

function kimiCallId(name: string, id: string, index: number): string {
	const trimmed = id.trim();
	return trimmed.startsWith("functions.") ? trimmed : `functions.${name}:${index}`;
}

function kimiTurn(role: "assistant" | "system" | "user", name: string, body: string): string {
	return `<|im_${role}|>${name}<|im_middle|>${body}<|im_end|>`;
}

const definition: DialectDefinition = {
	dialect: "kimi",
	prompt: dialectPrompt,
	createScanner: options => new KimiInbandScanner(options),
	renderToolCall,
	renderAssistantToolCalls,
	renderToolResults,
	renderThinking,
	renderTranscript,
};

export default definition;
