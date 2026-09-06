/**
 * Central live healing for leaked reasoning markup in the visible text channel.
 *
 * Some providers emit their canonical reasoning idioms (` ```thinking `,
 * `<think>`, Gemma/Harmony channels, …) into the *visible* text stream instead
 * of a structured thinking part. {@link wrapLeakedThinkingStream} re-projects a
 * provider stream into a fresh {@link AssistantMessageEventStream}, splitting the
 * leaked fences out into proper `thinking` blocks *live* as deltas arrive.
 *
 * Applied to every provider stream *except* official first-party endpoints
 * (the official Anthropic API and the official OpenAI / OpenAI-Codex endpoints),
 * which return structured thinking and never leak — `healLeakedThinking` in
 * `../stream.ts` gates the wrap so the healer cannot misfire on legitimate
 * fenced content those models emit as visible text.
 *
 * The healing is idempotent: a second pass over already-clean text finds no
 * fences, so wrapping a provider that already heals (or wrapping twice) is a
 * harmless pass-through. Signatures are load-bearing for Google/Gemini/Vertex
 * thought round-tripping, so text sub-blocks carry the source `textSignature`,
 * forwarded thinking blocks their `thinkingSignature`, and forwarded tool calls
 * their `thoughtSignature`.
 *
 * Modeled on {@link wrapInbandToolStream} / `InbandStreamProjector` in
 * `../dialect/owned-stream.ts`, minus all in-band tool-call grammar: tool-call
 * events are forwarded verbatim.
 */

import { isAnthropicServerToolHistoryBlock } from "../providers/anthropic-wire";
import type {
	AnthropicServerToolContent,
	AssistantMessage,
	ImageContent,
	TextContent,
	ThinkingContent,
	ToolCall,
} from "../types";
import {
	clearStreamingPartialJson,
	copyCursorExecResolved,
	getStreamingPartialJson,
	type StreamingPartialJsonCarrier,
	setStreamingPartialJson,
} from "./block-symbols";
import { AssistantMessageEventStream } from "./event-stream";
import { StreamMarkupHealing, type StreamMarkupHealingEvent } from "./stream-markup-healing";

type StreamingToolCall = ToolCall & StreamingPartialJsonCarrier;

function cloneToolCall(source: StreamingToolCall): StreamingToolCall {
	const block: StreamingToolCall = { ...source, arguments: source.arguments };
	const partialJson = getStreamingPartialJson(source);
	if (partialJson !== undefined) setStreamingPartialJson(block, partialJson);
	copyCursorExecResolved(block, source);
	return block;
}

function syncToolCall(target: StreamingToolCall, source: StreamingToolCall): void {
	Object.assign(target, source);
	const partialJson = getStreamingPartialJson(source);
	if (partialJson === undefined) clearStreamingPartialJson(target);
	else setStreamingPartialJson(target, partialJson);
	copyCursorExecResolved(target, source);
}

/**
 * Wrap a provider stream so leaked reasoning fences are healed into thinking
 * blocks live, for every provider. Returns a new stream that re-projects the
 * inner one; the inner stream is fully consumed.
 */
export function wrapLeakedThinkingStream(inner: AssistantMessageEventStream): AssistantMessageEventStream {
	const out = new AssistantMessageEventStream();
	void (async () => {
		try {
			let projector: LeakedThinkingProjector | undefined;
			for await (const event of inner) {
				switch (event.type) {
					case "start":
						projector = new LeakedThinkingProjector(out, event.partial);
						break;
					case "text_delta": {
						projector ??= new LeakedThinkingProjector(out, event.partial);
						const block = event.partial.content[event.contentIndex];
						projector.text(
							event.contentIndex,
							event.delta,
							block?.type === "text" ? block.textSignature : undefined,
						);
						break;
					}
					case "thinking_delta": {
						projector ??= new LeakedThinkingProjector(out, event.partial);
						const block = event.partial.content[event.contentIndex];
						projector.thinking(
							event.contentIndex,
							event.delta,
							block?.type === "thinking" ? block.thinkingSignature : undefined,
						);
						break;
					}
					case "thinking_end": {
						const block = event.partial.content[event.contentIndex];
						projector?.thinkingEnd(
							event.contentIndex,
							block?.type === "thinking" ? block.thinkingSignature : undefined,
						);
						break;
					}
					case "image_end":
						projector ??= new LeakedThinkingProjector(out, event.partial);
						projector.image(event.contentIndex, event.content);
						break;
					case "toolcall_start": {
						projector ??= new LeakedThinkingProjector(out, event.partial);
						const block = event.partial.content[event.contentIndex];
						projector.toolStart(event.contentIndex, block?.type === "toolCall" ? block : undefined);
						break;
					}
					case "toolcall_delta": {
						const block = event.partial.content[event.contentIndex];
						projector?.toolDelta(event.contentIndex, event.delta, block?.type === "toolCall" ? block : undefined);
						break;
					}
					case "toolcall_end":
						projector?.toolEnd(event.contentIndex, event.toolCall);
						break;
					case "done": {
						projector ??= new LeakedThinkingProjector(out, event.message);
						const content = projector.finish(event.message);
						out.push({ type: "done", reason: event.reason, message: { ...event.message, content } });
						return;
					}
					case "error": {
						projector ??= new LeakedThinkingProjector(out, event.error);
						const content = projector.finish(event.error);
						out.push({ type: "error", reason: event.reason, error: { ...event.error, content } });
						return;
					}
					// text_start/text_end/thinking_start are ignored: the projector owns
					// block boundaries (matches wrapInbandToolStream). thinking_end is
					// handled to capture the signature Anthropic delivers at block close.
				}
			}
			// Inner ended via end(result) without a terminal event.
			if (!out.done) {
				const result = await inner.result();
				projector ??= new LeakedThinkingProjector(out, result);
				const content = projector.finish(result);
				out.end({ ...result, content });
			}
		} catch (err) {
			if (!out.done) out.fail(err);
		}
	})();
	return out;
}

type OpenBlock = { index: number } | undefined;
type ProjectedContent = AssistantMessage["content"][number];
type AnchoredContent = { block: ProjectedContent; sourceIndex: number; order: number };

/**
 * Re-projects an inner stream's events into `out`, healing leaked reasoning out
 * of the visible text channel while forwarding native thinking and tool calls.
 */
class LeakedThinkingProjector {
	readonly #out: AssistantMessageEventStream;
	readonly #healer = new StreamMarkupHealing({ pattern: "thinking" });
	#partial: AssistantMessage;
	#text: OpenBlock;
	#thinking: OpenBlock;
	/** Visible text consumed per source block, used to recover terminal-only tails. */
	#fedTextLengths = new Map<number, number>();
	/** Source text block whose held healer output has not crossed a content boundary. */
	#activeTextSourceIndex: number | undefined;
	/** Original terminal content index for every projected block. */
	#sourceAnchors = new Map<ProjectedContent, number>();
	/** Latest non-undefined text signature seen, stamped onto held-back text flushed later. */
	#lastTextSignature: string | undefined;
	/** Forwarded native tool calls, keyed by the inner stream's `contentIndex`. */
	#toolBlocks = new Map<number, { index: number; block: StreamingToolCall }>();
	/** Projected native thinking blocks, keyed by the inner stream's `contentIndex`. */
	#thinkingBlocks = new Map<number, number>();
	/** Native thinking blocks whose projected `thinking_end` awaits the source end event. */
	#pendingThinkingEnds = new Set<number>();

	constructor(out: AssistantMessageEventStream, seed: AssistantMessage) {
		this.#out = out;
		this.#partial = { ...seed, content: [] };
		this.#out.push({ type: "start", partial: this.#partial });
	}

	/** Feed a visible-text delta through the healer, splitting leaked fences live. */
	text(srcIndex: number, delta: string, signature: string | undefined): void {
		const startsSource = this.#activeTextSourceIndex !== srcIndex;
		if (this.#activeTextSourceIndex !== undefined && startsSource) {
			this.#flushHealer();
			this.#closeText();
			this.#closeThinking();
		}
		this.#activeTextSourceIndex = srcIndex;
		this.#fedTextLengths.set(srcIndex, (this.#fedTextLengths.get(srcIndex) ?? 0) + delta.length);
		if (startsSource || signature !== undefined) this.#lastTextSignature = signature;
		this.#apply(this.#healer.feedEvents(delta), this.#lastTextSignature, srcIndex);
	}

	/** Forward a native thinking delta, preserving its source block identity and signature. */
	thinking(srcIndex: number, delta: string, signature: string | undefined): void {
		let index = this.#thinkingBlocks.get(srcIndex);
		if (index === undefined) {
			if (this.#thinking && this.#pendingThinkingEnds.has(this.#thinking.index)) this.#closeThinking();
			index = this.#openThinking(srcIndex);
			this.#thinkingBlocks.set(srcIndex, index);
			this.#pendingThinkingEnds.add(index);
		}
		const block = this.#partial.content[index] as ThinkingContent;
		block.thinking += delta;
		if (signature !== undefined) block.thinkingSignature = signature;
		this.#out.push({ type: "thinking_delta", contentIndex: index, delta, partial: this.#partial });
	}

	/**
	 * Finalize a native thinking block by source identity. Its projected end is
	 * deferred until this event so stream consumers observe the completed
	 * signature before the block closes, even when later blocks started first.
	 *
	 * A block that never streamed a delta but closes with a signature is
	 * projected here instead of dropped: Gemini thought signatures arrive via
	 * OpenRouter's Responses translation as a text-less reasoning item whose id
	 * is the following function call's `call_id`. Losing that signature makes
	 * every current-turn function-call replay unsigned, which Gemini 3 punishes
	 * with empty stops and `server_error: stream closed with reason: error`.
	 */
	thinkingEnd(srcIndex: number, signature: string | undefined): void {
		const index = this.#thinkingBlocks.get(srcIndex);
		if (index === undefined) {
			if (signature) this.#projectSignedThinking(srcIndex, "", signature);
			return;
		}
		if (signature !== undefined) {
			(this.#partial.content[index] as ThinkingContent).thinkingSignature = signature;
		}
		if (!this.#pendingThinkingEnds.delete(index)) return;
		if (this.#thinking?.index === index) this.#thinking = undefined;
		this.#emitThinkingEnd(index);
	}

	/**
	 * Project a completed signature-bearing thinking block whose deltas never
	 * reached the projector. Releases held-back text first (same boundary
	 * semantics as {@link toolStart}) so block order survives for replay —
	 * the signature item must precede the function call it signs.
	 */
	#projectSignedThinking(srcIndex: number, thinking: string, signature: string): void {
		this.#flushHealer();
		this.#closeText();
		this.#closeThinking();
		this.#partial.content.push({ type: "thinking", thinking, thinkingSignature: signature });
		const index = this.#partial.content.length - 1;
		this.#anchor(index, srcIndex);
		this.#thinkingBlocks.set(srcIndex, index);
		this.#out.push({ type: "thinking_start", contentIndex: index, partial: this.#partial });
		this.#emitThinkingEnd(index);
	}

	/** Forward a completed native image after releasing held text. */
	image(srcIndex: number, content: ImageContent): void {
		this.#flushHealer();
		this.#closeText();
		this.#closeThinking();
		this.#partial.content.push(content);
		const index = this.#partial.content.length - 1;
		this.#anchor(index, srcIndex);
		this.#out.push({
			type: "image_end",
			contentIndex: index,
			content,
			partial: this.#partial,
		});
	}

	/** Forward a native tool call's start, releasing any held-back text first. */
	toolStart(srcIndex: number, source: StreamingToolCall | undefined): void {
		if (!source) return;
		this.#flushHealer();
		this.#closeText();
		this.#closeThinking();
		const block = cloneToolCall(source);
		this.#partial.content.push(block);
		const index = this.#partial.content.length - 1;
		this.#anchor(index, srcIndex);
		this.#toolBlocks.set(srcIndex, { index, block });
		this.#out.push({ type: "toolcall_start", contentIndex: index, partial: this.#partial });
	}

	toolDelta(srcIndex: number, delta: string, source: StreamingToolCall | undefined): void {
		let entry = this.#toolBlocks.get(srcIndex);
		if (!entry && source) {
			this.toolStart(srcIndex, source);
			entry = this.#toolBlocks.get(srcIndex);
		}
		if (!entry) return;
		if (source) syncToolCall(entry.block, source);
		this.#out.push({ type: "toolcall_delta", contentIndex: entry.index, delta, partial: this.#partial });
	}

	toolEnd(srcIndex: number, toolCall: ToolCall): void {
		const entry = this.#toolBlocks.get(srcIndex);
		if (entry) {
			syncToolCall(entry.block, toolCall);
			this.#out.push({
				type: "toolcall_end",
				contentIndex: entry.index,
				toolCall: entry.block,
				partial: this.#partial,
			});
			this.#toolBlocks.delete(srcIndex);
			return;
		}
		// `end` without a matching `start` — release held text, then forward whole.
		this.#flushHealer();
		this.#closeText();
		this.#closeThinking();
		const block = cloneToolCall(toolCall);
		this.#partial.content.push(block);
		const index = this.#partial.content.length - 1;
		this.#anchor(index, srcIndex);
		this.#out.push({ type: "toolcall_start", contentIndex: index, partial: this.#partial });
		this.#out.push({ type: "toolcall_end", contentIndex: index, toolCall: block, partial: this.#partial });
	}

	/**
	 * Finalize: replay any un-streamed visible-text tail from `message.content`,
	 * flush held-back fragments, close open blocks, and return the healed content.
	 */
	finish(message: AssistantMessage): AssistantMessage["content"] {
		for (const [srcIndex] of this.#thinkingBlocks) {
			const block = message.content[srcIndex];
			this.thinkingEnd(srcIndex, block?.type === "thinking" ? block.thinkingSignature : undefined);
		}
		// Safety net: signature-bearing thinking blocks whose events never
		// reached the projector at all (e.g. a terminal message assembled from
		// blocks that skipped per-item events) must still survive with their
		// text and signature intact.
		for (let srcIndex = 0; srcIndex < message.content.length; srcIndex++) {
			const block = message.content[srcIndex];
			if (block?.type !== "thinking" || !block.thinkingSignature) continue;
			if (this.#thinkingBlocks.has(srcIndex)) continue;
			this.#projectSignedThinking(srcIndex, block.thinking, block.thinkingSignature);
		}
		for (let srcIndex = 0; srcIndex < message.content.length; srcIndex++) {
			const block = message.content[srcIndex];
			if (block?.type !== "text") continue;
			const fedLength = this.#fedTextLengths.get(srcIndex) ?? 0;
			if (block.text.length <= fedLength) continue;
			if (this.#activeTextSourceIndex !== undefined && this.#activeTextSourceIndex !== srcIndex) {
				this.#flushHealer();
				this.#closeText();
				this.#closeThinking();
			}
			this.#activeTextSourceIndex = srcIndex;
			this.#lastTextSignature = block.textSignature;
			this.#apply(this.#healer.feedEvents(block.text.slice(fedLength)), this.#lastTextSignature, srcIndex);
		}
		this.#flushHealer();
		this.#closeText();
		this.#closeThinking();
		return this.#mergeServerToolHistory(message);
	}

	#apply(events: readonly StreamMarkupHealingEvent[], signature: string | undefined, srcIndex: number): void {
		for (const event of events) {
			if (event.type === "text") this.#emitText(event.text, signature, srcIndex);
			else if (event.type === "thinking") this.#emitHealedThinking(event.thinking, srcIndex);
		}
	}

	#emitText(text: string, signature: string | undefined, srcIndex: number): void {
		if (text.length === 0) return;
		this.#closeThinking();
		if (!this.#text) {
			const block: TextContent =
				signature === undefined ? { type: "text", text: "" } : { type: "text", text: "", textSignature: signature };
			this.#partial.content.push(block);
			this.#text = { index: this.#partial.content.length - 1 };
			this.#anchor(this.#text.index, srcIndex);
			this.#out.push({ type: "text_start", contentIndex: this.#text.index, partial: this.#partial });
		} else if (signature !== undefined) {
			(this.#partial.content[this.#text.index] as TextContent).textSignature = signature;
		}
		const block = this.#partial.content[this.#text.index] as TextContent;
		block.text += text;
		this.#out.push({ type: "text_delta", contentIndex: this.#text.index, delta: text, partial: this.#partial });
	}

	/** Healed (leaked) thinking carries no signature, matching the source fence. */
	#emitHealedThinking(text: string, srcIndex: number): void {
		if (text.length === 0) return;
		const index = this.#openThinking(srcIndex);
		const block = this.#partial.content[index] as ThinkingContent;
		block.thinking += text;
		this.#out.push({ type: "thinking_delta", contentIndex: index, delta: text, partial: this.#partial });
	}

	#openThinking(srcIndex: number): number {
		this.#closeText();
		if (!this.#thinking) {
			this.#partial.content.push({ type: "thinking", thinking: "" });
			this.#thinking = { index: this.#partial.content.length - 1 };
			this.#anchor(this.#thinking.index, srcIndex);
			this.#out.push({ type: "thinking_start", contentIndex: this.#thinking.index, partial: this.#partial });
		}
		return this.#thinking.index;
	}

	#flushHealer(): void {
		const srcIndex = this.#activeTextSourceIndex;
		if (srcIndex !== undefined) {
			this.#apply(this.#healer.flushEvents(), this.#lastTextSignature, srcIndex);
		}
		this.#activeTextSourceIndex = undefined;
	}

	#anchor(index: number, srcIndex: number): void {
		const block = this.#partial.content[index];
		if (block) this.#sourceAnchors.set(block, srcIndex);
	}

	#mergeServerToolHistory(message: AssistantMessage): AssistantMessage["content"] {
		const pendingCalls = new Map<string, number>();
		const pairedIndexes = new Set<number>();
		for (let srcIndex = 0; srcIndex < message.content.length; srcIndex++) {
			const content = message.content[srcIndex];
			if (content?.type !== "anthropicServerTool" || !isAnthropicServerToolHistoryBlock(content.block)) continue;
			if (content.block.type === "server_tool_use") {
				pendingCalls.set(content.block.id, srcIndex);
				continue;
			}
			const callIndex = pendingCalls.get(content.block.tool_use_id);
			if (callIndex === undefined) continue;
			pairedIndexes.add(callIndex);
			pairedIndexes.add(srcIndex);
			pendingCalls.delete(content.block.tool_use_id);
		}

		const anchored: AnchoredContent[] = this.#partial.content.map((block, order) => ({
			block,
			sourceIndex: this.#sourceAnchors.get(block) ?? message.content.length + order,
			order,
		}));
		for (const srcIndex of pairedIndexes) {
			const content = message.content[srcIndex];
			if (content?.type !== "anthropicServerTool") continue;
			const cloned: AnthropicServerToolContent = {
				type: "anthropicServerTool",
				block: structuredClone(content.block),
			};
			anchored.push({ block: cloned, sourceIndex: srcIndex, order: srcIndex });
		}
		anchored.sort((left, right) => left.sourceIndex - right.sourceIndex || left.order - right.order);
		return anchored.map(({ block }) => block);
	}
	#closeText(): void {
		if (!this.#text) return;
		const block = this.#partial.content[this.#text.index] as TextContent;
		this.#out.push({ type: "text_end", contentIndex: this.#text.index, content: block.text, partial: this.#partial });
		this.#text = undefined;
	}

	#closeThinking(): void {
		if (!this.#thinking) return;
		const index = this.#thinking.index;
		this.#thinking = undefined;
		if (this.#pendingThinkingEnds.has(index)) return;
		this.#emitThinkingEnd(index);
	}

	#emitThinkingEnd(index: number): void {
		const block = this.#partial.content[index] as ThinkingContent;
		this.#out.push({
			type: "thinking_end",
			contentIndex: index,
			content: block.thinking,
			partial: this.#partial,
		});
	}
}
