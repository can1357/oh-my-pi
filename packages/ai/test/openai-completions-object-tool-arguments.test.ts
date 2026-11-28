import { describe, expect, it } from "bun:test";
import { streamOpenAICompletions } from "@oh-my-pi/pi-ai/providers/openai-completions";
import type { Context, FetchImpl, Model } from "@oh-my-pi/pi-ai/types";
import { minimaxTokenPlanOpenAIModel } from "./helpers";

// MiniMax-compatible hosts stream `function.arguments` as JSON objects rather
// than the standard JSON-string deltas, and may fragment one call's object
// across several deltas with either cumulative or per-chunk-delta semantics.

function createSseResponse(events: unknown[]): Response {
	const payload = `${events
		.map(event => `data: ${typeof event === "string" ? event : JSON.stringify(event)}`)
		.join("\n\n")}\n\n`;
	return new Response(payload, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

function createMockFetch(events: unknown[]): FetchImpl {
	async function mockFetch(_input: string | URL | Request, _init?: RequestInit): Promise<Response> {
		return createSseResponse(events);
	}
	return Object.assign(mockFetch, { preconnect: fetch.preconnect });
}

function baseContext(): Context {
	return {
		messages: [{ role: "user", content: "edit a file", timestamp: Date.now() }],
		tools: [
			{
				name: "edit",
				description: "Apply a hashline patch",
				parameters: {
					type: "object",
					properties: { input: { type: "string" } },
					required: ["input"],
				},
			},
			{
				name: "bash",
				description: "Run a shell command",
				parameters: {
					type: "object",
					properties: { command: { type: "string" } },
					required: ["command"],
				},
			},
		],
	};
}

function toolCallChunk(model: Model<"openai-completions">, fn: Record<string, unknown>): unknown {
	return {
		id: "chatcmpl-minimax-cn",
		object: "chat.completion.chunk",
		created: 0,
		model: model.id,
		choices: [
			{
				index: 0,
				delta: {
					role: "assistant",
					tool_calls: [{ index: 0, id: "call-minimax-1", type: "function", function: fn }],
				},
			},
		],
	};
}

function stopChunk(model: Model<"openai-completions">): unknown {
	return {
		id: "chatcmpl-minimax-cn",
		object: "chat.completion.chunk",
		created: 0,
		model: model.id,
		choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
	};
}

describe("MiniMax object-shaped tool arguments", () => {
	it("preserves object-shaped streamed tool arguments without a serialization round-trip", async () => {
		const model = minimaxTokenPlanOpenAIModel("minimax-code-cn", "MiniMax-M3");
		const fetchMock = createMockFetch([
			toolCallChunk(model, { name: "bash", arguments: { command: "printf '%s\\n' ok" } }),
			stopChunk(model),
			"[DONE]",
		]);

		const result = await streamOpenAICompletions(model, baseContext(), {
			apiKey: "test-key",
			fetch: fetchMock,
		}).result();

		expect(result.stopReason).toBe("toolUse");
		expect(JSON.parse(JSON.stringify(result.content))).toEqual([
			{ type: "toolCall", id: "call-minimax-1", name: "bash", arguments: { command: "printf '%s\\n' ok" } },
		]);
	});

	it("still assembles tool arguments streamed as the standard JSON-string deltas", async () => {
		const model = minimaxTokenPlanOpenAIModel("minimax-code-cn", "MiniMax-M3");
		const fetchMock = createMockFetch([
			toolCallChunk(model, { name: "bash", arguments: '{"command":' }),
			toolCallChunk(model, { arguments: ' "printf ok"}' }),
			stopChunk(model),
			"[DONE]",
		]);

		const result = await streamOpenAICompletions(model, baseContext(), {
			apiKey: "test-key",
			fetch: fetchMock,
		}).result();

		expect(result.stopReason).toBe("toolUse");
		expect(JSON.parse(JSON.stringify(result.content))).toEqual([
			{ type: "toolCall", id: "call-minimax-1", name: "bash", arguments: { command: "printf ok" } },
		]);
	});
});

// Merging, not last-chunk-wins: keeping only the final fragment turned an `edit`
// patch into a tail slice of itself, silently producing partial deletes.
describe("MiniMax multi-chunk object tool arguments", () => {
	it("does not double cumulative chunks where each delta restates everything seen so far", async () => {
		const model = minimaxTokenPlanOpenAIModel("minimax-code-cn", "MiniMax-M3");
		// Second chunk strictly extends the first — common shape for hosts
		// that re-emit the full args on every delta. `startsWith` collapses
		// the merge to the latest cumulative snapshot instead of duplicating
		// the shared prefix.
		const fetchMock = createMockFetch([
			toolCallChunk(model, {
				name: "edit",
				arguments: { input: "[foo.ts#A1B2]\nSWAP 91.=91:" },
			}),
			toolCallChunk(model, {
				arguments: { input: "[foo.ts#A1B2]\nSWAP 91.=91:\n+new" },
			}),
			stopChunk(model),
			"[DONE]",
		]);

		const result = await streamOpenAICompletions(model, baseContext(), {
			apiKey: "test-key",
			fetch: fetchMock,
		}).result();

		expect(result.content).toEqual([
			{
				type: "toolCall",
				id: "call-minimax-1",
				name: "edit",
				arguments: { input: "[foo.ts#A1B2]\nSWAP 91.=91:\n+new" },
			},
		]);
	});

	it("preserves keys that only appear in earlier chunks instead of dropping them with later chunks", async () => {
		const model = minimaxTokenPlanOpenAIModel("minimax-code-cn", "MiniMax-M3");
		const fetchMock = createMockFetch([
			toolCallChunk(model, { name: "edit", arguments: { input: "[foo.ts#A1B2]\nDEL 5" } }),
			toolCallChunk(model, { arguments: { dryRun: true } }),
			stopChunk(model),
			"[DONE]",
		]);

		const result = await streamOpenAICompletions(model, baseContext(), {
			apiKey: "test-key",
			fetch: fetchMock,
		}).result();

		expect(result.content).toEqual([
			{
				type: "toolCall",
				id: "call-minimax-1",
				name: "edit",
				arguments: { input: "[foo.ts#A1B2]\nDEL 5", dryRun: true },
			},
		]);
	});

	it("deep-merges object and array fragments for large task arguments", async () => {
		const model = minimaxTokenPlanOpenAIModel("minimax-code-cn", "MiniMax-M3");
		const fetchMock = createMockFetch([
			toolCallChunk(model, {
				name: "task",
				arguments: {
					tasks: [{ id: "A", assignment: "first" }],
					options: { env: { first: true } },
				},
			}),
			toolCallChunk(model, {
				arguments: {
					tasks: [
						{ id: "A", assignment: "first" },
						{ id: "B", assignment: "second" },
					],
					options: { env: { second: true }, constructor: { polluted: true } },
				},
			}),
			toolCallChunk(model, {
				arguments: {
					tasks: [{ id: "C", assignment: "third" }],
					options: { flags: ["fast"], prototype: { polluted: true } },
					["__proto__"]: { polluted: true },
				},
			}),
			stopChunk(model),
			"[DONE]",
		]);

		const result = await streamOpenAICompletions(model, baseContext(), {
			apiKey: "test-key",
			fetch: fetchMock,
		}).result();

		expect(result.content).toEqual([
			{
				type: "toolCall",
				id: "call-minimax-1",
				name: "task",
				arguments: {
					tasks: [
						{ id: "A", assignment: "first" },
						{ id: "B", assignment: "second" },
						{ id: "C", assignment: "third" },
					],
					options: { env: { first: true, second: true }, flags: ["fast"] },
				},
			},
		]);
		const objectPrototype = Object.prototype as { polluted?: unknown };
		expect(objectPrototype.polluted).toBeUndefined();
	});

	it("emits a concat-safe `toolcall_delta` sequence — accumulated deltas parse to the merged args", async () => {
		// Emitting `JSON.stringify(rawArgs)` per chunk would feed downstream concat
		// consumers (proxy.ts, openai-chat-server, etc.) an invalid sequence like
		// `{"input":"a"}{"input":"b"}` even when the merged source-side args are
		// correct. Object-chunk emission is deferred to `finishToolCallBlock`, which
		// flushes one delta carrying the full merged JSON. Verify that contract by
		// reconstructing the args the way the proxy does (concat + parse) and
		// comparing against the source-side merged result.
		const model = minimaxTokenPlanOpenAIModel("minimax-code-cn", "MiniMax-M3");
		const fetchMock = createMockFetch([
			toolCallChunk(model, {
				name: "edit",
				arguments: { input: "[foo.ts#A1B2]\nSWAP 91.=91:\n+    " },
			}),
			toolCallChunk(model, {
				arguments: { input: 'const out = await executeTool("nuke", { path: "x" }, ctx);' },
			}),
			stopChunk(model),
			"[DONE]",
		]);

		const s = streamOpenAICompletions(model, baseContext(), { apiKey: "test-key", fetch: fetchMock });
		let accumulated = "";
		let toolCallEndArgs: unknown;
		for await (const event of s) {
			if (event.type === "toolcall_delta") accumulated += event.delta;
			else if (event.type === "toolcall_end") toolCallEndArgs = event.toolCall.arguments;
		}

		const expected = {
			input: '[foo.ts#A1B2]\nSWAP 91.=91:\n+    const out = await executeTool("nuke", { path: "x" }, ctx);',
		};
		// Source-side merged result (what `block.arguments` is set to in `finishToolCallBlock`).
		expect(toolCallEndArgs).toEqual(expected);
		// Concat consumers must observe the same args by parsing the accumulated delta string —
		// this is the contract proxy.ts reconstructs against.
		expect(JSON.parse(accumulated)).toEqual(expected);
	});

	it("keeps the single-chunk object case concat-safe", async () => {
		// The single-chunk path stays correct end-to-end: the proxy still
		// concatenates ("" then the final delta) and parses to the same args.
		const model = minimaxTokenPlanOpenAIModel("minimax-code-cn", "MiniMax-M3");
		const fetchMock = createMockFetch([
			toolCallChunk(model, { name: "edit", arguments: { input: "[foo.ts#A1B2]\nDEL 5" } }),
			stopChunk(model),
			"[DONE]",
		]);

		const s = streamOpenAICompletions(model, baseContext(), { apiKey: "test-key", fetch: fetchMock });
		let accumulated = "";
		for await (const event of s) {
			if (event.type === "toolcall_delta") accumulated += event.delta;
		}
		expect(JSON.parse(accumulated)).toEqual({ input: "[foo.ts#A1B2]\nDEL 5" });
	});
});
