import { parseJsonWithRepair, parseStreamingJson } from "@oh-my-pi/pi-utils";
import type { Message, ToolCall } from "../types";
import { asRecord, mintToolCallId, partialSuffixOverlapAny } from "./coercion";
import dialectPrompt from "./hermes.md" with { type: "text" };
import { renderChatMlTranscript, renderDelimitedThinking, renderToolResponseResults, stringifyJson } from "./rendering";
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
const THINK_OPEN = "<think>";
const THINK_CLOSE = "</think>";
const HOLD_TAGS = [TOOL_OPEN, TOOL_CLOSE, THINK_OPEN, THINK_CLOSE] as const;

export class HermesInbandScanner implements InbandScanner {
	#buffer = "";
	#inside = false;
	#id = "";
	#name = "";
	#started = false;
	#parseThinking: boolean;
	#inThinking = false;
	#thinking = "";

	constructor(options: InbandScannerOptions = {}) {
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
			if (this.#inThinking) {
				const closeThink = this.#buffer.indexOf(THINK_CLOSE);
				if (closeThink === -1) {
					const hold = final ? 0 : partialSuffixOverlapAny(this.#buffer, [THINK_CLOSE]);
					const thinking = this.#buffer.slice(0, this.#buffer.length - hold);
					if (thinking.length > 0) {
						this.#thinking += thinking;
						events.push({ type: "thinkingDelta", delta: thinking });
					}
					this.#buffer = this.#buffer.slice(this.#buffer.length - hold);
					if (final) {
						events.push({ type: "thinkingEnd", thinking: this.#thinking });
						this.#thinking = "";
						this.#inThinking = false;
					}
					break;
				}
				const thinking = this.#buffer.slice(0, closeThink);
				if (thinking.length > 0) {
					this.#thinking += thinking;
					events.push({ type: "thinkingDelta", delta: thinking });
				}
				this.#buffer = this.#buffer.slice(closeThink + THINK_CLOSE.length);
				events.push({ type: "thinkingEnd", thinking: this.#thinking });
				this.#thinking = "";
				this.#inThinking = false;
				continue;
			}

			if (!this.#inside) {
				const open = this.#buffer.indexOf(TOOL_OPEN);
				const think = this.#parseThinking ? this.#buffer.indexOf(THINK_OPEN) : -1;
				const start = open === -1 ? think : think === -1 ? open : Math.min(open, think);
				if (start === -1) {
					const hold = final ? 0 : partialSuffixOverlapAny(this.#buffer, HOLD_TAGS);
					const emit = this.#buffer.slice(0, this.#buffer.length - hold);
					if (emit.length > 0) events.push({ type: "text", text: emit });
					this.#buffer = this.#buffer.slice(this.#buffer.length - hold);
					break;
				}
				if (start > 0) events.push({ type: "text", text: this.#buffer.slice(0, start) });
				if (start === think) {
					this.#buffer = this.#buffer.slice(start + THINK_OPEN.length);
					this.#inThinking = true;
					this.#thinking = "";
					events.push({ type: "thinkingStart" });
					continue;
				}
				this.#buffer = this.#buffer.slice(start + TOOL_OPEN.length);
				this.#inside = true;
				this.#id = mintToolCallId();
				this.#name = "";
				this.#started = false;
				continue;
			}

			const close = this.#buffer.indexOf(TOOL_CLOSE);
			const body = close === -1 ? this.#buffer : this.#buffer.slice(0, close);
			if (!this.#started) this.#tryStart(body, events);
			if (close === -1) {
				if (final) this.#reset();
				break;
			}

			const parsed = this.#parseCall(body);
			if (parsed) {
				if (!this.#started) {
					events.push({ type: "toolStart", id: this.#id, name: parsed.name });
					this.#started = true;
				}
				events.push({
					type: "toolEnd",
					id: this.#id,
					name: parsed.name,
					arguments: parsed.arguments,
					rawBlock: `${TOOL_OPEN}${body}${TOOL_CLOSE}`,
				});
			}
			this.#buffer = this.#buffer.slice(close + TOOL_CLOSE.length);
			this.#reset();
		}
		return events;
	}

	#tryStart(body: string, events: InbandScanEvent[]): void {
		try {
			const partial = parseStreamingJson<{ name?: unknown }>(body);
			if (typeof partial.name !== "string" || partial.name.length === 0) return;
			this.#name = partial.name;
			this.#started = true;
			events.push({ type: "toolStart", id: this.#id, name: this.#name });
		} catch {
			// Partial JSON is allowed until the closing tag arrives.
		}
	}

	#parseCall(body: string): { name: string; arguments: Record<string, unknown> } | undefined {
		try {
			const parsed = parseJsonWithRepair<{ name?: unknown; arguments?: unknown }>(body.trim());
			if (typeof parsed.name !== "string" || parsed.name.length === 0) return undefined;
			let args = parsed.arguments;
			if (typeof args === "string") {
				try {
					args = parseJsonWithRepair<unknown>(args);
				} catch {
					args = {};
				}
			}
			return { name: parsed.name, arguments: asRecord(args) };
		} catch {
			return undefined;
		}
	}

	#reset(): void {
		this.#inside = false;
		this.#id = "";
		this.#name = "";
		this.#started = false;
	}
}

function renderToolCall(call: ToolCall, _options: DialectRenderOptions = {}): string {
	return `<tool_call>\n${stringifyJson({ name: call.name, arguments: call.arguments })}\n</tool_call>`;
}

function renderAssistantToolCalls(calls: readonly ToolCall[], options: DialectRenderOptions = {}): string {
	return calls.map(call => renderToolCall(call, options)).join("\n");
}

function renderToolResults(results: readonly DialectToolResult[], _options: DialectRenderOptions = {}): string {
	return renderToolResponseResults(results);
}

function renderThinking(text: string): string {
	return renderDelimitedThinking(THINK_OPEN, THINK_CLOSE, text);
}

function renderTranscript(messages: readonly Message[], options: DialectRenderOptions = {}): string {
	return renderChatMlTranscript(messages, options, {
		toolResultRole: "tool",
		renderThinking,
		renderCalls: renderAssistantToolCalls,
		renderResultsBody: renderToolResults,
	});
}

const definition: DialectDefinition = {
	dialect: "hermes",
	prompt: dialectPrompt,
	createScanner: options => new HermesInbandScanner(options),
	renderToolCall,
	renderAssistantToolCalls,
	renderToolResults,
	renderThinking,
	renderTranscript,
};

export default definition;
