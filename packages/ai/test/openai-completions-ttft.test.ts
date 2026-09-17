// Regression: openai-completions only stamped firstTokenTime inside the
// text and thinking delta handlers, so a response whose first content delta
// is a structured `tool_calls` entry (the common agentic shape on
// OpenAI-compatible gateways) produced assistant messages with `ttft`
// undefined. Consumers of `usage-row` then silently drop the TTFT figure and
// the tok/s figure is computed over an unknown window for every turn that
// ends in toolUse.
import { describe, expect, it } from "bun:test";
import { streamOpenAICompletions } from "@oh-my-pi/pi-ai/providers/openai-completions";
import type { Context, FetchImpl, Model } from "@oh-my-pi/pi-ai/types";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";

const completionsModel = {
	...(getBundledModel("openai", "gpt-4o-mini") as Model<"openai-completions">),
	api: "openai-completions",
} satisfies Model<"openai-completions">;

function baseContext(): Context {
	return {
		messages: [{ role: "user", content: "List files", timestamp: Date.now() }],
	};
}

/** SSE body whose first content delta is a structured tool call, no text. */
function createToolCallSseFetch(): FetchImpl {
	async function mockFetch(_input: string | URL | Request, _init?: RequestInit): Promise<Response> {
		const encoder = new TextEncoder();
		const chunk = (extra: Record<string, unknown>) =>
			`data: ${JSON.stringify({ id: "chatcmpl-ttft", object: "chat.completion.chunk", created: 0, model: completionsModel.id, ...extra })}\n\n`;
		const sse =
			chunk({
				choices: [
					{
						index: 0,
						delta: {
							role: "assistant",
							tool_calls: [
								{
									index: 0,
									id: "call_ttft_1",
									type: "function",
									function: { name: "list_dir", arguments: '{"path":"' },
								},
							],
						},
					},
				],
			}) +
			chunk({
				choices: [
					{
						index: 0,
						delta: { tool_calls: [{ index: 0, function: { arguments: "." } }] },
					},
				],
			}) +
			chunk({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }) +
			'data: {"id":"chatcmpl-ttft","object":"chat.completion.chunk","created":0,"model":"gpt-4o-mini","choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}\n\n' +
			"data: [DONE]\n\n";
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(encoder.encode(sse));
				controller.close();
			},
		});
		return new Response(stream, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});
	}
	return mockFetch as typeof fetch;
}

/** SSE body with no content at all (length finish, Ollama-style). */
function createNoContentSseFetch(): FetchImpl {
	async function mockFetch(_input: string | URL | Request, _init?: RequestInit): Promise<Response> {
		const encoder = new TextEncoder();
		const sse =
			'data: {"id":"chatcmpl-empty","object":"chat.completion.chunk","created":0,"model":"gpt-4o-mini","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}\n\n' +
			'data: {"id":"chatcmpl-empty","object":"chat.completion.chunk","created":0,"model":"gpt-4o-mini","choices":[{"index":0,"delta":{},"finish_reason":"length"}]}\n\n' +
			"data: [DONE]\n\n";
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(encoder.encode(sse));
				controller.close();
			},
		});
		return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
	}
	return mockFetch as typeof fetch;
}

describe("openai-completions ttft stamping", () => {
	it("stamps ttft on a pure tool-call stream (no text deltas)", async () => {
		const result = await streamOpenAICompletions(completionsModel, baseContext(), {
			apiKey: "test-key",
			fetch: createToolCallSseFetch(),
		}).result();

		expect(result.stopReason).toBe("toolUse");
		expect(result.content.some(block => block.type === "toolCall")).toBe(true);
		expect(result.ttft).toBeDefined();
		expect(result.ttft).toBeGreaterThanOrEqual(0);
		// TTFT must not exceed the total duration.
		expect(result.duration).toBeDefined();
		expect(result.ttft).toBeLessThanOrEqual(result.duration ?? Number.POSITIVE_INFINITY);
	}, 10_000);

	it("leaves ttft undefined when the stream carries no content at all", async () => {
		const result = await streamOpenAICompletions(completionsModel, baseContext(), {
			apiKey: "test-key",
			fetch: createNoContentSseFetch(),
		}).result();

		// No first byte ever arrived; TTFT is unknown, not zero.
		expect(result.ttft).toBeUndefined();
	}, 10_000);
});
