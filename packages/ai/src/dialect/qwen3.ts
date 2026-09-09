import { parseJsonWithRepair } from "@oh-my-pi/pi-utils";
import type { Message, ToolCall } from "../types";
import { asRecord, mintToolCallId, partialSuffixOverlapAny } from "./coercion";
import dialectPrompt from "./qwen3.md" with { type: "text" };
import { renderChatMlTranscript, renderToolResponseResults, stringifyJson } from "./rendering";
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

const TOOL_START_TAGS = [TOOL_OPEN] as const;
const START_TAGS = [TOOL_OPEN, THINK_OPEN] as const;
const THINK_CLOSE_TAGS = [THINK_CLOSE] as const;
const COMPLETE_NAME = /^\s*\{\s*"name"\s*:\s*("(?:\\.|[^"\\])*")/;

type State = "outside" | "thinking" | "tool";

export class Qwen3InbandScanner implements InbandScanner {
	#buffer = "";
	#state: State = "outside";
	#id = "";
	#name = "";
	#started = false;
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
		const tool = this.#buffer.indexOf(TOOL_OPEN);
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
		if (isThink) {
			this.#buffer = this.#buffer.slice(start + THINK_OPEN.length);
			this.#state = "thinking";
			this.#thinking = "";
			events.push({ type: "thinkingStart" });
			return;
		}

		this.#buffer = this.#buffer.slice(start + TOOL_OPEN.length);
		this.#state = "tool";
		this.#id = mintToolCallId();
		this.#name = "";
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
		const close = this.#buffer.indexOf(TOOL_CLOSE);
		const body = close === -1 ? this.#buffer : this.#buffer.slice(0, close);
		if (!this.#started) this.#tryStart(body, events);
		if (close === -1) {
			if (final) this.#resetTool();
			return;
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
		this.#resetTool();
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

	#tryStart(body: string, events: InbandScanEvent[]): void {
		const nameMatch = COMPLETE_NAME.exec(body);
		if (!nameMatch) return;
		let name: unknown;
		try {
			name = JSON.parse(nameMatch[1]!);
		} catch {
			return;
		}
		if (typeof name !== "string" || name.length === 0) return;
		this.#name = name;
		this.#started = true;
		events.push({ type: "toolStart", id: this.#id, name: this.#name });
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

	#resetTool(): void {
		this.#state = "outside";
		this.#id = "";
		this.#name = "";
		this.#started = false;
	}
}

function renderToolCall(call: ToolCall, _options: DialectRenderOptions = {}): string {
	return `${TOOL_OPEN}\n${stringifyJson({ name: call.name, arguments: call.arguments })}\n${TOOL_CLOSE}`;
}

function renderAssistantToolCalls(calls: readonly ToolCall[], options: DialectRenderOptions = {}): string {
	return calls.map(call => renderToolCall(call, options)).join("\n");
}

function renderToolResults(results: readonly DialectToolResult[], _options: DialectRenderOptions = {}): string {
	return renderToolResponseResults(results);
}

function renderThinking(text: string): string {
	if (!text) return "";
	return `${THINK_OPEN}\n${text}\n${THINK_CLOSE}`;
}

function renderTranscript(messages: readonly Message[], options: DialectRenderOptions = {}): string {
	return renderChatMlTranscript(messages, options, {
		toolResultRole: "user",
		renderThinking,
		renderCalls: renderAssistantToolCalls,
		renderResultsBody: renderToolResults,
	});
}

const definition: DialectDefinition = {
	dialect: "qwen3",
	prompt: dialectPrompt,
	createScanner: options => new Qwen3InbandScanner(options),
	renderToolCall,
	renderAssistantToolCalls,
	renderToolResults,
	renderThinking,
	renderTranscript,
};

export default definition;
