import { describe, expect, it } from "bun:test";
import { encodeResponse, encodeStream, parseRequest } from "@pk-nerdsaver-ai/pi-ai/providers/openai-responses-server";
import type { AssistantMessage } from "@pk-nerdsaver-ai/pi-ai/types";
import { AssistantMessageEventStream } from "@pk-nerdsaver-ai/pi-ai/utils/event-stream";
import { Effort } from "@pk-nerdsaver-ai/pi-catalog/effort";

function zeroUsage(): AssistantMessage["usage"] {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

async function collectStream(stream: ReadableStream<Uint8Array>): Promise<string> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let out = "";
	while (true) {
		const { value, done } = await reader.read();
		if (done) break;
		out += decoder.decode(value);
	}
	return out;
}

interface SseFrame {
	event: string;
	data: Record<string, unknown> | string;
}

function parseSse(raw: string): SseFrame[] {
	const frames: SseFrame[] = [];
	for (const chunk of raw.split("\n\n")) {
		if (!chunk.trim()) continue;
		let event = "";
		let dataLine = "";
		for (const line of chunk.split("\n")) {
			if (line.startsWith("event: ")) event = line.slice("event: ".length);
			else if (line.startsWith("data: ")) dataLine = line.slice("data: ".length);
		}
		if (dataLine === "[DONE]") {
			frames.push({ event: event || "done_sentinel", data: "[DONE]" });
		} else if (dataLine) {
			const parsed: unknown = JSON.parse(dataLine);
			if (parsed && typeof parsed === "object") {
				frames.push({ event, data: parsed as Record<string, unknown> });
			}
		}
	}
	return frames;
}

describe("openai-responses parseRequest", () => {
	it("parses an input array with mixed message + reasoning + function_call + function_call_output", () => {
		const reasoningItem = {
			type: "reasoning",
			id: "rs_abc",
			summary: [{ type: "summary_text", text: "The user wants arithmetic." }],
		};
		const parsed = parseRequest({
			model: "gpt-5.3-codex-spark",
			instructions: "You are X",
			input: [
				{ type: "message", role: "user", content: [{ type: "input_text", text: "what's 2+2?" }] },
				{
					type: "message",
					role: "assistant",
					id: "msg_commentary",
					phase: "commentary",
					content: [
						{ type: "output_text", text: "Let me " },
						{ type: "output_text", text: "think." },
					],
				},
				reasoningItem,
				{
					type: "function_call",
					id: "fc_item_999",
					call_id: "call_42",
					name: "math",
					arguments: '{"a":2,"b":2}',
				},
				{ type: "function_call_output", call_id: "call_42", output: "4" },
			],
			tools: [
				{
					type: "function",
					name: "math",
					description: "Do arithmetic",
					parameters: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } } },
					strict: true,
				},
			],
			tool_choice: { type: "function", name: "math" },
			max_output_tokens: 1024,
			temperature: 0.1,
			top_p: 0.9,
			reasoning: { effort: "high", summary: "detailed" },
			store: true,
			previous_response_id: "resp_prev",
			stream: true,
		});

		expect(parsed.modelId).toBe("gpt-5.3-codex-spark");
		expect(parsed.stream).toBe(true);
		expect(parsed.context.systemPrompt).toEqual(["You are X"]);

		const msgs = parsed.context.messages;
		expect(msgs).toHaveLength(3);

		// 1. user
		expect(msgs[0]!.role).toBe("user");
		const u = msgs[0]!;
		if (u.role !== "user") throw new Error("expected user");
		expect(u.content).toBe("what's 2+2?");

		// 2. assistant with text + reasoning + toolCall
		const a = msgs[1]!;
		if (a.role !== "assistant") throw new Error("expected assistant");
		expect(a.api).toBe("openai-responses");
		expect(a.provider).toBe("openai");
		expect(a.model).toBe("gpt-5.3-codex-spark");
		expect(a.content).toHaveLength(3);
		expect(a.content[0]).toMatchObject({ type: "text", text: "Let me think." });
		const commentary = a.content[0];
		if (commentary?.type !== "text") throw new Error("expected commentary text");
		expect(commentary.textSignature).toBe(JSON.stringify({ v: 1, id: "msg_commentary", phase: "commentary" }));
		expect(a.content[1]).toMatchObject({
			type: "thinking",
			thinking: "The user wants arithmetic.",
			thinkingSignature: JSON.stringify(reasoningItem),
			itemId: "rs_abc",
		});
		// Critical: call_id and item id are distinct.
		expect(a.content[2]).toMatchObject({
			type: "toolCall",
			id: "call_42",
			name: "math",
			arguments: { a: 2, b: 2 },
			thoughtSignature: "fc_item_999",
		});

		// 3. toolResult
		const tr = msgs[2]!;
		if (tr.role !== "toolResult") throw new Error("expected toolResult");
		expect(tr.toolCallId).toBe("call_42");
		expect(tr.toolName).toBe("math");
		expect(tr.content).toEqual([{ type: "text", text: "4" }]);
		expect(tr.isError).toBe(false);

		expect(parsed.context.tools).toHaveLength(1);
		expect(parsed.context.tools![0]).toMatchObject({ name: "math", strict: true });

		expect(parsed.options.maxOutputTokens).toBe(1024);
		expect(parsed.options.temperature).toBe(0.1);
		expect(parsed.options.topP).toBe(0.9);
		expect(parsed.options.toolChoice).toEqual({ name: "math" });
		expect(parsed.options.reasoning).toBe(Effort.High);
		// `reasoning.summary: "detailed"` is treated as the default visible-summary
		// case (only "none" toggles hideThinkingSummary).
		expect(parsed.options.hideThinkingSummary).toBeUndefined();
		// `store` and `previous_response_id` are accepted by the schema but not
		// plumbed through pi-ai — they no longer leak into options.extra.
		expect(parsed.options.extra).toBeUndefined();
	});

	it("accepts a bare string input and rejects a missing model", () => {
		const parsed = parseRequest({ model: "m", input: "hi" });
		expect(parsed.context.messages).toHaveLength(1);
		const m = parsed.context.messages[0]!;
		if (m.role !== "user") throw new Error("expected user");
		expect(m.content).toBe("hi");

		expect(() => parseRequest({ input: "hi" })).toThrow(/model/);
	});

	it("preserves string message content and system input items", () => {
		const parsed = parseRequest({
			model: "m",
			instructions: "top-level instructions",
			input: [
				{ role: "system", content: "system from easy input" },
				{ role: "user", content: "hello" },
				{ role: "assistant", content: "hi there" },
				{
					type: "message",
					role: "system",
					content: [{ type: "input_text", text: "structured system" }],
				},
			],
		});

		expect(parsed.context.systemPrompt).toEqual([
			"top-level instructions",
			"system from easy input",
			"structured system",
		]);
		expect(parsed.context.messages).toHaveLength(2);
		const user = parsed.context.messages[0]!;
		const assistant = parsed.context.messages[1]!;
		if (user.role !== "user") throw new Error("expected user");
		if (assistant.role !== "assistant") throw new Error("expected assistant");
		expect(user.content).toBe("hello");
		expect(assistant.content).toEqual([{ type: "text", text: "hi there" }]);
	});

	it("creates a synthetic assistant when reasoning comes before any assistant message", () => {
		const reasoningItem = {
			type: "reasoning",
			id: "rs_x",
			content: [{ type: "reasoning_text", text: "hmm" }],
		};
		const parsed = parseRequest({
			model: "m",
			input: [reasoningItem],
		});
		expect(parsed.context.messages).toHaveLength(1);
		const a = parsed.context.messages[0]!;
		if (a.role !== "assistant") throw new Error("expected synthetic assistant");
		expect(a.content).toHaveLength(1);
		expect(a.content[0]).toMatchObject({
			type: "thinking",
			thinking: "hmm",
			thinkingSignature: JSON.stringify(reasoningItem),
			itemId: "rs_x",
		});
	});
});

describe("openai-responses encodeResponse", () => {
	it("encodes reasoning + message + function_call output items", () => {
		const reasoningItem = {
			type: "reasoning",
			id: "rs_signed",
			summary: [{ type: "summary_text", text: "thinking aloud" }],
		};
		const message: AssistantMessage = {
			role: "assistant",
			api: "openai-responses",
			provider: "openai",
			model: "gpt-5",
			content: [
				{
					type: "thinking",
					thinking: "thinking aloud",
					thinkingSignature: JSON.stringify(reasoningItem),
					itemId: "rs_signed",
				},
				{ type: "text", text: "Hello " },
				{ type: "text", text: "world" },
				{
					type: "toolCall",
					id: "call_t1",
					name: "math",
					arguments: { a: 1, b: 2 },
					thoughtSignature: "fc_item_t1",
				},
			],
			usage: {
				...zeroUsage(),
				input: 10,
				output: 20,
				cacheRead: 4,
				cacheWrite: 6,
				reasoningTokens: 5,
			},
			stopReason: "toolUse",
			timestamp: 1_700_000_000_000,
		};

		const body = encodeResponse(message, "gpt-5-requested");

		expect(body.object).toBe("response");
		expect(body.status).toBe("completed");
		expect(body.model).toBe("gpt-5-requested");
		expect(body.created_at).toBe(1_700_000_000);
		expect(typeof body.id).toBe("string");
		expect((body.id as string).startsWith("resp_")).toBe(true);

		const output = body.output as Array<Record<string, unknown>>;
		expect(output).toHaveLength(3);

		expect(output[0]).toEqual(reasoningItem);

		// Consecutive text collapses into one message item with two parts.
		expect(output[1]!.type).toBe("message");
		expect(output[1]!.role).toBe("assistant");
		const parts = output[1]!.content as Array<{ type: string; text: string; annotations: never[] }>;
		expect(parts).toEqual([
			{ type: "output_text", text: "Hello ", annotations: [] },
			{ type: "output_text", text: "world", annotations: [] },
		]);

		// function_call: wire id (thoughtSignature) and call_id are distinct.
		expect(output[2]).toMatchObject({
			type: "function_call",
			id: "fc_item_t1",
			call_id: "call_t1",
			name: "math",
			arguments: '{"a":1,"b":2}',
			status: "completed",
		});

		expect(body.usage).toEqual({
			input_tokens: 20,
			input_tokens_details: { cached_tokens: 4 },
			output_tokens: 20,
			output_tokens_details: { reasoning_tokens: 5 },
			total_tokens: 40,
		});
	});

	it("encodes assistant message phase from text signatures", () => {
		const message: AssistantMessage = {
			role: "assistant",
			api: "openai-responses",
			provider: "openai",
			model: "gpt-5",
			content: [
				{
					type: "text",
					text: "Intermediate update",
					textSignature: JSON.stringify({ v: 1, id: "msg_commentary", phase: "commentary" }),
				},
				{
					type: "text",
					text: "Final answer",
					textSignature: JSON.stringify({ v: 1, id: "msg_final", phase: "final_answer" }),
				},
			],
			usage: zeroUsage(),
			stopReason: "stop",
			timestamp: 1_700_000_000_000,
		};

		const body = encodeResponse(message, "gpt-5-requested");
		const output = body.output as Array<Record<string, unknown>>;

		expect(output).toHaveLength(2);
		expect(output[0]).toMatchObject({
			type: "message",
			id: "msg_commentary",
			role: "assistant",
			status: "completed",
			phase: "commentary",
			content: [{ type: "output_text", text: "Intermediate update", annotations: [] }],
		});
		expect(output[1]).toMatchObject({
			type: "message",
			id: "msg_final",
			role: "assistant",
			status: "completed",
			phase: "final_answer",
			content: [{ type: "output_text", text: "Final answer", annotations: [] }],
		});
	});

	it("marks length-limited responses incomplete", () => {
		const message: AssistantMessage = {
			role: "assistant",
			api: "openai-responses",
			provider: "openai",
			model: "gpt-5",
			content: [{ type: "text", text: "partial" }],
			usage: zeroUsage(),
			stopReason: "length",
			timestamp: 1_700_000_000_000,
		};

		const body = encodeResponse(message, "gpt-5-requested");

		expect(body.status).toBe("incomplete");
		expect(body.incomplete_details).toEqual({ reason: "max_output_tokens" });
	});
});

describe("openai-responses encodeStream", () => {
	it("emits response.created, reasoning_summary_text.delta, output_text.delta, function_call_arguments.delta, response.completed, [DONE]", async () => {
		const stream = new AssistantMessageEventStream();

		const partial: AssistantMessage = {
			role: "assistant",
			api: "openai-responses",
			provider: "openai",
			model: "gpt-5",
			content: [],
			usage: zeroUsage(),
			stopReason: "stop",
			timestamp: 1_700_000_000_000,
		};

		const finalMessage: AssistantMessage = {
			role: "assistant",
			api: "openai-responses",
			provider: "openai",
			model: "gpt-5",
			content: [
				{ type: "thinking", thinking: "step 1", thinkingSignature: "rs_s1", itemId: "rs_s1" },
				{ type: "text", text: "Hi!" },
				{
					type: "toolCall",
					id: "call_x",
					name: "math",
					arguments: { a: 1 },
					thoughtSignature: "fc_x",
				},
			],
			usage: { ...zeroUsage(), input: 1, output: 2 },
			stopReason: "toolUse",
			timestamp: 1_700_000_000_000,
		};

		// Push events asynchronously while consumer reads.
		const partialWithThinking: AssistantMessage = {
			...partial,
			content: [{ type: "thinking", thinking: "", thinkingSignature: "rs_s1", itemId: "rs_s1" }],
		};
		const partialWithToolCall: AssistantMessage = {
			...partial,
			content: [
				{ type: "thinking", thinking: "step 1", thinkingSignature: "rs_s1", itemId: "rs_s1" },
				{ type: "text", text: "Hi!" },
				{ type: "toolCall", id: "call_x", name: "math", arguments: {}, thoughtSignature: "fc_x" },
			],
		};

		queueMicrotask(() => {
			stream.push({ type: "start", partial });
			stream.push({ type: "thinking_start", contentIndex: 0, partial: partialWithThinking });
			stream.push({ type: "thinking_delta", contentIndex: 0, delta: "step ", partial: partialWithThinking });
			stream.push({ type: "thinking_delta", contentIndex: 0, delta: "1", partial: partialWithThinking });
			stream.push({ type: "thinking_end", contentIndex: 0, content: "step 1", partial: partialWithThinking });
			stream.push({ type: "text_start", contentIndex: 1, partial });
			stream.push({ type: "text_delta", contentIndex: 1, delta: "Hi", partial });
			stream.push({ type: "text_delta", contentIndex: 1, delta: "!", partial });
			stream.push({ type: "text_end", contentIndex: 1, content: "Hi!", partial });
			stream.push({ type: "toolcall_start", contentIndex: 2, partial: partialWithToolCall });
			stream.push({ type: "toolcall_delta", contentIndex: 2, delta: '{"a":', partial: partialWithToolCall });
			stream.push({ type: "toolcall_delta", contentIndex: 2, delta: "1}", partial: partialWithToolCall });
			stream.push({
				type: "toolcall_end",
				contentIndex: 2,
				toolCall: {
					type: "toolCall",
					id: "call_x",
					name: "math",
					arguments: { a: 1 },
					thoughtSignature: "fc_x",
				},
				partial: partialWithToolCall,
			});
			stream.push({ type: "done", reason: "toolUse", message: finalMessage });
		});

		const raw = await collectStream(encodeStream(stream, "gpt-5-requested"));
		const frames = parseSse(raw);
		const names = frames.map(f => f.event);

		// Ordering: created → thinking flow → message flow → tool-call flow → completed → [DONE]
		expect(names[0]).toBe("response.created");
		expect(names[names.length - 1]).toBe("done_sentinel");
		expect(frames[frames.length - 1]!.data).toBe("[DONE]");

		// Spot-check critical events appear in the expected order.
		const idxCreated = names.indexOf("response.created");
		const idxReasoningDelta = names.indexOf("response.reasoning_summary_text.delta");
		const idxReasoningDone = names.indexOf("response.reasoning_summary_text.done");
		const idxTextDelta = names.indexOf("response.output_text.delta");
		const idxTextDone = names.indexOf("response.output_text.done");
		const idxArgsDelta = names.indexOf("response.function_call_arguments.delta");
		const idxMessageDone = frames.findIndex(
			f =>
				f.event === "response.output_item.done" &&
				(f.data as Record<string, unknown>).item &&
				((f.data as Record<string, unknown>).item as Record<string, unknown>).type === "message",
		);
		const idxArgsDone = names.indexOf("response.function_call_arguments.done");
		const idxCompleted = names.indexOf("response.completed");

		expect(idxCreated).toBeGreaterThanOrEqual(0);
		expect(idxReasoningDelta).toBeGreaterThan(idxCreated);
		expect(idxReasoningDone).toBeGreaterThan(idxReasoningDelta);
		expect(idxTextDelta).toBeGreaterThan(idxReasoningDone);
		expect(idxTextDone).toBeGreaterThan(idxTextDelta);
		expect(idxArgsDelta).toBeGreaterThan(idxTextDone);
		expect(idxArgsDone).toBeGreaterThan(idxArgsDelta);
		expect(idxCompleted).toBeGreaterThan(idxArgsDone);

		// reasoning_summary_text.delta must carry item_id matching the signature, and output_index 0.
		const reasoningDelta = frames[idxReasoningDelta]!.data as Record<string, unknown>;
		expect(reasoningDelta.item_id).toBe("rs_s1");
		expect(reasoningDelta.output_index).toBe(0);
		expect(reasoningDelta.delta).toBe("step ");

		// output_text.delta's item_id is a new msg_*, output_index moved on past the reasoning item.
		const textDelta = frames[idxTextDelta]!.data as Record<string, unknown>;
		expect(typeof textDelta.item_id).toBe("string");
		expect((textDelta.item_id as string).startsWith("msg_")).toBe(true);
		expect(textDelta.output_index).toBe(1);
		expect(textDelta.delta).toBe("Hi");
		expect(textDelta.logprobs).toEqual([]);

		const textDone = frames[idxTextDone]!.data as Record<string, unknown>;
		expect(textDone.text).toBe("Hi!");
		expect(textDone.logprobs).toEqual([]);

		const messageDone = frames[idxMessageDone]!.data as Record<string, unknown>;
		expect(messageDone.output_index).toBe(1);
		expect(messageDone.item).toMatchObject({
			type: "message",
			status: "completed",
			content: [{ type: "output_text", text: "Hi!", annotations: [] }],
		});

		// function_call_arguments.delta uses the fc_* wire id, NOT call_x.
		const argsDelta = frames[idxArgsDelta]!.data as Record<string, unknown>;
		expect(argsDelta.item_id).toBe("fc_x");
		expect(argsDelta.output_index).toBe(2);
		expect(argsDelta.delta).toBe('{"a":');

		const argsDone = frames[idxArgsDone]!.data as Record<string, unknown>;
		expect(argsDone.item_id).toBe("fc_x");
		expect(argsDone.arguments).toBe('{"a":1}');
		expect(argsDone.name).toBe("math");

		// response.completed: assert the final response object carries the full output items
		// and that call_id ≠ id for the function_call item.
		const completed = frames[idxCompleted]!.data as Record<string, unknown>;
		const response = completed.response as Record<string, unknown>;
		expect(response.status).toBe("completed");
		expect(response.model).toBe("gpt-5-requested");
		const output = response.output as Array<Record<string, unknown>>;
		expect(output).toHaveLength(3);
		expect(output[0]!.type).toBe("reasoning");
		expect(output[1]!.type).toBe("message");
		expect(output[2]).toMatchObject({
			type: "function_call",
			id: "fc_x",
			call_id: "call_x",
			name: "math",
			arguments: '{"a":1}',
		});
		// Critical gotcha: id and call_id are distinct.
		expect(output[2]!.id).not.toBe(output[2]!.call_id);
	});

	it("streams assistant message phase from text signatures", async () => {
		const stream = new AssistantMessageEventStream();
		const textSignature = JSON.stringify({ v: 1, id: "msg_commentary", phase: "commentary" });
		const message: AssistantMessage = {
			role: "assistant",
			api: "openai-responses",
			provider: "openai",
			model: "gpt-5",
			content: [{ type: "text", text: "Working", textSignature }],
			usage: { ...zeroUsage(), input: 1, output: 1 },
			stopReason: "stop",
			timestamp: 1_700_000_000_000,
		};

		queueMicrotask(() => {
			stream.push({ type: "start", partial: { ...message, content: [] } });
			stream.push({ type: "text_start", contentIndex: 0, partial: message });
			stream.push({ type: "text_delta", contentIndex: 0, delta: "Working", partial: message });
			stream.push({ type: "text_end", contentIndex: 0, content: "Working", partial: message });
			stream.push({ type: "done", reason: "stop", message });
		});

		const raw = await collectStream(encodeStream(stream, "gpt-5-requested"));
		const frames = parseSse(raw);
		const messageItems = frames
			.filter(f => f.event === "response.output_item.added" || f.event === "response.output_item.done")
			.map(f => (f.data as Record<string, unknown>).item as Record<string, unknown>)
			.filter(item => item.type === "message");
		const completed = frames.find(f => f.event === "response.completed")?.data as Record<string, unknown> | undefined;
		const response = completed?.response as Record<string, unknown> | undefined;
		const output = response?.output as Array<Record<string, unknown>> | undefined;

		expect(messageItems).toHaveLength(2);
		expect(messageItems[0]).toMatchObject({ id: "msg_commentary", phase: "commentary" });
		expect(messageItems[1]).toMatchObject({ id: "msg_commentary", phase: "commentary" });
		expect(output?.[0]).toMatchObject({ id: "msg_commentary", phase: "commentary" });
	});

	it("routes late tool-call deltas by contentIndex after later parallel starts", async () => {
		const stream = new AssistantMessageEventStream();
		const base: AssistantMessage = {
			role: "assistant",
			api: "openai-responses",
			provider: "openai",
			model: "gpt-5",
			content: [],
			usage: zeroUsage(),
			stopReason: "toolUse",
			timestamp: 1_700_000_000_000,
		};
		const callA = { type: "toolCall" as const, id: "call_a", name: "edit", arguments: {} };
		const callB = { type: "toolCall" as const, id: "call_b", name: "read", arguments: {} };
		const partialA: AssistantMessage = { ...base, content: [callA] };
		const partialBoth: AssistantMessage = { ...base, content: [callA, callB] };
		const finalMessage: AssistantMessage = {
			...base,
			content: [
				{ ...callA, arguments: { input: "first" } },
				{ ...callB, arguments: { path: "second" } },
			],
		};

		queueMicrotask(() => {
			stream.push({ type: "start", partial: base });
			stream.push({ type: "toolcall_start", contentIndex: 0, partial: partialA });
			stream.push({ type: "toolcall_start", contentIndex: 1, partial: partialBoth });
			stream.push({ type: "toolcall_delta", contentIndex: 0, delta: '{"input":"first"}', partial: partialBoth });
			stream.push({
				type: "toolcall_end",
				contentIndex: 0,
				toolCall: { ...callA, arguments: { input: "first" } },
				partial: partialBoth,
			});
			stream.push({ type: "toolcall_delta", contentIndex: 1, delta: '{"path":"second"}', partial: partialBoth });
			stream.push({
				type: "toolcall_end",
				contentIndex: 1,
				toolCall: { ...callB, arguments: { path: "second" } },
				partial: partialBoth,
			});
			stream.push({ type: "done", reason: "toolUse", message: finalMessage });
		});

		const raw = await collectStream(encodeStream(stream, "gpt-5-requested"));
		const frames = parseSse(raw);
		const argumentDeltas = frames.filter(f => f.event === "response.function_call_arguments.delta");
		expect(argumentDeltas.map(f => (f.data as Record<string, unknown>).output_index)).toEqual([0, 1]);
		expect(argumentDeltas.map(f => (f.data as Record<string, unknown>).delta)).toEqual([
			'{"input":"first"}',
			'{"path":"second"}',
		]);

		const argumentDone = frames.filter(f => f.event === "response.function_call_arguments.done");
		expect(argumentDone.map(f => (f.data as Record<string, unknown>).output_index)).toEqual([0, 1]);
		expect(argumentDone.map(f => (f.data as Record<string, unknown>).arguments)).toEqual([
			'{"input":"first"}',
			'{"path":"second"}',
		]);

		const doneItems = frames
			.filter(f => f.event === "response.output_item.done")
			.map(f => (f.data as Record<string, unknown>).item as Record<string, unknown>)
			.filter(item => item.type === "function_call");

		expect(doneItems).toHaveLength(2);
		expect(doneItems[0]).toMatchObject({ call_id: "call_a", name: "edit", arguments: '{"input":"first"}' });
		expect(doneItems[1]).toMatchObject({ call_id: "call_b", name: "read", arguments: '{"path":"second"}' });
	});
	it("emits response.incomplete for length-limited streams", async () => {
		const stream = new AssistantMessageEventStream();
		const message: AssistantMessage = {
			role: "assistant",
			api: "openai-responses",
			provider: "openai",
			model: "gpt-5",
			content: [{ type: "text", text: "partial" }],
			usage: { ...zeroUsage(), output: 1 },
			stopReason: "length",
			timestamp: 1_700_000_000_000,
		};

		queueMicrotask(() => {
			stream.push({ type: "start", partial: { ...message, content: [] } });
			stream.push({ type: "text_start", contentIndex: 0, partial: message });
			stream.push({ type: "text_delta", contentIndex: 0, delta: "partial", partial: message });
			stream.push({ type: "text_end", contentIndex: 0, content: "partial", partial: message });
			stream.push({ type: "done", reason: "length", message });
		});

		const raw = await collectStream(encodeStream(stream, "gpt-5-requested"));
		const frames = parseSse(raw);
		const names = frames.map(f => f.event);
		const idxIncomplete = names.indexOf("response.incomplete");

		expect(idxIncomplete).toBeGreaterThan(-1);
		expect(names).not.toContain("response.completed");
		const incomplete = frames[idxIncomplete]!.data as Record<string, unknown>;
		const response = incomplete.response as Record<string, unknown>;
		expect(response.status).toBe("incomplete");
		expect(response.incomplete_details).toEqual({ reason: "max_output_tokens" });
	});
});
