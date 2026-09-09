/**
 * Tests for proxy stream tool-call parsing.
 *
 * Contract: `streamProxy` MUST parse streaming tool-call arguments from
 * `toolcall_delta` events and MUST NOT leak internal `partialJson` state
 * into the final `AssistantMessage` content blocks — even when the stream
 * ends without a `toolcall_end` event.
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

function extractToolCall(result: AssistantMessage): ToolCall {
	const toolCall = result.content.find((c): c is ToolCall => c.type === "toolCall");
	expect(toolCall).toBeDefined();
	return toolCall!;
}

describe("streamProxy — tool-call streaming and partialJson isolation", () => {
	it("parses complete tool-call arguments from streamed deltas", async () => {
		const events: ProxyAssistantMessageEvent[] = [
			{ type: "start" },
			{ type: "toolcall_start", contentIndex: 0, id: "call_1", toolName: "bash" },
			{ type: "toolcall_delta", contentIndex: 0, delta: '{"comm' },
			{ type: "toolcall_delta", contentIndex: 0, delta: 'and":"ls"}' },
			{ type: "toolcall_end", contentIndex: 0 },
			{
				type: "done",
				reason: "toolUse",
				usage: { ...baseUsage },
				content: [{ type: "toolCall", id: "call_1", name: "bash", arguments: { command: "ls" } }],
			},
		];
		const body = buildSseBody(events);
		const fetchMock: FetchImpl = () => Promise.resolve(new Response(body, { status: 200 }));

		const stream = streamProxy(mockModel, mockContext, {
			proxyUrl: "http://localhost:0",
			authToken: "test",
			fetch: fetchMock,
		});

		await collectEvents(stream);
		const result = await stream.result();
		const toolCall = extractToolCall(result);
		expect(toolCall.id).toBe("call_1");
		expect(toolCall.name).toBe("bash");
		expect(toolCall.arguments).toEqual({ command: "ls" });
	});

	it("exposes partialJson on content during streaming for renderers", async () => {
		// Downstream renderers (event-controller.ts) read getStreamingPartialJson(content)
		// during toolcall_delta to pace streaming previews. The field must be
		// present on the partial snapshot while streaming is in progress.
		// Note: partial is a shared mutable reference, so we snapshot the
		// partialJson value during iteration — by the time the stream completes,
		// scrubPartialJson will have deleted it.
		const events: ProxyAssistantMessageEvent[] = [
			{ type: "start" },
			{ type: "toolcall_start", contentIndex: 0, id: "call_1", toolName: "bash" },
			{ type: "toolcall_delta", contentIndex: 0, delta: '{"comm' },
			{ type: "toolcall_delta", contentIndex: 0, delta: 'and":"ls"}' },
			{ type: "toolcall_end", contentIndex: 0 },
			{
				type: "done",
				reason: "toolUse",
				usage: { ...baseUsage },
				content: [{ type: "toolCall", id: "call_1", name: "bash", arguments: { command: "ls" } }],
			},
		];
		const body = buildSseBody(events);
		const fetchMock: FetchImpl = () => Promise.resolve(new Response(body, { status: 200 }));

		const stream = streamProxy(mockModel, mockContext, {
			proxyUrl: "http://localhost:0",
			authToken: "test",
			fetch: fetchMock,
		});

		// Collect delta events and snapshot partialJson during iteration,
		// before the done event scrubs it from the shared partial reference.
		const deltaSnapshots: Array<{ hasPartialJson: boolean; value: string | undefined }> = [];
		const iterator = stream[Symbol.asyncIterator]();
		const deadline = Date.now() + 2000;
		while (Date.now() < deadline) {
			const { promise: timeoutPromise, resolve: timeoutResolve } =
				Promise.withResolvers<IteratorResult<AssistantMessageEvent>>();
			const timer = setTimeout(
				() => timeoutResolve({ value: undefined, done: true } as IteratorResult<AssistantMessageEvent>),
				2000,
			);
			const result = await Promise.race([iterator.next(), timeoutPromise]);
			clearTimeout(timer);
			if (result.done) break;
			if (result.value.type === "toolcall_delta") {
				const content = result.value.partial.content[0];
				deltaSnapshots.push({
					hasPartialJson: getStreamingPartialJson(content) !== undefined,
					value: getStreamingPartialJson(content),
				});
			}
		}

		expect(deltaSnapshots.length).toBe(2);
		for (const snap of deltaSnapshots) {
			expect(snap.hasPartialJson).toBe(true);
			expect(snap.value).toBeTruthy();
		}

		// After completion, partialJson must be gone
		const result = await stream.result();
		const toolCall = extractToolCall(result);
		expect(getStreamingPartialJson(toolCall)).toBeUndefined();
	});

	it("does not leak partialJson field into the final ToolCall object", async () => {
		const events: ProxyAssistantMessageEvent[] = [
			{ type: "start" },
			{ type: "toolcall_start", contentIndex: 0, id: "call_1", toolName: "read" },
			{ type: "toolcall_delta", contentIndex: 0, delta: '{"path' },
			{ type: "toolcall_delta", contentIndex: 0, delta: '":"/tmp/x"}' },
			{ type: "toolcall_end", contentIndex: 0 },
			{
				type: "done",
				reason: "toolUse",
				usage: { ...baseUsage },
				content: [{ type: "toolCall", id: "call_1", name: "read", arguments: { path: "/tmp/x" } }],
			},
		];
		const body = buildSseBody(events);
		const fetchMock: FetchImpl = () => Promise.resolve(new Response(body, { status: 200 }));

		const stream = streamProxy(mockModel, mockContext, {
			proxyUrl: "http://localhost:0",
			authToken: "test",
			fetch: fetchMock,
		});

		await collectEvents(stream);
		const result = await stream.result();
		const toolCall = extractToolCall(result);
		// partialJson is internal streaming state that must never appear on the
		// typed ToolCall — its presence would corrupt downstream serialization.
		expect(getStreamingPartialJson(toolCall)).toBeUndefined();
		expect(toolCall.arguments).toEqual({ path: "/tmp/x" });
	});

	it("does not leak partialJson when stream ends without toolcall_end", async () => {
		// Stream ends abruptly after toolcall_delta — no toolcall_end, then
		// a done event. The partialJson state must not leak into the result.
		const events: ProxyAssistantMessageEvent[] = [
			{ type: "start" },
			{ type: "toolcall_start", contentIndex: 0, id: "call_1", toolName: "edit" },
			{ type: "toolcall_delta", contentIndex: 0, delta: '{"path' },
			{ type: "toolcall_delta", contentIndex: 0, delta: '":"/a"}' },
			// Missing toolcall_end — stream goes straight to done
			{
				type: "done",
				reason: "toolUse",
				usage: { ...baseUsage },
				content: [{ type: "toolCall", id: "call_1", name: "edit", arguments: { path: "/a" } }],
			},
		];
		const body = buildSseBody(events);
		const fetchMock: FetchImpl = () => Promise.resolve(new Response(body, { status: 200 }));

		const stream = streamProxy(mockModel, mockContext, {
			proxyUrl: "http://localhost:0",
			authToken: "test",
			fetch: fetchMock,
		});

		await collectEvents(stream);
		const result = await stream.result();
		const toolCall = extractToolCall(result);
		expect(getStreamingPartialJson(toolCall)).toBeUndefined();
		expect(toolCall.arguments).toEqual({ path: "/a" });
	});

	it("handles multiple concurrent tool calls with independent partialJson", async () => {
		const events: ProxyAssistantMessageEvent[] = [
			{ type: "start" },
			{ type: "toolcall_start", contentIndex: 0, id: "call_1", toolName: "read" },
			{ type: "toolcall_delta", contentIndex: 0, delta: '{"path":"' },
			{ type: "toolcall_start", contentIndex: 1, id: "call_2", toolName: "bash" },
			{ type: "toolcall_delta", contentIndex: 1, delta: '{"command":"' },
			{ type: "toolcall_delta", contentIndex: 0, delta: 'a"}' },
			{ type: "toolcall_delta", contentIndex: 1, delta: 'ls"}' },
			{ type: "toolcall_end", contentIndex: 0 },
			{ type: "toolcall_end", contentIndex: 1 },
			{
				type: "done",
				reason: "toolUse",
				usage: { ...baseUsage },
				content: [
					{ type: "toolCall", id: "call_1", name: "read", arguments: { path: "a" } },
					{ type: "toolCall", id: "call_2", name: "bash", arguments: { command: "ls" } },
				],
			},
		];
		const body = buildSseBody(events);
		const fetchMock: FetchImpl = () => Promise.resolve(new Response(body, { status: 200 }));

		const stream = streamProxy(mockModel, mockContext, {
			proxyUrl: "http://localhost:0",
			authToken: "test",
			fetch: fetchMock,
		});

		await collectEvents(stream);
		const result = await stream.result();
		const toolCalls = result.content.filter((c): c is ToolCall => c.type === "toolCall");
		expect(toolCalls.length).toBe(2);
		expect(toolCalls[0].arguments).toEqual({ path: "a" });
		expect(toolCalls[1].arguments).toEqual({ command: "ls" });
		for (const tc of toolCalls) {
			expect(getStreamingPartialJson(tc)).toBeUndefined();
		}
	});
});
