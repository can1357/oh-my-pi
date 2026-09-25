import { parseJsonWithRepair } from "@oh-my-pi/pi-utils";
import type { Message, ToolCall } from "../types";
import { asRecord, mintToolCallId, partialSuffixOverlapAny } from "./coercion";
import dialectPrompt from "./harmony.md" with { type: "text" };
import {
	assistantTranscriptParts,
	collectToolResultRun,
	harmonyRecipient,
	messageContentText,
	stringifyJson,
} from "./rendering";
import type {
	DialectDefinition,
	DialectRenderOptions,
	DialectToolResult,
	InbandScanEvent,
	InbandScanner,
} from "./types";

const START = "<|start|>";
const END = "<|end|>";
const MESSAGE = "<|message|>";
const CHANNEL = "<|channel|>";
const CONSTRAIN = "<|constrain|>";
const RETURN = "<|return|>";
const CALL = "<|call|>";

const ALL_TOKENS = [START, END, MESSAGE, CHANNEL, CONSTRAIN, RETURN, CALL] as const;
const BODY_TOKENS = [END, CALL, RETURN, START, CHANNEL, MESSAGE, CONSTRAIN] as const;

type State = "outside" | "header" | "body";
type BodyMode = "text" | "thinking" | "tool" | "skip";

interface HeaderFields {
	role: string;
	channel: string;
	recipient: string;
}

interface TokenMatch {
	index: number;
	token: string;
}

export class HarmonyInbandScanner implements InbandScanner {
	#buffer = "";
	#state: State = "outside";
	#mode: BodyMode = "skip";
	#id = "";
	#name = "";
	#toolArgs = "";
	#thinking = "";
	#rawBlock = "";

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
				const next = findNextToken(this.#buffer, ALL_TOKENS);
				if (!next) {
					const hold = final ? 0 : partialSuffixOverlapAny(this.#buffer, ALL_TOKENS);
					const emit = this.#buffer.slice(0, this.#buffer.length - hold);
					if (emit.length > 0) events.push({ type: "text", text: emit });
					this.#buffer = this.#buffer.slice(this.#buffer.length - hold);
					break;
				}

				if (next.index > 0) events.push({ type: "text", text: this.#buffer.slice(0, next.index) });
				if (next.token === START) {
					this.#rawBlock = START;
					this.#buffer = this.#buffer.slice(next.index + START.length);
					this.#state = "header";
					continue;
				}
				if (next.token === CHANNEL) {
					this.#rawBlock = "";
					this.#buffer = this.#buffer.slice(next.index);
					this.#state = "header";
					continue;
				}

				this.#buffer = this.#buffer.slice(next.index + next.token.length);
				continue;
			}

			if (this.#state === "header") {
				const message = this.#buffer.indexOf(MESSAGE);
				if (message === -1) {
					if (final) this.#resetAll();
					break;
				}

				const rawHeader = this.#buffer.slice(0, message);
				this.#rawBlock += this.#buffer.slice(0, message + MESSAGE.length);
				const header = this.#parseHeader(rawHeader);
				this.#buffer = this.#buffer.slice(message + MESSAGE.length);
				this.#enterBody(header, events);
				continue;
			}

			const next = findNextToken(this.#buffer, BODY_TOKENS);
			if (!next) {
				const hold = final ? 0 : partialSuffixOverlapAny(this.#buffer, BODY_TOKENS);
				this.#emitBody(this.#buffer.slice(0, this.#buffer.length - hold), events);
				this.#buffer = this.#buffer.slice(this.#buffer.length - hold);
				if (final && this.#buffer.length === 0) {
					this.#finishBody(events);
					this.#state = "outside";
				}
				break;
			}

			this.#emitBody(this.#buffer.slice(0, next.index), events);
			if (next.token === END || next.token === CALL || next.token === RETURN) {
				if (this.#mode === "tool") this.#rawBlock += next.token;
				this.#buffer = this.#buffer.slice(next.index + next.token.length);
				this.#finishBody(events);
				this.#state = "outside";
				continue;
			}

			if (next.token === START) {
				this.#finishBody(events);
				this.#rawBlock = START;
				this.#buffer = this.#buffer.slice(next.index + START.length);
				this.#state = "header";
				continue;
			}
			if (next.token === CHANNEL) {
				this.#finishBody(events);
				this.#rawBlock = "";
				this.#buffer = this.#buffer.slice(next.index);
				this.#state = "header";
				continue;
			}

			if (this.#mode === "tool") this.#rawBlock += next.token;
			this.#buffer = this.#buffer.slice(next.index + next.token.length);
		}
		return events;
	}

	#enterBody(header: HeaderFields, events: InbandScanEvent[]): void {
		this.#clearBody(false);
		this.#state = "body";

		const assistantMessage = header.role === "" || header.role === "assistant";
		if (!assistantMessage) {
			this.#mode = "skip";
			return;
		}

		if (header.recipient.length > 0 && header.recipient !== "assistant") {
			this.#mode = "tool";
			this.#id = mintToolCallId();
			this.#name = header.recipient.startsWith("functions.")
				? header.recipient.slice("functions.".length)
				: header.recipient;
			events.push({ type: "toolStart", id: this.#id, name: this.#name });
			return;
		}

		if (header.channel === "analysis") {
			this.#mode = "thinking";
			events.push({ type: "thinkingStart" });
			return;
		}

		this.#mode = "text";
	}

	#emitBody(chunk: string, events: InbandScanEvent[]): void {
		if (chunk.length === 0) return;
		if (this.#mode === "text") {
			events.push({ type: "text", text: chunk });
			return;
		}
		if (this.#mode === "thinking") {
			this.#thinking += chunk;
			events.push({ type: "thinkingDelta", delta: chunk });
			return;
		}
		if (this.#mode === "tool") {
			this.#rawBlock += chunk;
			this.#toolArgs += chunk;
		}
	}

	#finishBody(events: InbandScanEvent[]): void {
		if (this.#mode === "thinking") {
			events.push({ type: "thinkingEnd", thinking: this.#thinking });
		} else if (this.#mode === "tool" && this.#name.length > 0) {
			events.push({
				type: "toolEnd",
				id: this.#id,
				name: this.#name,
				arguments: this.#parseArgs(),
				rawBlock: this.#rawBlock,
			});
		}
		this.#clearBody();
	}

	#parseHeader(rawHeader: string): HeaderFields {
		const channelIndex = rawHeader.indexOf(CHANNEL);
		const rolePart = channelIndex === -1 ? rawHeader : rawHeader.slice(0, channelIndex);
		const channelPart = channelIndex === -1 ? "" : rawHeader.slice(channelIndex + CHANNEL.length);
		return {
			role: firstWord(rolePart),
			channel: firstWord(channelPart),
			recipient: parseRecipient(rawHeader),
		};
	}

	#parseArgs(): Record<string, unknown> {
		const raw = this.#toolArgs.trim();
		if (raw.length === 0) return {};
		try {
			return asRecord(parseJsonWithRepair<unknown>(raw));
		} catch {
			return {};
		}
	}

	#clearBody(resetRawBlock = true): void {
		this.#mode = "skip";
		this.#id = "";
		this.#name = "";
		this.#toolArgs = "";
		this.#thinking = "";
		if (resetRawBlock) this.#rawBlock = "";
	}

	#resetAll(): void {
		this.#buffer = "";
		this.#state = "outside";
		this.#clearBody();
	}
}

function findNextToken(text: string, tokens: readonly string[]): TokenMatch | undefined {
	let match: TokenMatch | undefined;
	for (const token of tokens) {
		const index = text.indexOf(token);
		if (index !== -1 && (!match || index < match.index)) match = { index, token };
	}
	return match;
}

function firstWord(text: string): string {
	const trimmed = text.trimStart();
	let end = 0;
	while (end < trimmed.length) {
		const ch = trimmed[end]!;
		if (ch === "<" || /\s/.test(ch)) break;
		end++;
	}
	return trimmed.slice(0, end);
}

function parseRecipient(header: string): string {
	const match = /(?:^|\s)to=([^\s<]+)/.exec(header);
	return match?.[1] ?? "";
}

function renderToolCall(call: ToolCall, _options: DialectRenderOptions = {}): string {
	return `${START}assistant${CHANNEL}commentary to=${harmonyRecipient(call.name)}${MESSAGE}${stringifyJson(call.arguments)}${CALL}`;
}

function renderAssistantToolCalls(calls: readonly ToolCall[], options: DialectRenderOptions = {}): string {
	let out = "";
	for (const call of calls) out += renderToolCall(call, options);
	return out;
}

function renderToolResults(results: readonly DialectToolResult[]): string {
	let out = "";
	for (const result of results) {
		out += `${START}${harmonyRecipient(result.name)} to=assistant${CHANNEL}commentary${MESSAGE}${result.text}${END}`;
	}
	return out;
}

function renderThinking(text: string): string {
	if (!text) return "";
	return `${START}assistant${CHANNEL}analysis${MESSAGE}${text}${END}`;
}

function renderTranscript(messages: readonly Message[], options: DialectRenderOptions = {}): string {
	let out = "";
	for (let i = 0; i < messages.length;) {
		const message = messages[i]!;
		if (message.role === "assistant") {
			const parts = assistantTranscriptParts(message);
			let emitted = false;
			if (parts.thinking) {
				out += renderThinking(parts.thinking);
				emitted = true;
			}
			if (parts.text) {
				out += `${START}assistant${CHANNEL}final${MESSAGE}${parts.text}${END}`;
				emitted = true;
			}
			if (parts.toolCalls.length > 0) {
				out += renderAssistantToolCalls(parts.toolCalls, options);
				emitted = true;
			}
			if (!emitted) out += `${START}assistant${CHANNEL}final${MESSAGE}${END}`;
			i++;
			continue;
		}
		if (message.role === "toolResult") {
			const run = collectToolResultRun(messages, i);
			out += renderToolResults(run.results);
			i = run.next;
			continue;
		}
		out += `${START}${message.role}${MESSAGE}${messageContentText(message.content)}${END}`;
		i++;
	}
	return out;
}

const definition: DialectDefinition = {
	dialect: "harmony",
	prompt: dialectPrompt,
	createScanner: () => new HarmonyInbandScanner(),
	renderToolCall,
	renderAssistantToolCalls,
	renderToolResults,
	renderThinking,
	renderTranscript,
};

export default definition;
