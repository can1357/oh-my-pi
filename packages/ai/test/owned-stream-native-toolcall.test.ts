import { describe, expect, it } from "bun:test";
import { wrapInbandToolStream } from "../src/dialect/owned-stream";
import type { AssistantMessage, AssistantMessageEvent, ThinkingContent, ToolCall, Usage } from "../src/types";
import {
	getStreamingPartialJson,
	isCursorExecResolved,
	kCursorExecResolved,
	setStreamingPartialJson,
} from "../src/utils/block-symbols";
import { AssistantMessageEventStream } from "../src/utils/event-stream";

const TOOLS = [
	{
		name: "todo",
		description: "Manage the todo list.",
		parameters: {
			type: "object",
			properties: { ops: { type: "array" } },
			required: ["ops"],
		},
	},
];

function makeAssistant(content: AssistantMessage["content"]): AssistantMessage {
	const usage: Usage = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	return {
		role: "assistant",
		content,
		api: "mock",
		provider: "mock",
		model: "mock-model",
		usage,
		stopReason: "toolUse",
		timestamp: 0,
	};
}

// Drive an inner provider stream the way openai-completions does: a single
// growing `output` message whose `content` each event's `partial` points at.
function drive(
	build: (push: (event: AssistantMessageEvent) => void, out: AssistantMessage) => void,
): AssistantMessageEventStream {
	const inner = new AssistantMessageEventStream();
	const out = makeAssistant([]);
	inner.push({ type: "start", partial: out });
	build(event => inner.push(event), out);
	inner.push({ type: "done", reason: out.stopReason === "length" ? "length" : "toolUse", message: out });
	inner.end(out);
	return inner;
}

// Gemini (via OpenRouter) keeps emitting native `tool_calls` even in owned mode
// where no `tools` are sent — the in-band scanner only reconstructs calls from
// `tool_code` text, so the projector must forward native calls (streamed) rather
// than dropping them.
function geminiNativeOnly(): AssistantMessageEventStream {
	return drive((push, out) => {
		const thinking: ThinkingContent = { type: "thinking", thinking: "Checking the todo list." };
		out.content.push(thinking);
		push({ type: "thinking_start", contentIndex: 0, partial: out });
		push({ type: "thinking_delta", contentIndex: 0, delta: thinking.thinking, partial: out });
		push({ type: "thinking_end", contentIndex: 0, content: thinking.thinking, partial: out });
		const block: ToolCall = { type: "toolCall", id: "tool_todo_abc", name: "todo", arguments: {} };
		out.content.push(block);
		push({ type: "toolcall_start", contentIndex: 1, partial: out });
		push({ type: "toolcall_delta", contentIndex: 1, delta: '{"ops":[{"op":"view"}]}', partial: out });
		block.arguments = { ops: [{ op: "view" }] };
		push({ type: "toolcall_end", contentIndex: 1, toolCall: block, partial: out });
	});
}

function controlledNativeToolArgGrowth(): {
	stream: AssistantMessageEventStream;
	pushStart: () => void;
	pushFirstDelta: () => void;
	pushSecondDelta: () => void;
	pushEnd: () => void;
	finish: () => void;
} {
	const stream = new AssistantMessageEventStream();
	const out = makeAssistant([]);
	const block: ToolCall = { type: "toolCall", id: "tool_todo_streaming", name: "todo", arguments: {} };
	stream.push({ type: "start", partial: out });

	return {
		stream,
		pushStart: () => {
			out.content.push(block);
			stream.push({ type: "toolcall_start", contentIndex: 0, partial: out });
		},
		pushFirstDelta: () => {
			setStreamingPartialJson(block, '{"ops":[');
			stream.push({ type: "toolcall_delta", contentIndex: 0, delta: '{"ops":[', partial: out });
		},
		pushSecondDelta: () => {
			block.arguments = { ops: [{ op: "view" }] };
			setStreamingPartialJson(block, '{"ops":[{"op":"view"}]}');
			stream.push({ type: "toolcall_delta", contentIndex: 0, delta: '{"op":"view"}]}', partial: out });
		},
		pushEnd: () => {
			stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: block, partial: out });
		},
		finish: () => {
			stream.push({ type: "done", reason: "toolUse", message: out });
			stream.end(out);
		},
	};
}

// A nameless native "ghost" part (Gemini emits these beside a real call) must be
// dropped, while the real native call is still forwarded.
function ghostThenRealNative(): AssistantMessageEventStream {
	return drive((push, out) => {
		const ghost: ToolCall = { type: "toolCall", id: "", name: "", arguments: {} };
		out.content.push(ghost);
		push({ type: "toolcall_start", contentIndex: 0, partial: out });
		push({ type: "toolcall_end", contentIndex: 0, toolCall: ghost, partial: out });
		const real: ToolCall = {
			type: "toolCall",
			id: "tool_todo_real",
			name: "todo",
			arguments: { ops: [{ op: "view" }] },
		};
		out.content.push(real);
		push({ type: "toolcall_start", contentIndex: 1, partial: out });
		push({ type: "toolcall_end", contentIndex: 1, toolCall: real, partial: out });
	});
}

// The duplicate-call report: Gemini writes a real in-band `tool_code` call AND
// also emits a native `functionCall`. Exactly one call must survive — the
// channel lock dedupes structurally, never by guessing from emptiness.
function inbandPlusNative(): AssistantMessageEventStream {
	return drive((push, out) => {
		const text = 'Sure.\n```tool_code\ndefault_api.todo(ops=[{"op": "view"}])\n```\n';
		const textBlock = { type: "text" as const, text };
		out.content.push(textBlock);
		push({ type: "text_delta", contentIndex: 0, delta: text, partial: out });
		const nativeDup: ToolCall = {
			type: "toolCall",
			id: "tool_todo_native",
			name: "todo",
			arguments: { ops: [{ op: "view" }] },
		};
		out.content.push(nativeDup);
		push({ type: "toolcall_start", contentIndex: 1, partial: out });
		push({ type: "toolcall_end", contentIndex: 1, toolCall: nativeDup, partial: out });
	});
}

function cloneArgs(args: Record<string, unknown>): Record<string, unknown> {
	return JSON.parse(JSON.stringify(args)) as Record<string, unknown>;
}

type ToolCallSnapshot = {
	type: "toolcall_start" | "toolcall_delta" | "toolcall_end";
	delta?: string;
	id: string;
	name: string;
	arguments: Record<string, unknown>;
	partialJson: string | undefined;
	endToolCall?: {
		id: string;
		name: string;
		arguments: Record<string, unknown>;
		partialJson: string | undefined;
	};
};

function snapshotToolCallEvent(event: AssistantMessageEvent): ToolCallSnapshot | undefined {
	if (event.type !== "toolcall_start" && event.type !== "toolcall_delta" && event.type !== "toolcall_end") {
		return undefined;
	}
	const block = event.partial.content[event.contentIndex];
	if (block?.type !== "toolCall") return undefined;
	return {
		type: event.type,
		...(event.type === "toolcall_delta" ? { delta: event.delta } : {}),
		id: block.id,
		name: block.name,
		arguments: cloneArgs(block.arguments),
		partialJson: getStreamingPartialJson(block),
		...(event.type === "toolcall_end"
			? {
					endToolCall: {
						id: event.toolCall.id,
						name: event.toolCall.name,
						arguments: cloneArgs(event.toolCall.arguments),
						partialJson: getStreamingPartialJson(event.toolCall),
					},
				}
			: {}),
	};
}

async function nextToolCallSnapshot(iterator: AsyncIterator<AssistantMessageEvent>): Promise<ToolCallSnapshot> {
	for (;;) {
		const next = await iterator.next();
		if (next.done) throw new Error("stream ended before the next tool-call event");
		const snapshot = snapshotToolCallEvent(next.value);
		if (snapshot) return snapshot;
	}
}

async function collect(stream: AssistantMessageEventStream): Promise<{ message: AssistantMessage; events: string[] }> {
	const events: string[] = [];
	for await (const event of stream) events.push(event.type);
	return { message: await stream.result(), events };
}

describe("wrapInbandToolStream native tool-call passthrough", () => {
	it("preserves the provider call id and streamed argument state across native deltas", async () => {
		const controlled = controlledNativeToolArgGrowth();
		const stream = wrapInbandToolStream(controlled.stream, TOOLS, "gemini");
		const iterator = stream[Symbol.asyncIterator]();

		const startPromise = nextToolCallSnapshot(iterator);
		controlled.pushStart();
		const start = await startPromise;

		const firstDeltaPromise = nextToolCallSnapshot(iterator);
		controlled.pushFirstDelta();
		const firstDelta = await firstDeltaPromise;

		const secondDeltaPromise = nextToolCallSnapshot(iterator);
		controlled.pushSecondDelta();
		const secondDelta = await secondDeltaPromise;

		const endPromise = nextToolCallSnapshot(iterator);
		controlled.pushEnd();
		const end = await endPromise;

		controlled.finish();
		const message = await stream.result();

		expect([start, firstDelta, secondDelta, end]).toEqual([
			{
				type: "toolcall_start",
				id: "tool_todo_streaming",
				name: "todo",
				arguments: {},
				partialJson: undefined,
			},
			{
				type: "toolcall_delta",
				delta: '{"ops":[',
				id: "tool_todo_streaming",
				name: "todo",
				arguments: {},
				partialJson: '{"ops":[',
			},
			{
				type: "toolcall_delta",
				delta: '{"op":"view"}]}',
				id: "tool_todo_streaming",
				name: "todo",
				arguments: { ops: [{ op: "view" }] },
				partialJson: '{"ops":[{"op":"view"}]}',
			},
			{
				type: "toolcall_end",
				id: "tool_todo_streaming",
				name: "todo",
				arguments: { ops: [{ op: "view" }] },
				partialJson: '{"ops":[{"op":"view"}]}',
				endToolCall: {
					id: "tool_todo_streaming",
					name: "todo",
					arguments: { ops: [{ op: "view" }] },
					partialJson: '{"ops":[{"op":"view"}]}',
				},
			},
		]);

		const calls = message.content.filter((b): b is ToolCall => b.type === "toolCall");
		expect(calls).toHaveLength(1);
		expect(calls[0]!.id).toBe("tool_todo_streaming");
		expect(calls[0]!.name).toBe("todo");
		expect(calls[0]!.arguments).toEqual({ ops: [{ op: "view" }] });
	});

	it("streams a provider-native tool call that arrives without in-band text", async () => {
		const { message, events } = await collect(wrapInbandToolStream(geminiNativeOnly(), TOOLS, "gemini"));

		const calls = message.content.filter((b): b is ToolCall => b.type === "toolCall");
		expect(calls).toHaveLength(1);
		expect(calls[0]!.name).toBe("todo");
		expect(calls[0]!.id).toBe("tool_todo_abc");
		expect(calls[0]!.arguments).toEqual({ ops: [{ op: "view" }] });
		// Reasoning is preserved alongside the forwarded call.
		expect(message.content.some(b => b.type === "thinking")).toBe(true);
		// A turn with a tool call is "toolUse", never a content-less "stop".
		expect(message.stopReason).toBe("toolUse");
		// The full lifecycle streams live (not materialized in one shot at the end).
		expect(events).toContain("toolcall_start");
		expect(events).toContain("toolcall_delta");
		expect(events).toContain("toolcall_end");
	});

	it("preserves kCursorExecResolved across the owned/in-band projector", async () => {
		// Cursor + tools.format: gemini wraps every provider stream in
		// wrapInbandToolStream. The projector rebuilds toolCall objects
		// field-by-field; dropping the exec-resolved marker lets agent-loop
		// re-run a call Cursor already settled.
		const inner = drive((push, out) => {
			const block: ToolCall = {
				type: "toolCall",
				id: "cursor-bash-1",
				name: "bash",
				arguments: { command: "echo hi" },
			};
			(block as ToolCall & { [kCursorExecResolved]?: true })[kCursorExecResolved] = true;
			out.content.push(block);
			push({ type: "toolcall_start", contentIndex: 0, partial: out });
			push({ type: "toolcall_end", contentIndex: 0, toolCall: block, partial: out });
		});
		const { message } = await collect(wrapInbandToolStream(inner, TOOLS, "gemini"));
		const calls = message.content.filter((b): b is ToolCall => b.type === "toolCall");
		expect(calls).toHaveLength(1);
		expect(isCursorExecResolved(calls[0])).toBe(true);
	});

	it("drops a nameless native ghost but keeps the real native call", async () => {
		const { message } = await collect(wrapInbandToolStream(ghostThenRealNative(), TOOLS, "gemini"));
		const calls = message.content.filter((b): b is ToolCall => b.type === "toolCall");
		expect(calls).toHaveLength(1);
		expect(calls[0]!.name).toBe("todo");
		expect(calls[0]!.id).toBe("tool_todo_real");
	});

	it("emits exactly one call when the model uses both the in-band and native channels", async () => {
		const { message } = await collect(wrapInbandToolStream(inbandPlusNative(), TOOLS, "gemini"));
		const calls = message.content.filter((b): b is ToolCall => b.type === "toolCall");
		// No double-dispatch, regardless of which channel won the lock.
		expect(calls).toHaveLength(1);
		expect(calls[0]!.name).toBe("todo");
		expect(calls[0]!.arguments).toEqual({ ops: [{ op: "view" }] });
	});
});
