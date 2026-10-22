/**
 * Rebuilds streaming assistant messages from `messageUpdates: "delta"` frames (see `toDelta` in
 * `modes/rpc/rpc-session-events.ts`), so a socket client can render them as an in-process session would.
 */
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { setStreamingPartialJson } from "@oh-my-pi/pi-ai/utils/block-symbols";
import { parseStreamingJsonThrottled } from "@oh-my-pi/pi-utils";
import type { RpcDeltaAssistantMessageEvent } from "../modes/rpc/rpc-types";
import type { AgentSessionEvent } from "../session/agent-session";

type Block = AssistantMessage["content"][number];

interface Entry {
	/** Last message handed out; never mutated. */
	message: AssistantMessage;
	/** By `contentIndex`. Holes are blocks the host added without an event; `message_end` brings them. */
	blocks: Array<Block | undefined>;
	/**
	 * Raw tool-call JSON so far, and its length at the last parse, by `contentIndex`; only for tool calls whose
	 * `toolcall_start` this accumulator saw.
	 */
	toolJson: Map<number, { json: string; parsedLen: number }>;
}

/**
 * One streaming message per `messageId` (a card can nest inside a streaming reply). Each update returns a new
 * message with a new `content` array and a new touched block; untouched blocks are shared.
 */
export class StreamingMessageAccumulator {
	#entries = new Map<string, Entry>();

	/** Starts (or restarts) `messageId` from `message`, e.g. a mid-turn snapshot's `streaming`. */
	seed(messageId: string, message: AssistantMessage): void {
		this.#entries.set(messageId, { message, blocks: [...message.content], toolJson: new Map() });
	}

	reset(): void {
		this.#entries.clear();
	}

	/**
	 * Returns `event` unchanged, except a delta `message_update`, whose `message` becomes the rebuilt message.
	 * Throws when a delta cannot be applied (unknown message, missing block): the caller must fail closed.
	 */
	apply(event: AgentSessionEvent): AgentSessionEvent {
		const messageId = "messageId" in event && typeof event.messageId === "string" ? event.messageId : undefined;
		switch (event.type) {
			case "agent_end":
				this.reset();
				return event;
			case "message_start":
				if (messageId !== undefined && event.message.role === "assistant") this.seed(messageId, event.message);
				return event;
			case "message_end":
				if (messageId !== undefined) this.#entries.delete(messageId);
				return event;
			case "message_update":
				break;
			default:
				return event;
		}
		if (event.message.role !== "assistant") return event;
		// A full frame (older host, or a filter reset to full) carries the whole message.
		if (Array.isArray(event.message.content)) {
			if (messageId !== undefined) this.seed(messageId, event.message);
			return event;
		}
		const entry = messageId === undefined ? undefined : this.#entries.get(messageId);
		if (messageId === undefined || entry === undefined)
			throw new Error(`Delta update for unknown message ${messageId}`);
		// A content-less message marks the delta projection, whose event shape this is.
		const delta = event.assistantMessageEvent as unknown as RpcDeltaAssistantMessageEvent;
		if (delta.type === "start") {
			this.seed(messageId, delta.message);
			return { ...event, message: delta.message };
		}
		if (delta.type === "done" || delta.type === "error") {
			const message = delta.type === "done" ? delta.message : delta.error;
			this.seed(messageId, message);
			return { ...event, message };
		}

		const index = delta.contentIndex;
		const current = entry.blocks[index];
		let block: Block;
		switch (delta.type) {
			case "text_delta":
				if (current?.type !== "text") throw new Error(`text_delta for a non-text block in message ${messageId}`);
				block = { ...current, text: current.text + delta.delta };
				break;
			case "thinking_delta":
				if (current?.type !== "thinking") {
					throw new Error(`thinking_delta for a non-thinking block in message ${messageId}`);
				}
				block = { ...current, thinking: current.thinking + delta.delta };
				break;
			case "toolcall_delta": {
				if (current?.type !== "toolCall") {
					throw new Error(`toolcall_delta for a non-toolCall block in message ${messageId}`);
				}
				const state = entry.toolJson.get(index);
				// Seeded mid-call (snapshot or full frame): the raw JSON before this delta is unknown, so keep the
				// seeded arguments until `toolcall_end` brings the final block.
				if (state === undefined) {
					block = current;
					break;
				}
				const json = state.json + delta.delta;
				const parsed = parseStreamingJsonThrottled(json, state.parsedLen);
				const toolCall = { ...current };
				if (parsed !== null) toolCall.arguments = parsed.value || {};
				setStreamingPartialJson(toolCall, json);
				entry.toolJson.set(index, { json, parsedLen: parsed?.parsedLen ?? state.parsedLen });
				block = toolCall;
				break;
			}
			default: {
				if (!delta.block) throw new Error(`${delta.type} without a block in message ${messageId}`);
				block = delta.block;
				// The host snapshots the block when it handles the event, so a start block can already hold text that
				// later deltas carry: take its identity only and grow it from the deltas. The end block is final.
				if (delta.type === "text_start" && block.type === "text") block = { ...block, text: "" };
				else if (delta.type === "thinking_start" && block.type === "thinking") block = { ...block, thinking: "" };
				else if (delta.type === "toolcall_start" && block.type === "toolCall") {
					block = { ...block, arguments: {} };
					setStreamingPartialJson(block, "");
					entry.toolJson.set(index, { json: "", parsedLen: 0 });
				} else if (delta.type === "toolcall_end") entry.toolJson.delete(index);
			}
		}
		entry.blocks[index] = block;
		entry.message = { ...entry.message, content: entry.blocks.filter(item => item !== undefined) };
		return { ...event, message: entry.message };
	}
}
