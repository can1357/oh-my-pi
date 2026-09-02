// Terminal-event contracts for `processResponsesStream`:
//
// 1. `response.incomplete` is a terminal frame (max_output_tokens / content
//    filter truncation). It must populate usage and normally map to stopReason
//    "length", while a fully streamed function call remains executable as
//    "toolUse".
// 2. `response.output_item.done` for a custom_tool_call must persist the final
//    input on the stored content block and drop the transient `partialJson`
//    accumulation buffer, mirroring the function_call branch.
import { describe, expect, test } from "bun:test";
import type { ResponseStreamEvent } from "@oh-my-pi/pi-ai/providers/openai-responses-wire";
import { processResponsesStream } from "@oh-my-pi/pi-ai/providers/openai-shared";
import type { AssistantMessage, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

function makeModel(): Model<"openai-responses"> {
	return buildModel({
		api: "openai-responses",
		name: "GPT Test",
		id: "gpt-test",
		provider: "openai",
		baseUrl: "https://api.openai.com/v1",
		contextWindow: 8192,
		maxTokens: 2048,
		input: ["text"],
		reasoning: false,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	});
}

function makeOutput(): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		timestamp: Date.now(),
		provider: "openai",
		model: "gpt-test",
		api: "openai-responses",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
	};
}

async function* makeStream(events: unknown[]): AsyncIterable<ResponseStreamEvent> {
	for (const e of events) yield e as ResponseStreamEvent;
}

type EmittedEvent = { type?: string } & Record<string, unknown>;

describe("processResponsesStream: terminal events", () => {
	test("maps response.incomplete to a length stop with usage populated", async () => {
		const output = makeOutput();
		const emitted: EmittedEvent[] = [];
		const stream = { push: (e: unknown) => emitted.push(e as EmittedEvent), end: () => {} } as never;

		await processResponsesStream(
			makeStream([
				{
					type: "response.output_item.added",
					output_index: 0,
					item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] },
				},
				{
					type: "response.content_part.added",
					output_index: 0,
					item_id: "msg_1",
					part: { type: "output_text", text: "", annotations: [] },
				},
				{
					type: "response.output_text.delta",
					output_index: 0,
					item_id: "msg_1",
					delta: "Hello, trunc",
				},
				{
					type: "response.output_item.done",
					output_index: 0,
					item: {
						type: "message",
						id: "msg_1",
						role: "assistant",
						status: "incomplete",
						content: [{ type: "output_text", text: "Hello, trunc", annotations: [] }],
					},
				},
				{
					type: "response.incomplete",
					sequence_number: 5,
					response: {
						id: "resp_incomplete",
						status: "incomplete",
						incomplete_details: { reason: "max_output_tokens" },
						usage: {
							input_tokens: 7,
							output_tokens: 9,
							total_tokens: 16,
							input_tokens_details: { cached_tokens: 2 },
						},
					},
				},
			]),
			output,
			stream,
			makeModel(),
		);

		expect(output.stopReason).toBe("length");
		expect(output.responseId).toBe("resp_incomplete");
		expect(output.usage.input).toBe(5);
		expect(output.usage.cacheRead).toBe(2);
		expect(output.usage.output).toBe(9);
		expect(output.usage.totalTokens).toBe(16);
		expect(output.content).toEqual([expect.objectContaining({ type: "text", text: "Hello, trunc" })]);
	});

	test("promotes max-output incomplete function calls with strict-complete arguments", async () => {
		const output = makeOutput();
		const stream = { push: () => {}, end: () => {} } as never;

		await processResponsesStream(
			makeStream([
				{
					type: "response.output_item.added",
					output_index: 0,
					item: {
						type: "function_call",
						id: "fc_complete",
						call_id: "call_complete",
						name: "read",
						arguments: "",
					},
				},
				{
					type: "response.function_call_arguments.delta",
					output_index: 0,
					item_id: "fc_complete",
					delta: '{"path":"complete.txt"} \n\t',
				},
				{
					type: "response.incomplete",
					response: {
						id: "resp_complete_call",
						status: "incomplete",
						incomplete_details: { reason: "max_output_tokens" },
					},
				},
			]),
			output,
			stream,
			makeModel(),
		);

		expect(output.stopReason).toBe("toolUse");
		expect(output.content).toHaveLength(1);
		const block = output.content[0];
		if (block?.type !== "toolCall") throw new Error("expected a toolCall block");
		expect(block.arguments).toEqual({ path: "complete.txt" });
	});

	test("keeps max-output incomplete function calls at length when only output_item.done closes arguments", async () => {
		const output = makeOutput();
		const stream = { push: () => {}, end: () => {} } as never;

		await processResponsesStream(
			makeStream([
				{
					type: "response.output_item.added",
					output_index: 0,
					item: {
						type: "function_call",
						id: "fc_closed",
						call_id: "call_closed",
						name: "read",
						arguments: "",
					},
				},
				{
					type: "response.function_call_arguments.delta",
					output_index: 0,
					item_id: "fc_closed",
					delta: '{"path":"closed.txt"}',
				},
				{
					type: "response.output_item.done",
					output_index: 0,
					item: {
						type: "function_call",
						id: "fc_closed",
						call_id: "call_closed",
						name: "read",
						arguments: '{"path":"closed.txt"}',
					},
				},
				{
					type: "response.incomplete",
					response: {
						id: "resp_closed_call",
						status: "incomplete",
						incomplete_details: { reason: "max_output_tokens" },
					},
				},
			]),
			output,
			stream,
			makeModel(),
		);

		expect(output.stopReason).toBe("length");
		expect(output.content).toEqual([
			expect.objectContaining({ type: "toolCall", arguments: { path: "closed.txt" } }),
		]);
	});

	test("promotes max-output incomplete custom tool calls closed by input done", async () => {
		const output = makeOutput();
		const stream = { push: () => {}, end: () => {} } as never;
		const patch = "*** Begin Patch\n*** End Patch";

		await processResponsesStream(
			makeStream([
				{
					type: "response.output_item.added",
					output_index: 0,
					item: {
						type: "custom_tool_call",
						id: "ctc_closed",
						call_id: "call_custom_closed",
						name: "apply_patch",
						input: "",
					},
				},
				{
					type: "response.custom_tool_call_input.delta",
					output_index: 0,
					item_id: "ctc_closed",
					delta: patch,
				},
				{
					type: "response.custom_tool_call_input.done",
					output_index: 0,
					item_id: "ctc_closed",
					input: patch,
				},
				{
					type: "response.incomplete",
					response: {
						id: "resp_closed_custom",
						status: "incomplete",
						incomplete_details: { reason: "max_output_tokens" },
					},
				},
			]),
			output,
			stream,
			makeModel(),
		);

		expect(output.stopReason).toBe("toolUse");
		expect(output.content).toEqual([
			expect.objectContaining({ type: "toolCall", customWireName: "apply_patch", arguments: { input: patch } }),
		]);
	});

	test("keeps max-output incomplete custom tools at length when only output_item.done closes input", async () => {
		const output = makeOutput();
		const stream = { push: () => {}, end: () => {} } as never;
		const patch = "*** Begin Patch\n*** End Patch";

		await processResponsesStream(
			makeStream([
				{
					type: "response.output_item.added",
					output_index: 0,
					item: {
						type: "custom_tool_call",
						id: "ctc_output_done",
						call_id: "call_custom_output_done",
						name: "apply_patch",
						input: "",
					},
				},
				{
					type: "response.output_item.done",
					output_index: 0,
					item: {
						type: "custom_tool_call",
						id: "ctc_output_done",
						call_id: "call_custom_output_done",
						name: "apply_patch",
						input: patch,
					},
				},
				{
					type: "response.incomplete",
					response: {
						id: "resp_output_done_custom",
						status: "incomplete",
						incomplete_details: { reason: "max_output_tokens" },
					},
				},
			]),
			output,
			stream,
			makeModel(),
		);

		expect(output.stopReason).toBe("length");
		expect(output.content).toEqual([
			expect.objectContaining({ type: "toolCall", customWireName: "apply_patch", arguments: { input: patch } }),
		]);
	});

	test("keeps max-output incomplete turns at length when any function call has a JSON prefix", async () => {
		const output = makeOutput();
		const stream = { push: () => {}, end: () => {} } as never;

		await processResponsesStream(
			makeStream([
				{
					type: "response.output_item.added",
					output_index: 0,
					item: {
						type: "function_call",
						id: "fc_first",
						call_id: "call_first",
						name: "read",
						arguments: "",
					},
				},
				{
					type: "response.function_call_arguments.delta",
					output_index: 0,
					item_id: "fc_first",
					delta: '{"path":"complete.txt"}',
				},
				{
					type: "response.output_item.added",
					output_index: 1,
					item: {
						type: "function_call",
						id: "fc_second",
						call_id: "call_second",
						name: "read",
						arguments: "",
					},
				},
				{
					type: "response.function_call_arguments.delta",
					output_index: 1,
					item_id: "fc_second",
					delta: '{"path":"truncated.txt"',
				},
				{
					type: "response.incomplete",
					response: {
						id: "resp_truncated_call",
						status: "incomplete",
						incomplete_details: { reason: "max_output_tokens" },
					},
				},
			]),
			output,
			stream,
			makeModel(),
		);

		expect(output.stopReason).toBe("length");
	});

	test("keeps max-output incomplete unfinished custom-tool input at length", async () => {
		const output = makeOutput();
		const stream = { push: () => {}, end: () => {} } as never;

		await processResponsesStream(
			makeStream([
				{
					type: "response.output_item.added",
					output_index: 0,
					item: {
						type: "function_call",
						id: "fc_with_custom",
						call_id: "call_with_custom",
						name: "read",
						arguments: "",
					},
				},
				{
					type: "response.function_call_arguments.delta",
					output_index: 0,
					item_id: "fc_with_custom",
					delta: '{"path":"complete.txt"}',
				},
				{
					type: "response.output_item.added",
					output_index: 1,
					item: {
						type: "custom_tool_call",
						id: "ctc_unfinished",
						call_id: "call_unfinished",
						name: "apply_patch",
						input: "",
					},
				},
				{
					type: "response.custom_tool_call_input.delta",
					output_index: 1,
					item_id: "ctc_unfinished",
					delta: "*** Begin Patch",
				},
				{
					type: "response.incomplete",
					response: {
						id: "resp_unfinished_custom",
						status: "incomplete",
						incomplete_details: { reason: "max_output_tokens" },
					},
				},
			]),
			output,
			stream,
			makeModel(),
		);

		expect(output.stopReason).toBe("length");
		const customCall = output.content.find(block => block.type === "toolCall" && block.customWireName !== undefined);
		expect(customCall).toEqual(
			expect.objectContaining({
				type: "toolCall",
				customWireName: "apply_patch",
				arguments: { input: "*** Begin Patch" },
			}),
		);
	});

	for (const testCase of [
		{
			name: "absent terminal content preserves streamed text",
			deltas: ["Hello", " world"],
			expectedText: "Hello world",
		},
		{
			name: "empty terminal content preserves streamed text",
			deltas: ["Hello", " world"],
			terminalContent: [],
			expectedText: "Hello world",
		},
		{
			name: "identical terminal text is not appended to streamed text",
			deltas: ["Same text"],
			terminalContent: [{ type: "output_text", text: "Same text", annotations: [] }],
			expectedText: "Same text",
		},
		{
			name: "terminal text replaces streamed text",
			deltas: ["draft text"],
			terminalContent: [{ type: "output_text", text: "final text", annotations: [] }],
			expectedText: "final text",
		},
		{
			name: "explicit empty terminal text clears streamed text",
			deltas: ["draft text"],
			terminalContent: [{ type: "output_text", text: "", annotations: [] }],
			expectedText: "",
		},
		{
			name: "terminal refusal replaces streamed text",
			deltas: ["draft text"],
			terminalContent: [{ type: "refusal", refusal: "I cannot help with that." }],
			expectedText: "I cannot help with that.",
		},
	]) {
		test(`finalizes message text when ${testCase.name}`, async () => {
			const output = makeOutput();
			const emitted: EmittedEvent[] = [];
			const stream = { push: (e: unknown) => emitted.push(e as EmittedEvent), end: () => {} } as never;
			const doneItem =
				"terminalContent" in testCase
					? {
							type: "message",
							id: "msg_1",
							role: "assistant",
							status: "completed",
							content: testCase.terminalContent,
						}
					: { type: "message", id: "msg_1", role: "assistant", status: "completed" };

			await processResponsesStream(
				makeStream([
					{
						type: "response.output_item.added",
						output_index: 0,
						item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] },
					},
					...testCase.deltas.map(delta => ({
						type: "response.output_text.delta",
						output_index: 0,
						item_id: "msg_1",
						delta,
					})),
					{ type: "response.output_item.done", output_index: 0, item: doneItem },
					{ type: "response.completed", response: { id: "resp_done", status: "completed" } },
				]),
				output,
				stream,
				makeModel(),
			);

			expect(output.content).toEqual([expect.objectContaining({ type: "text", text: testCase.expectedText })]);
			const end = emitted.find(e => e.type === "text_end");
			expect(end?.content).toBe(testCase.expectedText);
		});
	}

	test("keeps separate message output items from concatenating", async () => {
		const output = makeOutput();
		const emitted: EmittedEvent[] = [];
		const stream = { push: (e: unknown) => emitted.push(e as EmittedEvent), end: () => {} } as never;

		await processResponsesStream(
			makeStream([
				{
					type: "response.output_item.added",
					output_index: 0,
					item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] },
				},
				{ type: "response.output_text.delta", output_index: 0, item_id: "msg_1", delta: "First" },
				{
					type: "response.output_item.done",
					output_index: 0,
					item: { type: "message", id: "msg_1", role: "assistant", status: "completed", content: [] },
				},
				{
					type: "response.output_item.added",
					output_index: 1,
					item: { type: "message", id: "msg_2", role: "assistant", status: "in_progress", content: [] },
				},
				{ type: "response.output_text.delta", output_index: 1, item_id: "msg_2", delta: "Second" },
				{
					type: "response.output_item.done",
					output_index: 1,
					item: { type: "message", id: "msg_2", role: "assistant", status: "completed", content: [] },
				},
				{ type: "response.completed", response: { id: "resp_done", status: "completed" } },
			]),
			output,
			stream,
			makeModel(),
		);

		const textBlocks = output.content.filter(block => block.type === "text");
		expect(textBlocks.map(block => block.text)).toEqual(["First", "Second"]);
		expect(emitted.filter(e => e.type === "text_end").map(e => [e.contentIndex, e.content])).toEqual([
			[0, "First"],
			[1, "Second"],
		]);
	});

	test("persists final custom tool input on the block and drops the accumulation buffer", async () => {
		const output = makeOutput();
		const emitted: EmittedEvent[] = [];
		const stream = { push: (e: unknown) => emitted.push(e as EmittedEvent), end: () => {} } as never;

		const patch = "*** Begin Patch";
		await processResponsesStream(
			makeStream([
				{
					type: "response.output_item.added",
					output_index: 0,
					item: { type: "custom_tool_call", id: "ctc_1", call_id: "call_c", name: "apply_patch", input: "" },
				},
				{
					type: "response.custom_tool_call_input.delta",
					output_index: 0,
					item_id: "ctc_1",
					delta: patch,
				},
				{
					type: "response.custom_tool_call_input.done",
					output_index: 0,
					item_id: "ctc_1",
					input: patch,
				},
				{
					type: "response.output_item.done",
					output_index: 0,
					item: { type: "custom_tool_call", id: "ctc_1", call_id: "call_c", name: "apply_patch", input: patch },
				},
			]),
			output,
			stream,
			makeModel(),
		);

		expect(output.content).toHaveLength(1);
		const block = output.content[0];
		if (block?.type !== "toolCall") throw new Error("expected a toolCall block");
		expect(block.customWireName).toBe("apply_patch");
		expect(block.arguments).toEqual({ input: patch });
		expect((block as unknown as Record<string, unknown>).partialJson).toBeUndefined();

		const end = emitted.find(e => e.type === "toolcall_end") as
			| { toolCall: { arguments: Record<string, unknown> } }
			| undefined;
		expect(end?.toolCall.arguments).toEqual({ input: patch });
	});

	test("maps end_turn=false on response.completed to a pause_turn stop", async () => {
		const stream = { push: () => {}, end: () => {} } as never;
		const completedWith = (extra: Record<string, unknown>): unknown[] => [
			{
				type: "response.output_item.added",
				output_index: 0,
				item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] },
			},
			{
				type: "response.output_item.done",
				output_index: 0,
				item: {
					type: "message",
					id: "msg_1",
					role: "assistant",
					status: "completed",
					phase: "commentary",
					content: [{ type: "output_text", text: "Scanning the repo first.", annotations: [] }],
				},
			},
			{
				type: "response.completed",
				response: { id: "resp_paused", status: "completed", ...extra },
			},
		];

		// Codex-lineage `end_turn: false` -> non-terminal stop the agent loop can
		// act on.
		const paused = makeOutput();
		await processResponsesStream(makeStream(completedWith({ end_turn: false })), paused, stream, makeModel());
		expect(paused.stopReason).toBe("stop");
		expect(paused.stopDetails).toEqual({ type: "pause_turn" });

		// Platform responses carry no end_turn field -> no pause marker.
		const finished = makeOutput();
		await processResponsesStream(makeStream(completedWith({})), finished, stream, makeModel());
		expect(finished.stopReason).toBe("stop");
		expect(finished.stopDetails).toBeUndefined();
	});

	test("pauses a completed hosted web search that has no visible assistant output", async () => {
		const output = makeOutput();
		const stream = { push: () => {}, end: () => {} } as never;

		await processResponsesStream(
			makeStream([
				{
					type: "response.output_item.done",
					output_index: 1,
					item: { type: "web_search_call", id: "ws_1", status: "completed", action: { type: "search" } },
				},
				{ type: "response.completed", response: { id: "resp_search", status: "completed" } },
			]),
			output,
			stream,
			makeModel(),
		);

		expect(output.stopReason).toBe("stop");
		expect(output.stopDetails).toEqual({ type: "pause_turn" });
	});

	test("pauses a status-less hosted web search done item that has no visible assistant output", async () => {
		const output = makeOutput();
		const stream = { push: () => {}, end: () => {} } as never;

		await processResponsesStream(
			makeStream([
				{
					type: "response.output_item.done",
					output_index: 1,
					item: { type: "web_search_call", id: "ws_1", action: { type: "search" } },
				},
				{ type: "response.completed", response: { id: "resp_search", status: "completed" } },
			]),
			output,
			stream,
			makeModel(),
		);

		expect(output.stopReason).toBe("stop");
		expect(output.stopDetails).toEqual({ type: "pause_turn" });
	});

	test("finishes a hosted web search when the response includes visible output", async () => {
		const output = makeOutput();
		const stream = { push: () => {}, end: () => {} } as never;

		await processResponsesStream(
			makeStream([
				{
					type: "response.output_item.done",
					output_index: 0,
					item: { type: "web_search_call", id: "ws_1", status: "completed", action: { type: "search" } },
				},
				{
					type: "response.output_item.done",
					output_index: 1,
					item: {
						type: "message",
						id: "msg_search",
						role: "assistant",
						status: "completed",
						content: [{ type: "output_text", text: "Search complete", annotations: [] }],
					},
				},
				{ type: "response.completed", response: { id: "resp_search", status: "completed" } },
			]),
			output,
			stream,
			makeModel(),
		);

		expect(output.content).toEqual([expect.objectContaining({ type: "text", text: "Search complete" })]);
		expect(output.stopDetails).toBeUndefined();
	});
});

describe("processResponsesStream: reasoning summary recovery", () => {
	test("streams summary deltas when the provider omits summary_part.added", async () => {
		const output = makeOutput();
		const emitted: EmittedEvent[] = [];
		const stream = { push: (e: unknown) => emitted.push(e as EmittedEvent), end: () => {} } as never;

		await processResponsesStream(
			makeStream([
				{
					type: "response.output_item.added",
					output_index: 0,
					item: { type: "reasoning", id: "rs_ollama", summary: [] },
				},
				{
					type: "response.reasoning_summary_text.delta",
					output_index: 0,
					item_id: "rs_ollama",
					summary_index: 0,
					delta: "Let's ",
				},
				{
					type: "response.reasoning_summary_text.done",
					output_index: 0,
					item_id: "rs_ollama",
					summary_index: 0,
					text: "Let's check",
				},
				{
					type: "response.output_item.done",
					output_index: 0,
					item: { type: "reasoning", id: "rs_ollama", summary: [] },
				},
				{ type: "response.completed", response: { id: "resp_ollama", status: "completed" } },
			]),
			output,
			stream,
			makeModel(),
		);

		expect(output.content).toEqual([expect.objectContaining({ type: "thinking", thinking: "Let's check" })]);
		expect(emitted.filter(event => event.type === "thinking_delta").map(event => event.delta)).toEqual([
			"Let's ",
			"check",
		]);
		expect(emitted.find(event => event.type === "thinking_end")?.content).toBe("Let's check");
	});
});

describe("processResponsesStream: lost output_item.added recovery", () => {
	test("synthesizes the tool-call block when output_item.added was lost", async () => {
		const output = makeOutput();
		const emitted: EmittedEvent[] = [];
		const stream = { push: (e: unknown) => emitted.push(e as EmittedEvent), end: () => {} } as never;

		await processResponsesStream(
			makeStream([
				{
					type: "response.output_item.done",
					output_index: 0,
					item: {
						type: "function_call",
						id: "fc_lost",
						call_id: "call_lost",
						name: "read",
						arguments: '{"path":"a.txt"}',
					},
				},
				{ type: "response.completed", response: { id: "resp_lost", status: "completed" } },
			]),
			output,
			stream,
			makeModel(),
		);

		expect(output.content).toHaveLength(1);
		const block = output.content[0];
		if (block?.type !== "toolCall") throw new Error("expected a toolCall block");
		expect(block.arguments).toEqual({ path: "a.txt" });
		// The toolUse override fires because the call now exists in content; the
		// agent loop executes tools from message.content.
		expect(output.stopReason).toBe("toolUse");
		const end = emitted.find(e => e.type === "toolcall_end") as { contentIndex: number } | undefined;
		expect(end?.contentIndex).toBe(0);
	});

	test("synthesizes the text block when message output_item.added was lost", async () => {
		const output = makeOutput();
		const emitted: EmittedEvent[] = [];
		const stream = { push: (e: unknown) => emitted.push(e as EmittedEvent), end: () => {} } as never;

		await processResponsesStream(
			makeStream([
				{
					type: "response.output_item.done",
					output_index: 0,
					item: {
						type: "message",
						id: "msg_lost",
						role: "assistant",
						status: "completed",
						content: [{ type: "output_text", text: "Recovered text", annotations: [] }],
					},
				},
				{ type: "response.completed", response: { id: "resp_lost_msg", status: "completed" } },
			]),
			output,
			stream,
			makeModel(),
		);

		expect(output.content).toEqual([expect.objectContaining({ type: "text", text: "Recovered text" })]);
		const end = emitted.find(e => e.type === "text_end") as { content: string } | undefined;
		expect(end?.content).toBe("Recovered text");
	});

	test("normalizes a completed native image generation call into visible assistant content", async () => {
		const output = makeOutput();
		const emitted: EmittedEvent[] = [];
		const stream = { push: (event: unknown) => emitted.push(event as EmittedEvent), end: () => {} } as never;
		const data = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

		await processResponsesStream(
			makeStream([
				{
					type: "response.output_item.done",
					output_index: 0,
					item: {
						type: "image_generation_call",
						id: "ig_1",
						status: "completed",
						result: data,
					},
				},
				{ type: "response.completed", response: { id: "resp_image", status: "completed" } },
			]),
			output,
			stream,
			makeModel(),
		);

		expect(output.content).toEqual([{ type: "image", data, mimeType: "image/png" }]);
		const end = emitted.find(event => event.type === "image_end");
		expect(end).toEqual({
			type: "image_end",
			contentIndex: 0,
			content: { type: "image", data, mimeType: "image/png" },
			partial: output,
		});
	});

	test("routes reasoning finalization by output_index when item ids are absent", async () => {
		const output = makeOutput();
		const stream = { push: () => {}, end: () => {} } as never;

		await processResponsesStream(
			makeStream([
				{ type: "response.output_item.added", output_index: 0, item: { type: "reasoning", summary: [] } },
				{ type: "response.output_item.added", output_index: 1, item: { type: "reasoning", summary: [] } },
				{
					type: "response.output_item.done",
					output_index: 0,
					item: {
						type: "reasoning",
						summary: [
							{ type: "summary_text", text: "Plan" },
							{ type: "summary_text", text: "Planning details" },
						],
					},
				},
				{
					type: "response.output_item.done",
					output_index: 1,
					item: { type: "reasoning", summary: [{ type: "summary_text", text: "second" }] },
				},
				{ type: "response.completed", response: { id: "resp_reasoning", status: "completed" } },
			]),
			output,
			stream,
			makeModel(),
		);

		expect(output.content).toHaveLength(2);
		const [first, second] = output.content;
		if (first?.type !== "thinking" || second?.type !== "thinking") throw new Error("expected thinking blocks");
		expect(first.thinking).toBe("Plan\n\nPlanning details");
		expect(second.thinking).toBe("second");
		expect(first.thinkingSignature).toBeDefined();
		expect(second.thinkingSignature).toBeDefined();
	});

	test("preserves streamed reasoning when the done item has no summary text", async () => {
		const output = makeOutput();
		const stream = { push: () => {}, end: () => {} } as never;

		await processResponsesStream(
			makeStream([
				{
					type: "response.output_item.added",
					output_index: 0,
					item: { type: "reasoning", id: "rs_1", summary: [] },
				},
				{
					type: "response.reasoning_summary_part.added",
					output_index: 0,
					item_id: "rs_1",
					summary_index: 0,
					part: { type: "summary_text", text: "" },
				},
				{
					type: "response.reasoning_summary_text.delta",
					output_index: 0,
					item_id: "rs_1",
					summary_index: 0,
					delta: "streamed thinking",
				},
				{
					type: "response.output_item.done",
					output_index: 0,
					item: { type: "reasoning", id: "rs_1", summary: [] },
				},
				{ type: "response.completed", response: { id: "resp_reasoning", status: "completed" } },
			]),
			output,
			stream,
			makeModel(),
		);

		const block = output.content[0];
		if (block?.type !== "thinking") throw new Error("expected a thinking block");
		expect(block.thinking).toBe("streamed thinking");
		expect(block.thinkingSignature).toBeDefined();
		expect(output.stopDetails).toBeUndefined();
	});

	test("treats content_filter incomplete responses as errors, not length", async () => {
		const output = makeOutput();
		const stream = { push: () => {}, end: () => {} } as never;

		await expect(
			processResponsesStream(
				makeStream([
					{
						type: "response.incomplete",
						response: {
							id: "resp_cf",
							status: "incomplete",
							incomplete_details: { reason: "content_filter" },
						},
					},
				]),
				output,
				stream,
				makeModel(),
			),
		).rejects.toThrow("incomplete: content_filter");
	});

	test("handles nested error object in error events", async () => {
		const output = makeOutput();
		const stream = { push: () => {}, end: () => {} } as never;

		await expect(
			processResponsesStream(
				makeStream([
					{
						type: "error",
						error: {
							code: "context_length_exceeded",
							message: "Your input exceeds the context window limit",
						},
					},
				]),
				output,
				stream,
				makeModel(),
			),
		).rejects.toThrow("Error Code context_length_exceeded: Your input exceeds the context window limit");
	});

	test("preserves premiumRequests across usage population", async () => {
		const output = makeOutput();
		output.usage.premiumRequests = 3;
		const stream = { push: () => {}, end: () => {} } as never;

		await processResponsesStream(
			makeStream([
				{
					type: "response.completed",
					response: {
						id: "resp_premium",
						status: "completed",
						usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 },
					},
				},
			]),
			output,
			stream,
			makeModel(),
		);

		expect(output.usage.premiumRequests).toBe(3);
		expect(output.usage.input).toBe(4);
		expect(output.usage.output).toBe(2);
	});

	test("stops pulling after response.completed even when the source never ends", async () => {
		const output = makeOutput();
		const stream = { push: () => {}, end: () => {} } as never;
		let onCompletedCalled = false;

		// Misbehaving providers deliver the terminal event but never close the
		// connection. The processor must break out instead of parking on
		// `iterator.next()` until the idle watchdog errors the turn.
		async function* neverEndingStream(): AsyncIterable<ResponseStreamEvent> {
			yield {
				type: "response.completed",
				response: { id: "resp_open", status: "completed", usage: { input_tokens: 1, output_tokens: 1 } },
			} as unknown as ResponseStreamEvent;
			await new Promise<never>(() => {}); // connection held open forever
		}

		await processResponsesStream(neverEndingStream(), output, stream, makeModel(), {
			onCompleted: () => {
				onCompletedCalled = true;
			},
		});

		expect(onCompletedCalled).toBe(true);
		expect(output.responseId).toBe("resp_open");
	});
});
