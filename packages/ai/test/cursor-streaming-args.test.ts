import { describe, expect, it } from "bun:test";
import {
	type BlockState,
	mergeCursorMcpToolCallArgs,
	processInteractionUpdate,
	type ToolCallState,
	type UsageState,
} from "@pk-nerdsaver-ai/pi-ai/providers/cursor";
import type { AssistantMessage, AssistantMessageEvent } from "@pk-nerdsaver-ai/pi-ai/types";
import { AssistantMessageEventStream } from "@pk-nerdsaver-ai/pi-ai/utils/event-stream";

interface Harness {
	output: AssistantMessage;
	stream: AssistantMessageEventStream;
	captured: AssistantMessageEvent[];
	state: BlockState;
	usageState: UsageState;
}

function newHarness(): Harness {
	const output: AssistantMessage = {
		role: "assistant",
		content: [],
		api: "cursor-agent",
		provider: "cursor",
		model: "cursor-composer-2.5",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
	};
	const stream = new AssistantMessageEventStream();
	const captured: AssistantMessageEvent[] = [];
	const origPush = stream.push.bind(stream);
	stream.push = (event: AssistantMessageEvent) => {
		captured.push(event);
		origPush(event);
	};

	let textBlock: BlockState["currentTextBlock"] = null;
	let thinkingBlock: BlockState["currentThinkingBlock"] = null;
	let toolCall: ToolCallState | null = null;
	const state: BlockState = {
		get currentTextBlock() {
			return textBlock;
		},
		get currentThinkingBlock() {
			return thinkingBlock;
		},
		get currentToolCall() {
			return toolCall;
		},
		firstTokenTime: undefined,
		setTextBlock: b => {
			textBlock = b;
		},
		setThinkingBlock: b => {
			thinkingBlock = b;
		},
		setToolCall: t => {
			toolCall = t;
		},
		setFirstTokenTime: () => {},
	};
	return { output, stream, captured, state, usageState: { sawTokenDelta: false } };
}

function startMcpToolCall(h: Harness, name: string, id = "call-1"): void {
	processInteractionUpdate(
		{
			message: {
				case: "toolCallStarted",
				value: {
					callId: id,
					toolCall: {
						mcpToolCall: { args: { name, toolName: name, toolCallId: id } },
					},
				},
			},
		},
		h.output,
		h.stream,
		h.state,
		h.usageState,
	);
}

function pushArgsTextDelta(h: Harness, argsTextDelta: string): void {
	processInteractionUpdate(
		{ message: { case: "partialToolCall", value: { argsTextDelta } } },
		h.output,
		h.stream,
		h.state,
		h.usageState,
	);
}

function completeMcpToolCall(h: Harness, args: Record<string, Uint8Array> | undefined): void {
	processInteractionUpdate(
		{
			message: {
				case: "toolCallCompleted",
				value: { toolCall: { mcpToolCall: { args: { args } } } },
			},
		},
		h.output,
		h.stream,
		h.state,
		h.usageState,
	);
}

function pushTextDelta(h: Harness, text: string): void {
	processInteractionUpdate(
		{ message: { case: "textDelta", value: { text } } },
		h.output,
		h.stream,
		h.state,
		h.usageState,
	);
}

describe("mergeCursorMcpToolCallArgs", () => {
	it("returns streamed args unchanged when completion is undefined", () => {
		const streamed = { tasks: [{ assignment: "do" }], context: "ctx" };
		expect(mergeCursorMcpToolCallArgs(streamed, undefined)).toEqual(streamed);
	});

	it("preserves streamed keys the completion frame omits", () => {
		// Issue #2615: the completion frame's McpArgs map drops oversized
		// parameters. The task tool's `tasks` array was being lost when only
		// the smaller `context` key survived the completion frame.
		const streamed = { tasks: [{ assignment: "do A" }, { assignment: "do B" }], context: "ctx" };
		const completion = { context: "ctx" };
		expect(mergeCursorMcpToolCallArgs(streamed, completion)).toEqual({
			tasks: [{ assignment: "do A" }, { assignment: "do B" }],
			context: "ctx",
		});
	});

	it("adopts scalar values from the completion frame when present", () => {
		const streamed = { agent: "task", context: "partial" };
		const completion = { agent: "task", context: "final" };
		expect(mergeCursorMcpToolCallArgs(streamed, completion)).toEqual({ agent: "task", context: "final" });
	});

	it("keeps the streamed structured value when completion downgrades to a raw string", () => {
		// decodeMcpArgValue returns the raw decoded string when the byte payload
		// cannot be parsed as JSON. The streamed JSON is structurally richer, so
		// merge must prefer it over the string fallback.
		const streamed = { tasks: [{ assignment: "do A" }] };
		const completion = { tasks: "[{assignment: 'do A'}]" };
		expect(mergeCursorMcpToolCallArgs(streamed, completion)).toEqual({ tasks: [{ assignment: "do A" }] });
	});

	it("accepts completion-only keys that the streamed args never carried", () => {
		const streamed = { agent: "task" };
		const completion = { agent: "task", model: "default" };
		expect(mergeCursorMcpToolCallArgs(streamed, completion)).toEqual({ agent: "task", model: "default" });
	});

	it("returns an empty object when both sides are absent", () => {
		expect(mergeCursorMcpToolCallArgs(undefined, undefined)).toEqual({});
	});
});

describe("processInteractionUpdate content block ordering", () => {
	it("opens a new text block after a completed tool call", () => {
		const h = newHarness();

		pushTextDelta(h, "before ");
		startMcpToolCall(h, "bash");
		completeMcpToolCall(h, undefined);
		pushTextDelta(h, "after");

		expect(h.output.content.map(block => block.type)).toEqual(["text", "toolCall", "text"]);
		expect(h.output.content[0]).toMatchObject({ type: "text", text: "before " });
		expect(h.output.content[1]).toMatchObject({ type: "toolCall", name: "bash" });
		expect(h.output.content[2]).toMatchObject({ type: "text", text: "after" });
		expect(h.captured.map(event => event.type)).toEqual([
			"text_start",
			"text_delta",
			"text_end",
			"toolcall_start",
			"toolcall_end",
			"text_start",
			"text_delta",
		]);
	});
});

describe("processInteractionUpdate args_text_delta handling", () => {
	it("treats cumulative argsTextDelta snapshots as snapshots, not append-only fragments", () => {
		const h = newHarness();
		startMcpToolCall(h, "task");

		// Cursor emits aggregated args text so far on each delta.
		const cumulative = [
			`{"agent":"task","tas`,
			`{"agent":"task","tasks":[{"assignme`,
			`{"agent":"task","tasks":[{"assignment":"do A"},{"assignment":"do B"}]}`,
		];
		for (const snapshot of cumulative) {
			pushArgsTextDelta(h, snapshot);
		}

		const block = h.state.currentToolCall!;
		expect(block.partialJson).toBe(cumulative[cumulative.length - 1]);
		expect(block.arguments).toEqual({
			agent: "task",
			tasks: [{ assignment: "do A" }, { assignment: "do B" }],
		});

		// Each cumulative snapshot only emits the new suffix as the delta event.
		const deltas = h.captured.filter(e => e.type === "toolcall_delta").map(e => (e as { delta: string }).delta);
		expect(deltas.join("")).toBe(cumulative[cumulative.length - 1]);
		expect(deltas).toEqual([`{"agent":"task","tas`, `ks":[{"assignme`, `nt":"do A"},{"assignment":"do B"}]}`]);
	});

	it("still appends genuinely incremental argsTextDelta fragments", () => {
		const h = newHarness();
		startMcpToolCall(h, "task");

		const fragments = [`{"agent":`, `"task",`, `"items":[1,2,3]}`];
		for (const fragment of fragments) {
			pushArgsTextDelta(h, fragment);
		}

		expect(h.state.currentToolCall!.partialJson).toBe(fragments.join(""));
		expect(h.state.currentToolCall!.arguments).toEqual({ agent: "task", items: [1, 2, 3] });
	});

	it("skips empty argsTextDelta snapshots without emitting a delta event", () => {
		const h = newHarness();
		startMcpToolCall(h, "task");

		pushArgsTextDelta(h, `{"agent":"task"}`);
		pushArgsTextDelta(h, `{"agent":"task"}`);
		pushArgsTextDelta(h, "");

		expect(h.state.currentToolCall!.partialJson).toBe(`{"agent":"task"}`);
		const deltas = h.captured.filter(e => e.type === "toolcall_delta");
		expect(deltas).toHaveLength(1);
	});

	it("preserves the streamed tasks array when the completion frame omits it (issue #2615)", () => {
		const h = newHarness();
		startMcpToolCall(h, "task");

		const fullArgs = `{"agent":"task","tasks":[{"assignment":"do A"},{"assignment":"do B"}],"context":"ctx"}`;
		// Multiple cumulative snapshots to ensure the delta path is exercised.
		pushArgsTextDelta(h, fullArgs.slice(0, 30));
		pushArgsTextDelta(h, fullArgs.slice(0, 60));
		pushArgsTextDelta(h, fullArgs);

		// Completion frame's McpArgs map omits the oversized `tasks` key but
		// still carries the smaller scalars.
		completeMcpToolCall(h, {
			agent: new TextEncoder().encode(`"task"`),
			context: new TextEncoder().encode(`"ctx"`),
		});

		expect(h.state.currentToolCall).toBeNull();
		const finalBlock = h.output.content[0];
		expect(finalBlock?.type).toBe("toolCall");
		if (finalBlock?.type !== "toolCall") throw new Error("expected toolCall block");
		expect(finalBlock.arguments).toEqual({
			agent: "task",
			tasks: [{ assignment: "do A" }, { assignment: "do B" }],
			context: "ctx",
		});
	});
});
