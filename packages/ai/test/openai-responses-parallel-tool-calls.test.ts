// Regression for https://github.com/can1357/oh-my-pi/issues/1880.
//
// llama.cpp (and any OpenAI-Responses-compatible host that interleaves
// multiple function_call items) emits `output_item.added` for every parallel
// call before the deltas arrive, then routes deltas via `item_id`/`output_index`
// instead of relying on a single in-flight item. `processResponsesStream`
// previously kept a singleton `currentBlock` reference and ignored those
// identifiers, so deltas for the first call were folded into the buffer of the
// most-recently-added block. The dispatcher then received empty `{}` arguments
// for every call except the last one.
//
// These tests pin the contract: each `function_call_arguments.{delta,done}` and
// `output_item.done` event must be routed by `output_index`/`item_id`, not by
// arrival order.
import { describe, expect, test } from "bun:test";
import type { ResponseStreamEvent } from "@oh-my-pi/pi-ai/providers/openai-responses-wire";
import { processResponsesStream } from "@oh-my-pi/pi-ai/providers/openai-shared";
import type { AssistantMessage, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

function makeModel(): Model<"openai-responses"> {
	return buildModel({
		api: "openai-responses",
		name: "Llama",
		id: "llama-3",
		provider: "llama.cpp",
		baseUrl: "http://127.0.0.1:8080/v1",
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
		provider: "llama.cpp",
		model: "llama-3",
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

describe("processResponsesStream: parallel function_call items", () => {
	test("routes deltas to the correct block when both items are added before any delta", async () => {
		const output = makeOutput();
		const emitted: EmittedEvent[] = [];
		const stream = { push: (e: unknown) => emitted.push(e as EmittedEvent), end: () => {} } as never;

		const argsA = JSON.stringify({ i: "Reading test", path: "test.txt" });
		const argsB = JSON.stringify({ i: "Reading test", path: "test.md" });

		await processResponsesStream(
			makeStream([
				{
					type: "response.output_item.added",
					output_index: 0,
					item: { type: "function_call", id: "fc_a", call_id: "call_a", name: "read", arguments: "" },
				},
				{
					type: "response.output_item.added",
					output_index: 1,
					item: { type: "function_call", id: "fc_b", call_id: "call_b", name: "read", arguments: "" },
				},
				{
					type: "response.function_call_arguments.delta",
					output_index: 0,
					item_id: "fc_a",
					delta: argsA,
				},
				{
					type: "response.function_call_arguments.delta",
					output_index: 1,
					item_id: "fc_b",
					delta: argsB,
				},
				{
					type: "response.function_call_arguments.done",
					output_index: 0,
					item_id: "fc_a",
					arguments: argsA,
				},
				{
					type: "response.function_call_arguments.done",
					output_index: 1,
					item_id: "fc_b",
					arguments: argsB,
				},
				{
					type: "response.output_item.done",
					output_index: 0,
					item: { type: "function_call", id: "fc_a", call_id: "call_a", name: "read", arguments: argsA },
				},
				{
					type: "response.output_item.done",
					output_index: 1,
					item: { type: "function_call", id: "fc_b", call_id: "call_b", name: "read", arguments: argsB },
				},
			]),
			output,
			stream,
			makeModel(),
		);

		expect(output.content).toHaveLength(2);
		const [blockA, blockB] = output.content;
		expect(blockA?.type).toBe("toolCall");
		expect(blockB?.type).toBe("toolCall");
		if (blockA?.type !== "toolCall" || blockB?.type !== "toolCall") throw new Error("expected toolCalls");
		expect(blockA.arguments).toEqual({ i: "Reading test", path: "test.txt" });
		expect(blockB.arguments).toEqual({ i: "Reading test", path: "test.md" });

		const ends = emitted.filter(e => e.type === "toolcall_end") as Array<{
			toolCall: { id: string; arguments: Record<string, unknown> };
			contentIndex: number;
		}>;
		expect(ends).toHaveLength(2);
		const byCallId = new Map(ends.map(e => [e.toolCall.id.split("|")[0], e]));
		expect(byCallId.get("call_a")?.toolCall.arguments).toEqual({ i: "Reading test", path: "test.txt" });
		expect(byCallId.get("call_b")?.toolCall.arguments).toEqual({ i: "Reading test", path: "test.md" });
		expect(byCallId.get("call_a")?.contentIndex).toBe(0);
		expect(byCallId.get("call_b")?.contentIndex).toBe(1);

		// Delta events must also carry the per-block contentIndex — otherwise the
		// streaming UI updates the wrong block while args are still arriving.
		const deltas = emitted.filter(e => e.type === "toolcall_delta") as Array<{
			delta: string;
			contentIndex: number;
		}>;
		expect(deltas).toHaveLength(2);
		const deltaForA = deltas.find(d => d.delta === argsA);
		const deltaForB = deltas.find(d => d.delta === argsB);
		expect(deltaForA?.contentIndex).toBe(0);
		expect(deltaForB?.contentIndex).toBe(1);
	});

	test("drops stale keyed deltas after their item closes instead of routing to a sibling", async () => {
		const output = makeOutput();
		const emitted: EmittedEvent[] = [];
		const stream = { push: (e: unknown) => emitted.push(e as EmittedEvent), end: () => {} } as never;

		const argsA = JSON.stringify({ path: "a" });
		const argsB = JSON.stringify({ path: "b" });

		await processResponsesStream(
			makeStream([
				{
					type: "response.output_item.added",
					output_index: 0,
					item: { type: "function_call", id: "fc_a", call_id: "call_a", name: "read", arguments: "" },
				},
				{
					type: "response.output_item.added",
					output_index: 1,
					item: { type: "function_call", id: "fc_b", call_id: "call_b", name: "read", arguments: "" },
				},
				{
					type: "response.output_item.done",
					output_index: 0,
					item: { type: "function_call", id: "fc_a", call_id: "call_a", name: "read", arguments: argsA },
				},
				{
					type: "response.function_call_arguments.delta",
					output_index: 0,
					item_id: "fc_a",
					delta: JSON.stringify({ late: true }),
				},
				{
					type: "response.output_item.done",
					output_index: 1,
					item: { type: "function_call", id: "fc_b", call_id: "call_b", name: "read", arguments: argsB },
				},
				{
					type: "response.completed",
					response: { id: "resp_parallel_stale_delta", status: "completed" },
				},
			]),
			output,
			stream,
			makeModel(),
		);

		const [, blockB] = output.content;
		if (blockB?.type !== "toolCall") throw new Error("expected second toolCall");
		expect(blockB.arguments).toEqual({ path: "b" });

		const deltas = emitted.filter(e => e.type === "toolcall_delta");
		expect(deltas).toEqual([]);
	});

	test("routes done-only finalization to the correct block when arguments stream as a single chunk on each item", async () => {
		// Some local Responses-compat hosts skip the per-delta protocol entirely
		// and stash the full arguments string on `output_item.added`/`done`.
		const output = makeOutput();
		const emitted: EmittedEvent[] = [];
		const stream = { push: (e: unknown) => emitted.push(e as EmittedEvent), end: () => {} } as never;

		const argsA = JSON.stringify({ path: "test.txt" });
		const argsB = JSON.stringify({ path: "test.md" });

		await processResponsesStream(
			makeStream([
				{
					type: "response.output_item.added",
					output_index: 0,
					item: { type: "function_call", id: "fc_a", call_id: "call_a", name: "read", arguments: argsA },
				},
				{
					type: "response.output_item.added",
					output_index: 1,
					item: { type: "function_call", id: "fc_b", call_id: "call_b", name: "read", arguments: argsB },
				},
				{
					type: "response.output_item.done",
					output_index: 0,
					item: { type: "function_call", id: "fc_a", call_id: "call_a", name: "read", arguments: argsA },
				},
				{
					type: "response.output_item.done",
					output_index: 1,
					item: { type: "function_call", id: "fc_b", call_id: "call_b", name: "read", arguments: argsB },
				},
			]),
			output,
			stream,
			makeModel(),
		);

		const [blockA, blockB] = output.content;
		if (blockA?.type !== "toolCall" || blockB?.type !== "toolCall") throw new Error("expected toolCalls");
		expect(blockA.arguments).toEqual({ path: "test.txt" });
		expect(blockB.arguments).toEqual({ path: "test.md" });

		const ends = emitted.filter(e => e.type === "toolcall_end") as Array<{
			toolCall: { id: string; arguments: Record<string, unknown> };
		}>;
		expect(ends).toHaveLength(2);
		const byCallId = new Map(ends.map(e => [e.toolCall.id.split("|")[0], e]));
		expect(byCallId.get("call_a")?.toolCall.arguments).toEqual({ path: "test.txt" });
		expect(byCallId.get("call_b")?.toolCall.arguments).toEqual({ path: "test.md" });
	});

	test("routes identifierless final argument events in item order", async () => {
		const output = makeOutput();
		const emitted: EmittedEvent[] = [];
		const stream = { push: (e: unknown) => emitted.push(e as EmittedEvent), end: () => {} } as never;

		const argsA = JSON.stringify({ command: "printf a" });
		const argsB = JSON.stringify({ command: "printf b" });

		await processResponsesStream(
			makeStream([
				{
					type: "response.output_item.added",
					output_index: 0,
					item: { type: "function_call", id: "fc_a", call_id: "call_a", name: "bash", arguments: "" },
				},
				{
					type: "response.output_item.added",
					output_index: 1,
					item: { type: "function_call", id: "fc_b", call_id: "call_b", name: "bash", arguments: "" },
				},
				{
					type: "response.function_call_arguments.done",
					arguments: argsA,
				},
				{
					type: "response.function_call_arguments.done",
					arguments: argsB,
				},
				{
					type: "response.output_item.done",
					output_index: 0,
					item: { type: "function_call", id: "fc_a", call_id: "call_a", name: "bash", arguments: "" },
				},
				{
					type: "response.output_item.done",
					output_index: 1,
					item: { type: "function_call", id: "fc_b", call_id: "call_b", name: "bash", arguments: "" },
				},
			]),
			output,
			stream,
			makeModel(),
		);

		const [blockA, blockB] = output.content;
		if (blockA?.type !== "toolCall" || blockB?.type !== "toolCall") throw new Error("expected toolCalls");
		expect(blockA.arguments).toEqual({ command: "printf a" });
		expect(blockB.arguments).toEqual({ command: "printf b" });

		const ends = emitted.filter(e => e.type === "toolcall_end") as Array<{
			toolCall: { id: string; arguments: Record<string, unknown> };
		}>;
		expect(ends).toHaveLength(2);
		const byCallId = new Map(ends.map(e => [e.toolCall.id.split("|")[0], e]));
		expect(byCallId.get("call_a")?.toolCall.arguments).toEqual({ command: "printf a" });
		expect(byCallId.get("call_b")?.toolCall.arguments).toEqual({ command: "printf b" });
	});

	test("routes identifierless argument deltas to sibling calls when a new JSON object starts", async () => {
		const output = makeOutput();
		const emitted: EmittedEvent[] = [];
		const stream = { push: (e: unknown) => emitted.push(e as EmittedEvent), end: () => {} } as never;

		const argsA = JSON.stringify({ command: "echo hello" });
		const argsB = JSON.stringify({ command: "echo goodbye" });

		await processResponsesStream(
			makeStream([
				{
					type: "response.output_item.added",
					output_index: 0,
					item: { type: "function_call", id: "fc_a", call_id: "call_a", name: "bash", arguments: "" },
				},
				{
					type: "response.output_item.added",
					output_index: 1,
					item: { type: "function_call", id: "fc_b", call_id: "call_b", name: "bash", arguments: "" },
				},
				{
					type: "response.function_call_arguments.delta",
					delta: '{"command":"echo hello\n',
				},
				{
					type: "response.function_call_arguments.delta",
					delta: argsB,
				},
				{
					type: "response.output_item.done",
					output_index: 0,
					item: { type: "function_call", id: "fc_a", call_id: "call_a", name: "bash", arguments: argsA },
				},
				{
					type: "response.output_item.done",
					output_index: 1,
					item: { type: "function_call", id: "fc_b", call_id: "call_b", name: "bash", arguments: argsB },
				},
			]),
			output,
			stream,
			makeModel(),
		);

		const [blockA, blockB] = output.content;
		if (blockA?.type !== "toolCall" || blockB?.type !== "toolCall") throw new Error("expected toolCalls");
		expect(blockA.arguments).toEqual({ command: "echo hello" });
		expect(blockB.arguments).toEqual({ command: "echo goodbye" });
		expect(String(blockA.arguments.command)).not.toContain('{"command');

		const deltas = emitted.filter(e => e.type === "toolcall_delta") as Array<{
			delta: string;
			contentIndex: number;
		}>;
		expect(deltas.map(delta => delta.contentIndex)).toEqual([0, 1]);
	});

	test("keeps split identifierless sibling argument chunks together", async () => {
		const output = makeOutput();
		const emitted: EmittedEvent[] = [];
		const stream = { push: (e: unknown) => emitted.push(e as EmittedEvent), end: () => {} } as never;
		const argsA = JSON.stringify({ command: "echo hello" });

		await processResponsesStream(
			makeStream([
				{
					type: "response.output_item.added",
					output_index: 0,
					item: { type: "function_call", id: "fc_a", call_id: "call_a", name: "bash", arguments: "" },
				},
				{
					type: "response.output_item.added",
					output_index: 1,
					item: { type: "function_call", id: "fc_b", call_id: "call_b", name: "bash", arguments: "" },
				},
				{ type: "response.function_call_arguments.delta", delta: argsA },
				{ type: "response.function_call_arguments.delta", delta: '{"command":"echo ' },
				{ type: "response.function_call_arguments.delta", delta: 'goodbye"}' },
				{
					type: "response.output_item.done",
					output_index: 0,
					item: { type: "function_call", id: "fc_a", call_id: "call_a", name: "bash", arguments: argsA },
				},
				{
					type: "response.output_item.done",
					output_index: 1,
					item: { type: "function_call", id: "fc_b", call_id: "call_b", name: "bash", arguments: "" },
				},
			]),
			output,
			stream,
			makeModel(),
		);

		const [blockA, blockB] = output.content;
		if (blockA?.type !== "toolCall" || blockB?.type !== "toolCall") throw new Error("expected toolCalls");
		expect(blockA.arguments).toEqual({ command: "echo hello" });
		expect(blockB.arguments).toEqual({ command: "echo goodbye" });

		const deltas = emitted.filter(e => e.type === "toolcall_delta") as Array<{ contentIndex: number }>;
		expect(deltas.map(delta => delta.contentIndex)).toEqual([0, 1, 1]);
	});

	test("keeps brace-prefixed chunks on a single identifierless function call", async () => {
		const output = makeOutput();
		const emitted: EmittedEvent[] = [];
		const stream = { push: (e: unknown) => emitted.push(e as EmittedEvent), end: () => {} } as never;

		await processResponsesStream(
			makeStream([
				{
					type: "response.output_item.added",
					item: { type: "function_call", id: "fc_a", call_id: "call_a", name: "bash", arguments: "" },
				},
				{
					type: "response.function_call_arguments.delta",
					delta: '{"command":"echo ',
				},
				{
					type: "response.function_call_arguments.delta",
					delta: '{1..3}"}',
				},
				{
					type: "response.output_item.done",
					item: { type: "function_call", id: "fc_a", call_id: "call_a", name: "bash", arguments: "" },
				},
			]),
			output,
			stream,
			makeModel(),
		);

		const [block] = output.content;
		if (block?.type !== "toolCall") throw new Error("expected toolCall");
		expect(block.arguments).toEqual({ command: "echo {1..3}" });

		const deltas = emitted.filter(e => e.type === "toolcall_delta") as Array<{ contentIndex: number }>;
		expect(deltas.map(delta => delta.contentIndex)).toEqual([0, 0]);
	});

	test("keeps brace-prefixed identifierless chunks on the current sibling when concatenation stays valid", async () => {
		const output = makeOutput();
		const emitted: EmittedEvent[] = [];
		const stream = { push: (e: unknown) => emitted.push(e as EmittedEvent), end: () => {} } as never;

		await processResponsesStream(
			makeStream([
				{
					type: "response.output_item.added",
					item: { type: "function_call", id: "fc_a", call_id: "call_a", name: "bash", arguments: "" },
				},
				{
					type: "response.output_item.added",
					item: { type: "function_call", id: "fc_b", call_id: "call_b", name: "bash", arguments: "" },
				},
				{ type: "response.function_call_arguments.delta", delta: '{"command":"echo ' },
				{ type: "response.function_call_arguments.delta", delta: '{1..3}"}' },
				{ type: "response.function_call_arguments.delta", delta: '{"command":"echo goodbye"}' },
				{
					type: "response.output_item.done",
					item: { type: "function_call", id: "fc_a", call_id: "call_a", name: "bash", arguments: "" },
				},
				{
					type: "response.output_item.done",
					item: { type: "function_call", id: "fc_b", call_id: "call_b", name: "bash", arguments: "" },
				},
			]),
			output,
			stream,
			makeModel(),
		);

		const [blockA, blockB] = output.content;
		if (blockA?.type !== "toolCall" || blockB?.type !== "toolCall") throw new Error("expected toolCalls");
		expect(blockA.arguments).toEqual({ command: "echo {1..3}" });
		expect(blockB.arguments).toEqual({ command: "echo goodbye" });

		const deltas = emitted.filter(e => e.type === "toolcall_delta") as Array<{
			delta: string;
			contentIndex: number;
		}>;
		expect(deltas.map(delta => ({ delta: delta.delta, contentIndex: delta.contentIndex }))).toEqual([
			{ delta: '{"command":"echo ', contentIndex: 0 },
			{ delta: '{1..3}"}', contentIndex: 0 },
			{ delta: '{"command":"echo goodbye"}', contentIndex: 1 },
		]);
	});

	test("routes deltas by item.call_id when llama.cpp omits item.id and output_index (issue #2015)", async () => {
		// llama.cpp's `to_json_oaicompat_resp` (tools/server/server-task.cpp) emits a
		// function_call's `output_item.added` with only `item.call_id` — no `item.id`,
		// no `output_index`. The matching `function_call_arguments.delta` then carries
		// `item_id: "fc_<call_id>"` and again no `output_index`. Without secondary
		// indexing on `call_id`, `processResponsesStream`'s lookup map stays empty and
		// every delta lands on the trailing block, leaving earlier calls with empty
		// arguments (= `{}`) — the read tool then rejects them with
		// `path: Invalid input: expected string, received undefined`.
		const output = makeOutput();
		const emitted: EmittedEvent[] = [];
		const stream = { push: (e: unknown) => emitted.push(e as EmittedEvent), end: () => {} } as never;

		const argsA = JSON.stringify({ path: "a.txt" });
		const argsB = JSON.stringify({ path: "b.txt" });
		const argsC = JSON.stringify({ path: "c.txt" });

		await processResponsesStream(
			makeStream([
				{
					type: "response.output_item.added",
					item: { type: "function_call", call_id: "fc_a", name: "read", arguments: "" },
				},
				{
					type: "response.output_item.added",
					item: { type: "function_call", call_id: "fc_b", name: "read", arguments: "" },
				},
				{
					type: "response.output_item.added",
					item: { type: "function_call", call_id: "fc_c", name: "read", arguments: "" },
				},
				{ type: "response.function_call_arguments.delta", item_id: "fc_a", delta: argsA },
				{ type: "response.function_call_arguments.delta", item_id: "fc_b", delta: argsB },
				{ type: "response.function_call_arguments.delta", item_id: "fc_c", delta: argsC },
				{
					type: "response.output_item.done",
					item: { type: "function_call", call_id: "fc_a", name: "read", arguments: argsA },
				},
				{
					type: "response.output_item.done",
					item: { type: "function_call", call_id: "fc_b", name: "read", arguments: argsB },
				},
				{
					type: "response.output_item.done",
					item: { type: "function_call", call_id: "fc_c", name: "read", arguments: argsC },
				},
			]),
			output,
			stream,
			makeModel(),
		);

		expect(output.content).toHaveLength(3);
		const [a, b, c] = output.content;
		if (a?.type !== "toolCall" || b?.type !== "toolCall" || c?.type !== "toolCall") {
			throw new Error("expected toolCalls");
		}
		expect(a.arguments).toEqual({ path: "a.txt" });
		expect(b.arguments).toEqual({ path: "b.txt" });
		expect(c.arguments).toEqual({ path: "c.txt" });

		const ends = emitted.filter(e => e.type === "toolcall_end") as Array<{
			toolCall: { id: string; arguments: Record<string, unknown> };
			contentIndex: number;
		}>;
		expect(ends).toHaveLength(3);
		const byCallId = new Map(ends.map(e => [e.toolCall.id.split("|")[0], e]));
		expect(byCallId.get("fc_a")?.toolCall.arguments).toEqual({ path: "a.txt" });
		expect(byCallId.get("fc_b")?.toolCall.arguments).toEqual({ path: "b.txt" });
		expect(byCallId.get("fc_c")?.toolCall.arguments).toEqual({ path: "c.txt" });
		expect(byCallId.get("fc_a")?.contentIndex).toBe(0);
		expect(byCallId.get("fc_b")?.contentIndex).toBe(1);
		expect(byCallId.get("fc_c")?.contentIndex).toBe(2);
	});
	test("routes Ollama Responses deltas whose item_id prefixes the call_id", async () => {
		// Ollama's OpenAI-compatible Responses stream can add parallel calls with
		// only `call_id`, then send argument deltas with `item_id = fc_<call_id>`
		// even when `call_id` already starts with `fc_`.
		// If the parser only indexes the bare call_id, every delta falls back to the
		// most recently added call and earlier ast_grep calls execute with `{}`.
		const output = makeOutput();
		const emitted: EmittedEvent[] = [];
		const stream = { push: (e: unknown) => emitted.push(e as EmittedEvent), end: () => {} } as never;

		const argsA = JSON.stringify({ pat: "console.log($$$)", paths: ["src/**/*.ts"] });
		const argsB = JSON.stringify({ pat: "logger.$_($$$ARGS)", paths: ["src/**/*.ts"] });
		const argsC = JSON.stringify({ pat: "processItems", paths: ["src/worker.ts"] });

		await processResponsesStream(
			makeStream([
				{
					type: "response.output_item.added",
					item: { type: "function_call", call_id: "x", name: "ast_grep", arguments: "" },
				},
				{
					type: "response.output_item.added",
					item: { type: "function_call", call_id: "fc_x", name: "ast_grep", arguments: "" },
				},
				{
					type: "response.output_item.added",
					item: { type: "function_call", call_id: "call_c", name: "ast_grep", arguments: "" },
				},
				{ type: "response.function_call_arguments.delta", item_id: "fc_x", delta: argsA },
				{ type: "response.function_call_arguments.delta", item_id: "fc_fc_x", delta: argsB },
				{ type: "response.function_call_arguments.delta", item_id: "fc_call_c", delta: argsC },
				{
					type: "response.output_item.done",
					item: { type: "function_call", call_id: "x", name: "ast_grep", arguments: "" },
				},
				{
					type: "response.output_item.done",
					item: { type: "function_call", call_id: "fc_x", name: "ast_grep", arguments: "" },
				},
				{
					type: "response.output_item.done",
					item: { type: "function_call", call_id: "call_c", name: "ast_grep", arguments: "" },
				},
			]),
			output,
			stream,
			makeModel(),
		);

		expect(output.content).toHaveLength(3);
		const [a, b, c] = output.content;
		if (a?.type !== "toolCall" || b?.type !== "toolCall" || c?.type !== "toolCall") {
			throw new Error("expected toolCalls");
		}
		expect(a.arguments).toEqual({ pat: "console.log($$$)", paths: ["src/**/*.ts"] });
		expect(b.arguments).toEqual({ pat: "logger.$_($$$ARGS)", paths: ["src/**/*.ts"] });
		expect(c.arguments).toEqual({ pat: "processItems", paths: ["src/worker.ts"] });

		const ends = emitted.filter(e => e.type === "toolcall_end") as Array<{
			toolCall: { id: string; arguments: Record<string, unknown> };
			contentIndex: number;
		}>;
		expect(ends).toHaveLength(3);
		const byCallId = new Map(ends.map(e => [e.toolCall.id.split("|")[0], e]));
		expect(byCallId.get("x")?.toolCall.arguments).toEqual({
			pat: "console.log($$$)",
			paths: ["src/**/*.ts"],
		});
		expect(byCallId.get("fc_x")?.toolCall.arguments).toEqual({
			pat: "logger.$_($$$ARGS)",
			paths: ["src/**/*.ts"],
		});
		expect(byCallId.get("call_c")?.toolCall.arguments).toEqual({
			pat: "processItems",
			paths: ["src/worker.ts"],
		});
		expect(byCallId.get("x")?.contentIndex).toBe(0);
		expect(byCallId.get("fc_x")?.contentIndex).toBe(1);
		expect(byCallId.get("call_c")?.contentIndex).toBe(2);
	});
	test("routes prefixed deltas whose output_index was never registered (issue #2715)", async () => {
		// The OpenAI Responses spec marks `output_index` as required on
		// `function_call_arguments.{delta,done}`, so a spec-shaped delta always
		// carries it. llama.cpp/Ollama still omit `output_index`/`item.id` on
		// `output_item.added` (issue #2015), registering each parallel call only by
		// `call_id`. The deltas then point at an `output_index` that was never
		// registered while routing by `item_id = fc_<call_id>`. Trusting the stale
		// output_index and skipping the prefixed-alias lookup folds every delta into
		// the most-recently-added call, leaving earlier ast_grep calls with `{}`.
		const output = makeOutput();
		const emitted: EmittedEvent[] = [];
		const stream = { push: (e: unknown) => emitted.push(e as EmittedEvent), end: () => {} } as never;

		const argsA = JSON.stringify({ pat: "console.log($$$)", paths: ["src/**/*.ts"] });
		const argsB = JSON.stringify({ pat: "logger.$_($$$ARGS)", paths: ["src/**/*.ts"] });
		const argsC = JSON.stringify({ pat: "processItems", paths: ["src/worker.ts"] });

		await processResponsesStream(
			makeStream([
				{
					type: "response.output_item.added",
					item: { type: "function_call", call_id: "a", name: "ast_grep", arguments: "" },
				},
				{
					type: "response.output_item.added",
					item: { type: "function_call", call_id: "b", name: "ast_grep", arguments: "" },
				},
				{
					type: "response.output_item.added",
					item: { type: "function_call", call_id: "c", name: "ast_grep", arguments: "" },
				},
				{ type: "response.function_call_arguments.delta", output_index: 0, item_id: "fc_a", delta: argsA },
				{ type: "response.function_call_arguments.delta", output_index: 1, item_id: "fc_b", delta: argsB },
				{ type: "response.function_call_arguments.delta", output_index: 2, item_id: "fc_c", delta: argsC },
				{
					type: "response.output_item.done",
					item: { type: "function_call", call_id: "a", name: "ast_grep", arguments: "" },
				},
				{
					type: "response.output_item.done",
					item: { type: "function_call", call_id: "b", name: "ast_grep", arguments: "" },
				},
				{
					type: "response.output_item.done",
					item: { type: "function_call", call_id: "c", name: "ast_grep", arguments: "" },
				},
			]),
			output,
			stream,
			makeModel(),
		);

		expect(output.content).toHaveLength(3);
		const [a, b, c] = output.content;
		if (a?.type !== "toolCall" || b?.type !== "toolCall" || c?.type !== "toolCall") {
			throw new Error("expected toolCalls");
		}
		expect(a.arguments).toEqual({ pat: "console.log($$$)", paths: ["src/**/*.ts"] });
		expect(b.arguments).toEqual({ pat: "logger.$_($$$ARGS)", paths: ["src/**/*.ts"] });
		expect(c.arguments).toEqual({ pat: "processItems", paths: ["src/worker.ts"] });

		const ends = emitted.filter(e => e.type === "toolcall_end") as Array<{
			toolCall: { id: string; arguments: Record<string, unknown> };
			contentIndex: number;
		}>;
		expect(ends).toHaveLength(3);
		const byCallId = new Map(ends.map(e => [e.toolCall.id.split("|")[0], e]));
		expect(byCallId.get("a")?.toolCall.arguments).toEqual({
			pat: "console.log($$$)",
			paths: ["src/**/*.ts"],
		});
		expect(byCallId.get("b")?.toolCall.arguments).toEqual({
			pat: "logger.$_($$$ARGS)",
			paths: ["src/**/*.ts"],
		});
		expect(byCallId.get("c")?.toolCall.arguments).toEqual({
			pat: "processItems",
			paths: ["src/worker.ts"],
		});
		expect(byCallId.get("a")?.contentIndex).toBe(0);
		expect(byCallId.get("b")?.contentIndex).toBe(1);
		expect(byCallId.get("c")?.contentIndex).toBe(2);
	});
});
