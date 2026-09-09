/**
 * Tests for proxy stream behavior when the server disconnects
 * without sending a terminal event (done/error).
 *
 * Contract: `streamProxy` MUST emit an error event and resolve
 * `stream.result()` when the SSE stream ends without a terminal
 * event — it must NOT silently complete with default stopReason='stop'.
 */
import { describe, expect, it } from "bun:test";
import type { ProxyAssistantMessageEvent } from "@oh-my-pi/pi-agent-core/proxy";
import { type ProxyMessageEventStream, streamProxy } from "@oh-my-pi/pi-agent-core/proxy";
import type { AssistantMessage, AssistantMessageEvent, Context, FetchImpl, Model, ToolCall } from "@oh-my-pi/pi-ai";
import { getStreamingPartialJson } from "@oh-my-pi/pi-ai/utils/block-symbols";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

const mockModel: Model = buildModel({
	id: "test-model",
	name: "Test Model",
	api: "openai",
	provider: "test",
	baseUrl: "http://localhost:0",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 4096,
	maxTokens: 1024,
});

const mockContext: Context = {
	messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
};

function buildSseBody(events: ProxyAssistantMessageEvent[]): ReadableStream<Uint8Array> {
	const parts: string[] = [];
	for (const event of events) {
		parts.push(`data: ${JSON.stringify(event)}\n\n`);
	}
	const text = parts.join("");
	return new ReadableStream({
		start(controller) {
			controller.enqueue(new TextEncoder().encode(text));
			controller.close();
		},
	});
}

async function collectEvents(stream: ProxyMessageEventStream, timeoutMs = 2000): Promise<AssistantMessageEvent[]> {
	const events: AssistantMessageEvent[] = [];
	const iterator = stream[Symbol.asyncIterator]();
	const deadline = Date.now() + timeoutMs;

	while (Date.now() < deadline) {
		const { promise: timeoutPromise, resolve: timeoutResolve } =
			Promise.withResolvers<IteratorResult<AssistantMessageEvent>>();
		const timer = setTimeout(
			() => timeoutResolve({ value: undefined, done: true } as IteratorResult<AssistantMessageEvent>),
			timeoutMs,
		);
		const result = await Promise.race([iterator.next(), timeoutPromise]);
		clearTimeout(timer);
		if (result.done) break;
		events.push(result.value);
	}
	return events;
}

const baseUsage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

describe("streamProxy — server disconnect without terminal event", () => {
	it("emits an error event when server disconnects after start with no terminal event", async () => {
		const events: ProxyAssistantMessageEvent[] = [{ type: "start" }];
		const body = buildSseBody(events);
		const fetchMock: FetchImpl = () => Promise.resolve(new Response(body, { status: 200 }));

		const stream = streamProxy(mockModel, mockContext, {
			proxyUrl: "http://localhost:0",
			authToken: "test",
			fetch: fetchMock,
		});
		const collected = await collectEvents(stream);
		const errorEvent = collected.find(e => e.type === "error");
		expect(errorEvent).toBeDefined();
		if (errorEvent && errorEvent.type === "error") {
			expect(errorEvent.reason).toBe("error");
		}
	});

	it("resolves stream.result() with stopReason='error' when server disconnects mid-stream", async () => {
		const events: ProxyAssistantMessageEvent[] = [
			{ type: "start" },
			{ type: "text_start", contentIndex: 0 },
			{ type: "text_delta", contentIndex: 0, delta: "Hel" },
		];
		const body = buildSseBody(events);
		const fetchMock: FetchImpl = () => Promise.resolve(new Response(body, { status: 200 }));

		const stream = streamProxy(mockModel, mockContext, {
			proxyUrl: "http://localhost:0",
			authToken: "test",
			fetch: fetchMock,
		});

		// Consume iterator so the internal async function runs
		const collected = await collectEvents(stream);
		expect(collected.some(e => e.type === "error")).toBe(true);

		// stream.result() MUST resolve (not hang) with an error message
		const result = await stream.result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBeTruthy();
	});

	it("handles client-initiated abort with stopReason='aborted'", async () => {
		const abortController = new AbortController();
		// Pre-abort before any data arrives
		abortController.abort();

		const events: ProxyAssistantMessageEvent[] = [{ type: "start" }];
		const body = buildSseBody(events);
		const fetchMock: FetchImpl = () => Promise.resolve(new Response(body, { status: 200 }));

		const stream = streamProxy(mockModel, mockContext, {
			proxyUrl: "http://localhost:0",
			authToken: "test",
			signal: abortController.signal,
			fetch: fetchMock,
		});

		const collected = await collectEvents(stream);
		// Should get an error event with reason 'aborted'
		const errorEvent = collected.find(e => e.type === "error");
		expect(errorEvent).toBeDefined();
		if (errorEvent && errorEvent.type === "error") {
			expect(errorEvent.reason).toBe("aborted");
		}

		const result = await stream.result();
		expect(result.stopReason).toBe("aborted");
	});

	it("preserves custom abort reason when client aborts mid-stream", async () => {
		const abortController = new AbortController();
		abortController.abort("user-interrupt");

		const events: ProxyAssistantMessageEvent[] = [{ type: "start" }];
		const body = buildSseBody(events);
		const fetchMock: FetchImpl = () => Promise.resolve(new Response(body, { status: 200 }));

		const stream = streamProxy(mockModel, mockContext, {
			proxyUrl: "http://localhost:0",
			authToken: "test",
			signal: abortController.signal,
			fetch: fetchMock,
		});

		await collectEvents(stream);
		const result = await stream.result();
		expect(result.stopReason).toBe("aborted");
		// Custom abort reason must be preserved in errorMessage, not overwritten
		// by the generic "Proxy stream ended without a terminal event" message
		expect(result.errorMessage).toBe("user-interrupt");
	});

	it("completes normally when server sends a 'done' event", async () => {
		const events: ProxyAssistantMessageEvent[] = [
			{ type: "start" },
			{ type: "text_start", contentIndex: 0 },
			{ type: "text_delta", contentIndex: 0, delta: "Hello" },
			{ type: "text_end", contentIndex: 0 },
			{
				type: "done",
				reason: "stop",
				usage: { ...baseUsage },
			},
		];
		const body = buildSseBody(events);
		const fetchMock: FetchImpl = () => Promise.resolve(new Response(body, { status: 200 }));

		const stream = streamProxy(mockModel, mockContext, {
			proxyUrl: "http://localhost:0",
			authToken: "test",
			fetch: fetchMock,
		});

		const collected = await collectEvents(stream);
		expect(collected.some(e => e.type === "done")).toBe(true);

		const result = await stream.result();
		expect(result.stopReason).toBe("stop");
		expect(result.content).toEqual([{ type: "text", text: "Hello" }]);
	});

	it("restores terminal blocks that have no proxy stream events", async () => {
		const finalizedContent: AssistantMessage["content"] = [
			{ type: "thinking", thinking: "Search first.", thinkingSignature: "sig-1" },
			{
				type: "anthropicServerTool",
				block: {
					type: "server_tool_use",
					id: "srvtoolu_1",
					name: "web_search",
					input: { query: "current UTC date" },
				},
			},
			{
				type: "anthropicServerTool",
				block: {
					type: "web_search_tool_result",
					tool_use_id: "srvtoolu_1",
					content: [{ type: "web_search_result", encrypted_content: "opaque-result" }],
				},
			},
			{ type: "thinking", thinking: "Use the result.", thinkingSignature: "sig-2" },
			{ type: "toolCall", id: "toolu_write", name: "write", arguments: { path: "date.txt" } },
		];
		const events: ProxyAssistantMessageEvent[] = [
			{ type: "start" },
			{ type: "thinking_start", contentIndex: 0 },
			{ type: "thinking_delta", contentIndex: 0, delta: "Search first." },
			{ type: "thinking_end", contentIndex: 0, contentSignature: "sig-1" },
			{ type: "thinking_start", contentIndex: 1 },
			{ type: "thinking_delta", contentIndex: 1, delta: "Use the result." },
			{ type: "thinking_end", contentIndex: 1, contentSignature: "sig-2" },
			{ type: "toolcall_start", contentIndex: 2, id: "toolu_write", toolName: "write" },
			{ type: "toolcall_delta", contentIndex: 2, delta: '{"path":"date.txt"}' },
			{ type: "toolcall_end", contentIndex: 2 },
			{ type: "done", reason: "toolUse", usage: { ...baseUsage }, content: finalizedContent },
		];
		const body = buildSseBody(events);
		const fetchMock: FetchImpl = () => Promise.resolve(new Response(body, { status: 200 }));

		const result = await streamProxy(mockModel, mockContext, {
			proxyUrl: "http://localhost:0",
			authToken: "test",
			fetch: fetchMock,
		}).result();

		expect(result.content).toEqual(finalizedContent);
	});

	it("completes with error event when server sends an 'error' terminal event", async () => {
		const events: ProxyAssistantMessageEvent[] = [
			{ type: "start" },
			{ type: "text_start", contentIndex: 0 },
			{ type: "text_delta", contentIndex: 0, delta: "Hel" },
			{
				type: "error",
				reason: "error",
				errorMessage: "rate_limit_exceeded",
				usage: { ...baseUsage },
			},
		];
		const body = buildSseBody(events);
		const fetchMock: FetchImpl = () => Promise.resolve(new Response(body, { status: 200 }));

		const stream = streamProxy(mockModel, mockContext, {
			proxyUrl: "http://localhost:0",
			authToken: "test",
			fetch: fetchMock,
		});

		const collected = await collectEvents(stream);
		expect(collected.some(e => e.type === "error")).toBe(true);

		const result = await stream.result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe("rate_limit_exceeded");
		expect(result.content).toEqual([{ type: "text", text: "Hel" }]);
	});

	it("does not leak partialJson when server disconnects mid-tool-call", async () => {
		// Stream sends toolcall_start + partial toolcall_delta, then disconnects
		// without toolcall_end, done, or error. The catch-block error path must
		// scrub partialJson from the content before pushing the error event.
		const events: ProxyAssistantMessageEvent[] = [
			{ type: "start" },
			{ type: "toolcall_start", contentIndex: 0, id: "call_1", toolName: "bash" },
			{ type: "toolcall_delta", contentIndex: 0, delta: '{"comm' },
		];
		const body = buildSseBody(events);
		const fetchMock: FetchImpl = () => Promise.resolve(new Response(body, { status: 200 }));

		const stream = streamProxy(mockModel, mockContext, {
			proxyUrl: "http://localhost:0",
			authToken: "test",
			fetch: fetchMock,
		});

		const collected = await collectEvents(stream);
		expect(collected.some(e => e.type === "error")).toBe(true);

		const result = await stream.result();
		expect(result.stopReason).toBe("error");
		const toolCall = result.content.find((c): c is ToolCall => c.type === "toolCall");
		expect(toolCall).toBeDefined();
		if (toolCall) {
			expect(getStreamingPartialJson(toolCall)).toBeUndefined();
		}
	});
});
