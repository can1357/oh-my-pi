import { describe, expect, it } from "bun:test";
import {
	type BlockState,
	flushOpenToolCalls,
	mergeCursorMcpToolCallArgs,
	processInteractionUpdate,
	synthesizeCursorExecToolCall,
	type ToolCallState,
	type UsageState,
} from "@oh-my-pi/pi-ai/providers/cursor";
import type { AssistantMessage, AssistantMessageEvent } from "@oh-my-pi/pi-ai/types";
import { getStreamingPartialJson, kCursorExecResolved } from "@oh-my-pi/pi-ai/utils/block-symbols";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";

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
		openToolCalls: new Map(),
		resolvedMcpToolCallIds: new Set(),
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

function startMcpToolCall(h: Harness, name: string, id = "call-1", args?: Record<string, Uint8Array>): void {
	processInteractionUpdate(
		{
			message: {
				case: "toolCallStarted",
				value: {
					callId: id,
					toolCall: {
						mcpToolCall: { args: { name, toolName: name, toolCallId: id, args } },
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

describe("Cursor MCP exec resolution", () => {
	it("marks a streamed MCP call already resolved by the exec bridge", () => {
		const h = newHarness();
		h.state.resolvedMcpToolCallIds.add("call-resolved");

		startMcpToolCall(h, "mcp__fixture_report", "call-resolved");

		const block = h.output.content[0] as ToolCallState;
		expect(block[kCursorExecResolved]).toBe(true);
		expect(h.state.resolvedMcpToolCallIds.size).toBe(0);
	});

	it("does not duplicate an MCP call synthesized from an earlier exec frame", () => {
		const h = newHarness();
		synthesizeCursorExecToolCall(h.output, h.stream, h.state, "call-resolved", "web_search", {
			query: "latest chess news",
		});
		h.state.resolvedMcpToolCallIds.add("call-resolved");

		startMcpToolCall(h, "web_search", "call-resolved");

		expect(h.output.content).toHaveLength(1);
		expect(h.output.content[0]).toMatchObject({
			type: "toolCall",
			id: "call-resolved",
			name: "web_search",
			arguments: { query: "latest chess news" },
		});
		expect(h.captured.map(event => event.type)).toEqual(["toolcall_start", "toolcall_end"]);
		expect(h.state.resolvedMcpToolCallIds.size).toBe(0);
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
	it("preserves announced args when Cursor streams no argument deltas", () => {
		const h = newHarness();
		startMcpToolCall(h, "get_weather", "call-weather", {
			city: new TextEncoder().encode(`"Paris"`),
		});

		completeMcpToolCall(h, undefined);

		expect(h.output.content[0]).toMatchObject({
			type: "toolCall",
			id: "call-weather",
			name: "get_weather",
			arguments: { city: "Paris" },
		});
		expect(h.captured.map(event => event.type)).toEqual(["toolcall_start", "toolcall_end"]);
	});

	it("preserves announced args when the stream ends before tool completion", () => {
		const h = newHarness();
		startMcpToolCall(h, "get_weather", "call-weather", {
			city: new TextEncoder().encode(`"Paris"`),
		});

		flushOpenToolCalls(h.output, h.stream, h.state);

		expect(h.output.content[0]).toMatchObject({
			type: "toolCall",
			id: "call-weather",
			name: "get_weather",
			arguments: { city: "Paris" },
		});
		expect(h.state.currentToolCall).toBeNull();
		expect(h.captured.map(event => event.type)).toEqual(["toolcall_start", "toolcall_end"]);
	});

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
		expect(getStreamingPartialJson(block)).toBe(cumulative[cumulative.length - 1]);

		// Each cumulative snapshot only emits the new suffix as the delta event.
		const deltas = h.captured.filter(e => e.type === "toolcall_delta").map(e => (e as { delta: string }).delta);
		expect(deltas.join("")).toBe(cumulative[cumulative.length - 1]);
		expect(deltas).toEqual([`{"agent":"task","tas`, `ks":[{"assignme`, `nt":"do A"},{"assignment":"do B"}]}`]);

		// The delta path throttles mid-stream parses; the authoritative full parse
		// runs at toolCallCompleted, so the finalized block carries the full args.
		completeMcpToolCall(h, undefined);
		const finalBlock = h.output.content[0];
		expect(finalBlock?.type).toBe("toolCall");
		if (finalBlock?.type !== "toolCall") throw new Error("expected toolCall block");
		expect(finalBlock.arguments).toEqual({
			agent: "task",
			tasks: [{ assignment: "do A" }, { assignment: "do B" }],
		});
	});

	it("still appends genuinely incremental argsTextDelta fragments", () => {
		const h = newHarness();
		startMcpToolCall(h, "task");

		const fragments = [`{"agent":`, `"task",`, `"items":[1,2,3]}`];
		for (const fragment of fragments) {
			pushArgsTextDelta(h, fragment);
		}

		expect(getStreamingPartialJson(h.state.currentToolCall!)).toBe(fragments.join(""));

		// Finalize to observe the authoritative full parse (delta path is throttled).
		completeMcpToolCall(h, undefined);
		const finalBlock = h.output.content[0];
		expect(finalBlock?.type).toBe("toolCall");
		if (finalBlock?.type !== "toolCall") throw new Error("expected toolCall block");
		expect(finalBlock.arguments).toEqual({ agent: "task", items: [1, 2, 3] });
	});

	it("throttles mid-stream arg parsing to bound work at O(N) in buffer length (issue #3946)", () => {
		// Regression for the O(N²) streaming hot path: parseStreamingJson used to
		// run on every delta, re-parsing the entire accumulated buffer each time.
		// With parseStreamingJsonThrottled, mid-stream re-parses only fire once
		// the buffer has grown by at least STREAMING_JSON_PARSE_MIN_GROWTH bytes.
		const h = newHarness();
		startMcpToolCall(h, "task");

		// First snapshot: initial parse fires (lastParsedLen was 0).
		pushArgsTextDelta(h, `{"agent":"task","note":"initial"`);
		const block = h.state.currentToolCall!;
		const argsAfterFirst = block.arguments;
		expect(argsAfterFirst).toEqual({ agent: "task", note: "initial" });

		// Tiny follow-up snapshots that grow the buffer by far less than the
		// throttle threshold. block.arguments must NOT be re-parsed; if it were,
		// the O(N²) regression would resurface for a long stream of small deltas.
		pushArgsTextDelta(h, `{"agent":"task","note":"initial","step":1`);
		pushArgsTextDelta(h, `{"agent":"task","note":"initial","step":12`);
		expect(block.arguments).toBe(argsAfterFirst);

		// The full buffer is still accumulated for the authoritative final parse.
		expect(getStreamingPartialJson(block)).toBe(`{"agent":"task","note":"initial","step":12`);

		// toolCallCompleted re-parses the full buffer unconditionally; the merged
		// arguments reflect every byte streamed, including the throttled tail.
		completeMcpToolCall(h, undefined);
		const finalBlock = h.output.content[0];
		expect(finalBlock?.type).toBe("toolCall");
		if (finalBlock?.type !== "toolCall") throw new Error("expected toolCall block");
		expect(finalBlock.arguments).toEqual({ agent: "task", note: "initial", step: 12 });
	});

	it("skips empty argsTextDelta snapshots without emitting a delta event", () => {
		const h = newHarness();
		startMcpToolCall(h, "task");

		pushArgsTextDelta(h, `{"agent":"task"}`);
		pushArgsTextDelta(h, `{"agent":"task"}`);
		pushArgsTextDelta(h, "");

		expect(getStreamingPartialJson(h.state.currentToolCall!)).toBe(`{"agent":"task"}`);
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

describe("synthesizeCursorExecToolCall (issue #4348)", () => {
	it("closes preceding text/thinking blocks before opening the synthesized toolCall", () => {
		const h = newHarness();

		pushTextDelta(h, "reading ");
		synthesizeCursorExecToolCall(h.output, h.stream, h.state, "call-read", "read", { path: "src/foo.ts" });

		expect(h.output.content.map(b => b.type)).toEqual(["text", "toolCall"]);
		expect(h.output.content[0]).toMatchObject({ type: "text", text: "reading " });
		expect(h.output.content[1]).toMatchObject({
			type: "toolCall",
			id: "call-read",
			name: "read",
			arguments: { path: "src/foo.ts" },
		});
		// text_end fires before toolcall_start so the preceding text block finalizes;
		// toolcall_end fires immediately after — exec-channel args arrive complete,
		// so no partial-JSON streaming is needed for the synthesized block.
		expect(h.captured.map(e => e.type)).toEqual([
			"text_start",
			"text_delta",
			"text_end",
			"toolcall_start",
			"toolcall_end",
		]);
		expect(h.state.currentTextBlock).toBeNull();
		expect(h.state.currentToolCall).toBeNull();
	});

	it("preserves interleaving order across text ↔ tool ↔ text", () => {
		const h = newHarness();

		pushTextDelta(h, "planning ");
		synthesizeCursorExecToolCall(h.output, h.stream, h.state, "t1", "read", { path: "a.txt" });
		pushTextDelta(h, "then ");
		synthesizeCursorExecToolCall(h.output, h.stream, h.state, "t2", "bash", {
			command: "echo hi",
			cwd: undefined,
			timeout: undefined,
		});
		pushTextDelta(h, "done");

		expect(h.output.content.map(b => b.type)).toEqual(["text", "toolCall", "text", "toolCall", "text"]);
		const [t1, tc1, t2, tc2, t3] = h.output.content;
		expect(t1).toMatchObject({ type: "text", text: "planning " });
		expect(tc1).toMatchObject({ type: "toolCall", id: "t1", name: "read" });
		expect(t2).toMatchObject({ type: "text", text: "then " });
		expect(tc2).toMatchObject({
			type: "toolCall",
			id: "t2",
			name: "bash",
			// Undefined optional kwargs are dropped so ArkType optional-field
			// validation does not reject the synthesized block.
			arguments: { command: "echo hi" },
		});
		expect(t3).toMatchObject({ type: "text", text: "done" });
	});

	it("omits undefined optional kwargs from synthesized exec tool args", () => {
		const h = newHarness();
		synthesizeCursorExecToolCall(h.output, h.stream, h.state, "bash-1", "bash", {
			command: "pwd",
			cwd: undefined,
			timeout: 30,
		});
		synthesizeCursorExecToolCall(h.output, h.stream, h.state, "grep-1", "grep", {
			pattern: "needle",
			path: ".",
			case: undefined,
			skip: undefined,
		});
		const [bashCall, grepCall] = h.output.content;
		expect(bashCall).toMatchObject({
			type: "toolCall",
			id: "bash-1",
			name: "bash",
			arguments: { command: "pwd", timeout: 30 },
		});
		expect(Object.hasOwn((bashCall as { arguments: object }).arguments, "cwd")).toBe(false);
		expect(grepCall).toMatchObject({
			type: "toolCall",
			id: "grep-1",
			name: "grep",
			arguments: { pattern: "needle", path: "." },
		});
		expect(Object.hasOwn((grepCall as { arguments: object }).arguments, "case")).toBe(false);
		expect(Object.hasOwn((grepCall as { arguments: object }).arguments, "skip")).toBe(false);
	});

	it("emits toolcall events at the exact index the block occupies in content", () => {
		const h = newHarness();

		pushTextDelta(h, "pre");
		synthesizeCursorExecToolCall(h.output, h.stream, h.state, "call-1", "grep", {
			pattern: "foo",
			path: ".",
			case: undefined,
		});

		const toolStart = h.captured.find(e => e.type === "toolcall_start");
		const toolEnd = h.captured.find(e => e.type === "toolcall_end");
		// Text block sits at index 0; synthesized toolCall at index 1.
		expect(toolStart).toMatchObject({ type: "toolcall_start", contentIndex: 1 });
		expect(toolEnd).toMatchObject({
			type: "toolcall_end",
			contentIndex: 1,
			toolCall: { id: "call-1", name: "grep" },
		});
	});
});
