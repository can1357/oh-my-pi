import type {
	AssistantMessage,
	AssistantMessageEventStream as AssistantMessageEventStreamType,
	TextContent,
	ThinkingContent,
	ToolCall,
} from "../types";
import { AssistantMessageEventStream } from "../utils/event-stream";
import { buildStringArgsResolver } from "./coercion";
import { createInbandScanner } from "./factory";
import type { Dialect, InbandScanEvent, InbandScanner, InbandTool } from "./types";

const RESPONSE_OPEN_TOKENS: Record<Dialect, readonly string[]> = {
	glm: ["<tool_response>"],
	hermes: ["<tool_response>"],
	kimi: ["<|im_system|>"],
	xml: ["<tool_response>"],
	anthropic: ["<function_results>", "<tool_response>"],
	minimax: ["<function_results>", "<tool_response>"],
	deepseek: ["<｜tool▁outputs▁begin｜>", "<｜tool▁output▁begin｜>"],
	harmony: ["<|start|>functions."],
	pi: ["‡‡"],
	qwen3: ["<tool_response>"],
	gemini: ["```tool_outputs"],
	gemma: ["<|tool_response>"],
};

function firstTokenIndex(text: string, tokens: readonly string[]): number {
	let best = -1;
	for (const token of tokens) {
		const index = text.indexOf(token);
		if (index !== -1 && (best === -1 || index < best)) best = index;
	}
	return best;
}

type OpenText = { index: number } | undefined;
type OpenThinking = { index: number; text: string } | undefined;

export function parseInbandToolMessage(
	message: AssistantMessage,
	dialect: Dialect,
	tools: readonly InbandTool[],
): AssistantMessage {
	const projector = new InbandStreamProjector(new AssistantMessageEventStream(), tools, dialect, message, false);
	for (const block of message.content) {
		if (block.type === "text") projector.text(block.text);
		else projector.keep(block);
	}
	return projector.finish(message, false);
}

export function wrapInbandToolStream(
	inner: AssistantMessageEventStreamType,
	tools: readonly InbandTool[],
	dialect: Dialect,
	onAbort?: () => void,
	abortOnFabrication = true,
): AssistantMessageEventStreamType {
	const out = new AssistantMessageEventStream();
	void (async () => {
		try {
			let projector: InbandStreamProjector | undefined;
			for await (const event of inner) {
				switch (event.type) {
					case "start":
						projector = new InbandStreamProjector(out, tools, dialect, event.partial, true);
						break;
					case "thinking_start":
						projector?.thinkingStart();
						break;
					case "thinking_delta":
						projector?.thinkingDelta(event.delta);
						break;
					case "thinking_end":
						projector?.thinkingEnd();
						break;
					case "text_delta":
						// `text()` returns true once the model starts fabricating its own
						// tool result. In abort mode we cut the turn immediately so the
						// provider stops spending tokens on the hallucinated continuation; in
						// discard mode we keep draining the stream — the projector is now
						// stopped, so `finish` (on `done`) drops everything past the boundary.
						if (projector?.text(event.delta) && abortOnFabrication) {
							projector.finish(event.partial, true);
							onAbort?.();
							return;
						}
						break;
					case "toolcall_start": {
						// Provider emitted a native structured tool call (e.g. Gemini via
						// OpenRouter still returns `functionCall` parts even when owned mode
						// sends no `tools`). Forward the native lifecycle live so the UI
						// streams it; otherwise the turn loses its only actionable content
						// and the loop retries forever on a reasoning-only message. The
						// projector ignores nameless "ghost" parts and de-conflicts with the
						// in-band channel.
						const src = event.partial.content[event.contentIndex];
						projector?.nativeToolStart(event.contentIndex, src?.type === "toolCall" ? src.name : "");
						break;
					}
					case "toolcall_delta":
						projector?.nativeToolDelta(event.contentIndex, event.delta);
						break;
					case "toolcall_end":
						projector?.nativeToolEnd(event.contentIndex, event.toolCall);
						break;
					case "done":
						projector ??= new InbandStreamProjector(out, tools, dialect, event.message, true);
						projector.finish(event.message, true);
						return;
					case "error":
						out.push(event);
						return;
				}
			}
		} catch (err) {
			out.fail(err);
		}
	})();
	return out;
}

class InbandStreamProjector {
	readonly #out: AssistantMessageEventStream;
	readonly #scanner: InbandScanner;
	readonly #emitEvents: boolean;
	readonly #responseOpenTokens: readonly string[];
	readonly #responseOverlapLength: number;
	#partial: AssistantMessage;
	#text: OpenText;
	#thinking: OpenThinking;
	#toolBlocks = new Map<string, { index: number; block: ToolCall; currentKey?: string; rawValue: string }>();
	#fedLen = 0;
	#stopped = false;
	#responsePending = "";
	// Provider-native tool calls forwarded live (e.g. Gemini still returns
	// `functionCall` parts under owned mode), keyed by the inner stream's
	// `contentIndex`. `#toolChannel` records which channel produced the turn's
	// first real call so the other is dropped — no double-dispatch, and no
	// guessing from emptiness. Nameless "ghost" parts never lock a channel.
	#nativeBlocks = new Map<number, { index: number; block: ToolCall }>();
	#toolChannel: "native" | "inband" | undefined;

	constructor(
		out: AssistantMessageEventStream,
		tools: readonly InbandTool[],
		dialect: Dialect,
		seed: AssistantMessage,
		emitEvents: boolean,
	) {
		this.#out = out;
		this.#emitEvents = emitEvents;
		this.#scanner = createInbandScanner(dialect, {
			tools,
			stringArgs: buildStringArgsResolver(tools),
			parseThinking: true,
		});
		this.#responseOpenTokens = RESPONSE_OPEN_TOKENS[dialect];
		this.#responseOverlapLength = Math.max(0, ...this.#responseOpenTokens.map(token => token.length - 1));
		this.#partial = { ...seed, content: [] };
		if (emitEvents) this.#out.push({ type: "start", partial: this.#partial });
	}

	keep(block: AssistantMessage["content"][number]): void {
		this.#closeText();
		this.#closeThinking();
		this.#partial.content.push(block);
	}

	// Forward a native tool call's lifecycle live. `name` comes from the inner
	// stream's partial (set at start for well-behaved providers). Empty `name`
	// means a not-yet-identified or "ghost" call — skip until `nativeToolEnd`
	// can confirm. Once the in-band channel owns the turn, native calls are
	// dropped to avoid double-dispatch.
	nativeToolStart(srcIndex: number, name: string): void {
		if (this.#stopped || !name || this.#toolChannel === "inband") return;
		this.#toolChannel = "native";
		this.#closeText();
		this.#closeThinking();
		const block: ToolCall = { type: "toolCall", id: "", name, arguments: {} };
		this.#partial.content.push(block);
		const index = this.#partial.content.length - 1;
		this.#nativeBlocks.set(srcIndex, { index, block });
		if (this.#emitEvents) this.#out.push({ type: "toolcall_start", contentIndex: index, partial: this.#partial });
	}

	nativeToolDelta(srcIndex: number, delta: string): void {
		if (this.#stopped) return;
		const entry = this.#nativeBlocks.get(srcIndex);
		if (!entry) return;
		if (this.#emitEvents)
			this.#out.push({ type: "toolcall_delta", contentIndex: entry.index, delta, partial: this.#partial });
	}

	nativeToolEnd(srcIndex: number, toolCall: ToolCall): void {
		if (this.#stopped) return;
		const entry = this.#nativeBlocks.get(srcIndex);
		if (entry) {
			Object.assign(entry.block, toolCall);
			if (this.#emitEvents)
				this.#out.push({
					type: "toolcall_end",
					contentIndex: entry.index,
					toolCall: entry.block,
					partial: this.#partial,
				});
			this.#nativeBlocks.delete(srcIndex);
			return;
		}
		// Never streamed (name was empty at start). Salvage a real call whose name
		// only arrived now; drop nameless ghosts and anything the in-band channel
		// already claimed.
		if (!toolCall.name || this.#toolChannel === "inband") return;
		this.#toolChannel = "native";
		this.#closeText();
		this.#closeThinking();
		const block: ToolCall = { ...toolCall };
		this.#partial.content.push(block);
		const index = this.#partial.content.length - 1;
		if (this.#emitEvents) {
			this.#out.push({ type: "toolcall_start", contentIndex: index, partial: this.#partial });
			this.#out.push({ type: "toolcall_end", contentIndex: index, toolCall: block, partial: this.#partial });
		}
	}

	text(delta: string): boolean {
		if (this.#stopped) return true;
		this.#fedLen += delta.length;
		const combined = this.#responsePending + delta;
		const responseIndex = firstTokenIndex(combined, this.#responseOpenTokens);
		if (responseIndex !== -1) {
			this.#responsePending = "";
			this.#apply(this.#scanner.feed(combined.slice(0, responseIndex)));
			this.#stopped = true;
			return true;
		}

		if (combined.length <= this.#responseOverlapLength) {
			this.#responsePending = combined;
			return false;
		}

		const emitLength = combined.length - this.#responseOverlapLength;
		this.#responsePending = combined.slice(emitLength);
		this.#apply(this.#scanner.feed(combined.slice(0, emitLength)));
		return false;
	}

	thinkingStart(): void {
		if (this.#stopped) return;
		this.#closeText();
		if (this.#thinking) return;
		const block: ThinkingContent = { type: "thinking", thinking: "" };
		this.#partial.content.push(block);
		this.#thinking = { index: this.#partial.content.length - 1, text: "" };
		if (this.#emitEvents)
			this.#out.push({ type: "thinking_start", contentIndex: this.#thinking.index, partial: this.#partial });
	}

	thinkingDelta(delta: string): void {
		if (this.#stopped) return;
		if (!this.#thinking) this.thinkingStart();
		const thinking = this.#thinking;
		if (!thinking) return;
		const block = this.#partial.content[thinking.index] as ThinkingContent;
		block.thinking += delta;
		thinking.text += delta;
		if (this.#emitEvents)
			this.#out.push({ type: "thinking_delta", contentIndex: thinking.index, delta, partial: this.#partial });
	}

	thinkingEnd(): void {
		this.#closeThinking();
	}

	finish(message: AssistantMessage, emitDone: boolean): AssistantMessage {
		let fullText = "";
		for (const block of message.content) if (block.type === "text") fullText += block.text;
		if (!this.#stopped && fullText.length > this.#fedLen) this.text(fullText.slice(this.#fedLen));
		if (!this.#stopped && this.#responsePending.length > 0) {
			this.#apply(this.#scanner.feed(this.#responsePending));
			this.#responsePending = "";
		}
		this.#apply(this.#scanner.flush());
		this.#closeText();
		this.#closeThinking();
		const hasTools = this.#partial.content.some(block => block.type === "toolCall");
		const reason =
			hasTools && message.stopReason !== "length" ? "toolUse" : message.stopReason === "length" ? "length" : "stop";
		const finalMessage: AssistantMessage = { ...message, content: this.#partial.content, stopReason: reason };
		if (emitDone) this.#out.push({ type: "done", reason, message: finalMessage });
		return finalMessage;
	}

	#apply(events: InbandScanEvent[]): void {
		for (const event of events) {
			switch (event.type) {
				case "text":
					this.#emitText(event.text);
					break;
				case "thinkingStart":
					this.thinkingStart();
					break;
				case "thinkingDelta":
					this.thinkingDelta(event.delta);
					break;
				case "thinkingEnd":
					this.thinkingEnd();
					break;
				case "toolStart":
					this.#beginTool(event);
					break;
				case "toolArgDelta":
					this.#deltaTool(event);
					break;
				case "toolEnd":
					this.#endTool(event);
					break;
			}
		}
	}

	#emitText(text: string): void {
		if (text.length === 0) return;
		this.#closeThinking();
		if (!this.#text) {
			this.#partial.content.push({ type: "text", text: "" });
			this.#text = { index: this.#partial.content.length - 1 };
			if (this.#emitEvents)
				this.#out.push({ type: "text_start", contentIndex: this.#text.index, partial: this.#partial });
		}
		const block = this.#partial.content[this.#text.index] as TextContent;
		block.text += text;
		if (this.#emitEvents)
			this.#out.push({ type: "text_delta", contentIndex: this.#text.index, delta: text, partial: this.#partial });
	}

	#closeText(): void {
		if (!this.#text) return;
		const block = this.#partial.content[this.#text.index] as TextContent;
		if (this.#emitEvents) {
			this.#out.push({
				type: "text_end",
				contentIndex: this.#text.index,
				content: block.text,
				partial: this.#partial,
			});
		}
		this.#text = undefined;
	}

	#closeThinking(): void {
		if (!this.#thinking) return;
		const block = this.#partial.content[this.#thinking.index] as ThinkingContent;
		if (this.#emitEvents) {
			this.#out.push({
				type: "thinking_end",
				contentIndex: this.#thinking.index,
				content: block.thinking,
				partial: this.#partial,
			});
		}
		this.#thinking = undefined;
	}

	#beginTool(event: Extract<InbandScanEvent, { type: "toolStart" }>): void {
		// Native owns the turn → drop the in-band call to avoid double-dispatch.
		if (this.#toolChannel === "native") return;
		this.#toolChannel = "inband";
		this.#closeText();
		this.#closeThinking();
		if (this.#toolBlocks.has(event.id)) return;
		const block: ToolCall = { type: "toolCall", id: event.id, name: event.name, arguments: {} };
		this.#partial.content.push(block);
		const entry = { index: this.#partial.content.length - 1, block, rawValue: "" };
		this.#toolBlocks.set(event.id, entry);
		if (this.#emitEvents)
			this.#out.push({ type: "toolcall_start", contentIndex: entry.index, partial: this.#partial });
	}

	#deltaTool(event: Extract<InbandScanEvent, { type: "toolArgDelta" }>): void {
		let entry = this.#toolBlocks.get(event.id);
		if (!entry) {
			this.#beginTool({ type: "toolStart", id: event.id, name: event.name });
			entry = this.#toolBlocks.get(event.id);
		}
		if (!entry) return;
		if (entry.currentKey !== event.key) {
			entry.currentKey = event.key;
			entry.rawValue =
				typeof entry.block.arguments[event.key] === "string" ? String(entry.block.arguments[event.key]) : "";
		}
		entry.rawValue += event.delta;
		entry.block.arguments[event.key] = entry.rawValue;
		if (this.#emitEvents)
			this.#out.push({
				type: "toolcall_delta",
				contentIndex: entry.index,
				delta: event.delta,
				partial: this.#partial,
			});
	}

	#endTool(event: Extract<InbandScanEvent, { type: "toolEnd" }>): void {
		let entry = this.#toolBlocks.get(event.id);
		if (!entry) {
			this.#beginTool({ type: "toolStart", id: event.id, name: event.name });
			entry = this.#toolBlocks.get(event.id);
		}
		if (!entry) return;
		entry.block.name = event.name;
		entry.block.arguments = event.arguments;
		if (event.rawBlock !== undefined) entry.block.rawBlock = event.rawBlock;
		if (this.#emitEvents)
			this.#out.push({
				type: "toolcall_end",
				contentIndex: entry.index,
				toolCall: entry.block,
				partial: this.#partial,
			});
		this.#toolBlocks.delete(event.id);
	}
}
