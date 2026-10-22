import { describe, expect, test } from "bun:test";
import { Agent, type AgentMessage, type StreamFn } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, AssistantMessageEvent, TextContent, ThinkingContent, ToolCall } from "@oh-my-pi/pi-ai";
import {
	clearStreamingPartialJson,
	getStreamingPartialJson,
	setStreamingPartialJson,
} from "@oh-my-pi/pi-ai/utils/block-symbols";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { RpcMessageIdStamper, RpcSessionEventForwarder } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-session-events";
import type { RpcProjectedSessionEventFrame } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { StreamingMessageAccumulator } from "@oh-my-pi/pi-coding-agent/session-host/message-accumulator";
import { parseStreamingJsonThrottled } from "@oh-my-pi/pi-utils";
import { makeAssistantMessage } from "../session-manager/helpers";

/** What a socket client decodes: the frame after a JSON round trip. */
function wire(frame: RpcProjectedSessionEventFrame): AgentSessionEvent {
	return JSON.parse(JSON.stringify(frame)) as AgentSessionEvent;
}

function deepFreeze<T>(value: T): T {
	if (value && typeof value === "object" && !Object.isFrozen(value)) {
		Object.freeze(value);
		for (const child of Object.values(value)) deepFreeze(child);
	}
	return value;
}

/** Feeds `events` through one stamper into a full and a delta connection, as the host does. */
function project(events: AgentSessionEvent[]): { full: AgentSessionEvent[]; delta: AgentSessionEvent[] } {
	const full: AgentSessionEvent[] = [];
	const delta: AgentSessionEvent[] = [];
	const stamper = new RpcMessageIdStamper();
	const fullConn = new RpcSessionEventForwarder(frame => full.push(wire(frame)));
	const deltaConn = new RpcSessionEventForwarder(frame => delta.push(wire(frame)));
	deltaConn.setFilter(null, "delta");
	for (const event of events) {
		const stamped = stamper.stamp(event);
		fullConn.forward(stamped);
		deltaConn.forward(stamped);
	}
	return { full, delta };
}

function update(message: AssistantMessage, assistantMessageEvent: AssistantMessageEvent): AgentSessionEvent {
	return { type: "message_update", message, assistantMessageEvent };
}

function messageOf(event: AgentSessionEvent): unknown {
	return "message" in event ? event.message : undefined;
}

function assistantOf(event: AgentSessionEvent): AssistantMessage {
	if (event.type !== "message_update" || event.message.role !== "assistant")
		throw new Error(`not an update: ${event.type}`);
	return event.message;
}

/**
 * Streams like a real provider, unlike the mock (whose start blocks are already complete): blocks start empty and
 * grow in place, tool-call JSON is parsed throttled. First call: thinking, text, tool call; later calls: text.
 * `paced` lets the agent handle each event before the next mutation; unpaced, every event is pushed in one tick, so
 * the host snapshots each of them after the last mutation (a provider parsing several SSE events from one chunk).
 */
function providerLikeStream(paced: boolean): StreamFn {
	let calls = 0;
	return () => {
		const first = calls++ === 0;
		const stream = new AssistantMessageEventStream();
		const partial: AssistantMessage = { ...makeAssistantMessage(), content: [] };
		const push = async (event: AssistantMessageEvent): Promise<void> => {
			stream.push(event);
			if (paced) await new Promise<void>(resolve => setImmediate(resolve));
		};
		void (async () => {
			await push({ type: "start", partial });
			if (first) {
				const thinking: ThinkingContent = { type: "thinking", thinking: "" };
				partial.content.push(thinking);
				await push({ type: "thinking_start", contentIndex: 0, partial });
				for (const delta of ["pl", "an"]) {
					thinking.thinking += delta;
					await push({ type: "thinking_delta", contentIndex: 0, delta, partial });
				}
				thinking.thinkingSignature = "sig";
				await push({ type: "thinking_end", contentIndex: 0, content: thinking.thinking, partial });
			}
			const text: TextContent = { type: "text", text: "" };
			const textIndex = partial.content.push(text) - 1;
			await push({ type: "text_start", contentIndex: textIndex, partial });
			for (const delta of first ? ["fi", "rst"] : ["done"]) {
				text.text += delta;
				await push({ type: "text_delta", contentIndex: textIndex, delta, partial });
			}
			await push({ type: "text_end", contentIndex: textIndex, content: text.text, partial });
			if (first) {
				const toolCall: ToolCall = { type: "toolCall", id: "call-1", name: "read", arguments: {} };
				const toolIndex = partial.content.push(toolCall) - 1;
				await push({ type: "toolcall_start", contentIndex: toolIndex, partial });
				let json = "";
				let parsedLen = 0;
				for (const delta of ['{"path":', '"a.ts"}']) {
					json += delta;
					const parsed = parseStreamingJsonThrottled(json, parsedLen);
					if (parsed) ({ value: toolCall.arguments, parsedLen } = parsed);
					setStreamingPartialJson(toolCall, json);
					await push({ type: "toolcall_delta", contentIndex: toolIndex, delta, partial });
				}
				toolCall.arguments = JSON.parse(json);
				clearStreamingPartialJson(toolCall);
				await push({ type: "toolcall_end", contentIndex: toolIndex, toolCall, partial });
			}
			const reason = first ? "toolUse" : "stop";
			partial.stopReason = reason;
			await push({ type: "done", reason, message: partial });
		})();
		return stream;
	};
}

async function run(paced: boolean): Promise<AgentSessionEvent[]> {
	const events: AgentSessionEvent[] = [];
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: { model: getBundledModel("anthropic", "claude-sonnet-4-5")!, systemPrompt: ["Test"], tools: [] },
		streamFn: providerLikeStream(paced),
	});
	agent.subscribe(event => events.push(event));
	await agent.prompt("hi");
	return events;
}

describe("StreamingMessageAccumulator", () => {
	test("rebuilds every streamed message of a real run from its delta frames", async () => {
		const { full, delta } = project(await run(true));
		expect(delta).toHaveLength(full.length);
		expect(full.filter(event => event.type === "message_update").length).toBeGreaterThan(6);
		const accumulator = new StreamingMessageAccumulator();
		for (const [index, frame] of delta.entries()) {
			const rebuilt = accumulator.apply(frame);
			expect(JSON.stringify(messageOf(rebuilt))).toBe(JSON.stringify(messageOf(full[index])));
			// The vocalizer reads `.delta` off the event: it must reach the view as the host sent it.
			if (frame.type === "message_update" && rebuilt.type === "message_update") {
				expect(rebuilt.assistantMessageEvent).toEqual(frame.assistantMessageEvent);
			}
			deepFreeze(rebuilt);
		}
	});

	test("does not double text when the host snapshots a start event after later deltas landed", async () => {
		const { delta } = project(await run(false));
		const accumulator = new StreamingMessageAccumulator();
		const textOf = (block: AssistantMessage["content"][number] | undefined): string | undefined =>
			block?.type === "text" ? block.text : block?.type === "thinking" ? block.thinking : undefined;
		let streamed: AssistantMessage[] = [];
		let checked = 0;
		for (const frame of delta) {
			const rebuilt = deepFreeze(accumulator.apply(frame));
			if (rebuilt.type === "message_update") streamed.push(assistantOf(rebuilt));
			if (rebuilt.type !== "message_end" || rebuilt.message.role !== "assistant") continue;
			const final = rebuilt.message.content;
			// Every update, not just the last (which the `*_end` block overwrites): a text never runs ahead of its end.
			for (const message of streamed) {
				for (const [index, block] of message.content.entries()) {
					const text = textOf(block);
					if (text === undefined) continue;
					expect(textOf(final[index])?.startsWith(text)).toBe(true);
					checked++;
				}
			}
			streamed = [];
		}
		expect(checked).toBeGreaterThan(10);
	});

	test("keeps raw tool-call JSON on the block and parses arguments while streaming", () => {
		const message = makeAssistantMessage();
		message.content = [];
		const toolCall = { type: "toolCall" as const, id: "call-1", name: "edit", arguments: {} };
		const streaming = { ...message, content: [toolCall] };
		const accumulator = new StreamingMessageAccumulator();
		const { delta } = project([
			{ type: "message_start", message },
			update(streaming, { type: "toolcall_start", contentIndex: 0, partial: streaming }),
			update(streaming, { type: "toolcall_delta", contentIndex: 0, delta: '{"path":"a.ts",', partial: streaming }),
			update(streaming, { type: "toolcall_delta", contentIndex: 0, delta: '"line":3}', partial: streaming }),
		]);
		const rebuilt = delta.map(frame => deepFreeze(accumulator.apply(frame)));

		const start = assistantOf(rebuilt[1]);
		expect(start.content[0]).toMatchObject({ type: "toolCall", id: "call-1", name: "edit" });
		expect(getStreamingPartialJson(start.content[0])).toBe("");
		const first = assistantOf(rebuilt[2]).content[0];
		expect(getStreamingPartialJson(first)).toBe('{"path":"a.ts",');
		expect(first).toMatchObject({ arguments: { path: "a.ts" } });
		// The throttle skips the small second chunk's parse (as providers do); the raw JSON is always current.
		const second = assistantOf(rebuilt[3]).content[0];
		expect(getStreamingPartialJson(second)).toBe('{"path":"a.ts","line":3}');
		expect(second).toMatchObject({ arguments: { path: "a.ts" } });
	});

	test("keeps one entry per messageId while a card nests inside a streaming reply", () => {
		const message = makeAssistantMessage();
		message.content = [];
		const text = { ...message, content: [{ type: "text" as const, text: "" }] };
		const card = { role: "custom", customType: "advisor-card", content: "note" } as unknown as AgentMessage;
		const { full, delta } = project([
			{ type: "message_start", message },
			update(text, { type: "text_start", contentIndex: 0, partial: text }),
			{ type: "message_start", message: card },
			{ type: "message_end", message: card },
			update(text, { type: "text_delta", contentIndex: 0, delta: "hi", partial: text }),
			{ type: "message_end", message: text },
		]);
		const accumulator = new StreamingMessageAccumulator();
		const rebuilt = delta.map(frame => accumulator.apply(frame));
		expect(assistantOf(rebuilt[4]).content).toEqual([{ type: "text", text: "hi" }]);
		expect(rebuilt[5]).toEqual(full[5]);
		expect(() => accumulator.apply(delta[4])).toThrow("Delta update for unknown message msg-1");
	});

	test("a re-start resets the message from the event's message", () => {
		const message = makeAssistantMessage();
		const restarted = { ...message, content: [], responseId: "second" };
		const accumulator = new StreamingMessageAccumulator();
		const { delta } = project([
			{ type: "message_start", message },
			update(restarted, { type: "start", partial: restarted }),
		]);
		const rebuilt = delta.map(frame => accumulator.apply(frame));
		expect(messageOf(rebuilt[1])).toEqual({ ...restarted, content: [] });
	});

	test("fails closed on a delta for an unknown message or a start/end event without its block", () => {
		const message = makeAssistantMessage();
		const accumulator = new StreamingMessageAccumulator();
		const { delta } = project([
			{ type: "message_start", message },
			update(message, { type: "text_start", contentIndex: 5, partial: message }),
		]);
		expect(() => accumulator.apply(delta[1])).toThrow("Delta update for unknown message msg-1");
		accumulator.apply(delta[0]);
		expect(() => accumulator.apply(delta[1])).toThrow("text_start without a block");
	});

	test("tolerates blocks the host added without an event until message_end fills them", () => {
		const message = makeAssistantMessage();
		// A block kind the host adds without a start event (redactedThinking, anthropicServerTool).
		const redacted = { type: "redactedThinking" as const, data: "opaque" };
		const withHole: AssistantMessage = {
			...message,
			content: [...message.content, redacted, { type: "text", text: "" }],
		};
		const accumulator = new StreamingMessageAccumulator();
		const { full, delta } = project([
			{ type: "message_start", message },
			update(withHole, { type: "text_start", contentIndex: 2, partial: withHole }),
			update(withHole, { type: "text_delta", contentIndex: 2, delta: "after", partial: withHole }),
			{ type: "message_end", message: withHole },
		]);
		const rebuilt = delta.map(frame => accumulator.apply(frame));
		expect(assistantOf(rebuilt[2]).content).toEqual([
			{ type: "text", text: "ok" },
			{ type: "text", text: "after" },
		]);
		expect(rebuilt[3]).toEqual(full[3]);
	});

	test("full message_update frames pass through and replace the entry", () => {
		const message = makeAssistantMessage();
		const later = { ...message, content: [{ type: "text" as const, text: "okay" }] };
		const { full, delta } = project([
			{ type: "message_start", message },
			update(later, { type: "text_delta", contentIndex: 0, delta: "ay", partial: later }),
			update(later, { type: "text_end", contentIndex: 0, content: "okay", partial: later }),
		]);
		const accumulator = new StreamingMessageAccumulator();
		accumulator.apply(full[0]);
		// A full frame for a message the client never saw start (an older host, or a filter reset to full).
		expect(accumulator.apply(full[1])).toBe(full[1]);
		const resumed = new StreamingMessageAccumulator();
		resumed.apply(full[1]);
		expect(messageOf(resumed.apply(delta[2]))).toEqual(later);
	});

	test("a tool call seeded mid-stream keeps its arguments until toolcall_end, without raw JSON", () => {
		const message = makeAssistantMessage();
		const half = { type: "toolCall" as const, id: "call-1", name: "edit", arguments: { path: "a.ts" } };
		const done = { ...half, arguments: { path: "a.ts", line: 3 } };
		const seeded = { ...message, content: [half] };
		const final = { ...message, content: [done] };
		const { delta } = project([
			{ type: "message_start", message },
			update(seeded, { type: "toolcall_delta", contentIndex: 0, delta: '"line":3}', partial: seeded }),
			update(final, { type: "toolcall_end", contentIndex: 0, toolCall: done, partial: final }),
		]);
		const accumulator = new StreamingMessageAccumulator();
		// What a client seeds from `snapshot.streaming`: decoded JSON, so the raw JSON so far is gone.
		accumulator.seed("msg-1", JSON.parse(JSON.stringify(seeded)));
		const mid = assistantOf(accumulator.apply(delta[1])).content[0];
		expect(mid).toEqual(half);
		expect(getStreamingPartialJson(mid)).toBeUndefined();
		expect(assistantOf(accumulator.apply(delta[2])).content).toEqual([done]);
	});

	test("agent_end drops every entry", () => {
		const message = makeAssistantMessage();
		const { delta } = project([
			{ type: "message_start", message },
			update(message, { type: "text_delta", contentIndex: 0, delta: "!", partial: message }),
		]);
		const accumulator = new StreamingMessageAccumulator();
		accumulator.apply(delta[0]);
		accumulator.apply({ type: "agent_end", messages: [] });
		// The same messageId as before agent_end: only the clear makes it unknown.
		expect(delta[1]).toMatchObject({ messageId: "msg-1" });
		expect(() => accumulator.apply(delta[1])).toThrow("Delta update for unknown message msg-1");
	});

	test("done replaces the message with the event's final one", () => {
		const message = makeAssistantMessage();
		const final = { ...message, stopReason: "length" as const, usage: { ...message.usage, output: 9 } };
		const { delta } = project([
			{ type: "message_start", message },
			update(final, { type: "done", reason: "length", message: final }),
		]);
		const accumulator = new StreamingMessageAccumulator();
		accumulator.apply(delta[0]);
		expect(messageOf(accumulator.apply(delta[1]))).toEqual(final);
	});
});
