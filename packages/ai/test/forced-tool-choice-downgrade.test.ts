import { describe, expect, it } from "bun:test";
import { streamAnthropic } from "@oh-my-pi/pi-ai/providers/anthropic";
import { streamOpenAICompletions } from "@oh-my-pi/pi-ai/providers/openai-completions";
import { streamOpenAIResponses } from "@oh-my-pi/pi-ai/providers/openai-responses";
import type { Context, FetchImpl, ModelSpec, Tool } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

function sseFrame(event: string, data: unknown): string {
	return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function makeAnthropicSuccessStream(): string {
	return [
		sseFrame("message_start", {
			type: "message_start",
			message: { id: "msg_test", usage: { input_tokens: 10, output_tokens: 0 } },
		}),
		sseFrame("content_block_start", {
			type: "content_block_start",
			index: 0,
			content_block: { type: "text", text: "" },
		}),
		sseFrame("content_block_delta", {
			type: "content_block_delta",
			index: 0,
			delta: { type: "text_delta", text: "done" },
		}),
		sseFrame("content_block_stop", { type: "content_block_stop", index: 0 }),
		sseFrame("message_delta", {
			type: "message_delta",
			delta: { stop_reason: "end_turn" },
			usage: { input_tokens: 10, output_tokens: 5 },
		}),
		sseFrame("message_stop", { type: "message_stop" }),
	].join("");
}

function makeCompletionsSuccessStream(): string {
	const events = [
		{ id: "c", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: "ok" } }] },
		{ id: "c", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
		"[DONE]",
	];
	return `${events.map(e => `data: ${typeof e === "string" ? e : JSON.stringify(e)}`).join("\n\n")}\n\n`;
}

function makeResponsesSuccessStream(): string {
	const events = [
		{ type: "response.created", response: { id: "resp_1", status: "in_progress" } },
		{
			type: "response.output_item.added",
			output_index: 0,
			item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] },
		},
		{ type: "response.output_text.delta", output_index: 0, item_id: "msg_1", delta: "done" },
		{
			type: "response.output_item.done",
			output_index: 0,
			item: {
				type: "message",
				id: "msg_1",
				role: "assistant",
				status: "completed",
				content: [{ type: "output_text", text: "done" }],
			},
		},
		{ type: "response.completed", response: { id: "resp_1", status: "completed" } },
	];
	return `${events.map(e => `data: ${JSON.stringify(e)}`).join("\n\n")}\n\n`;
}

const testTool: Tool = {
	name: "test_tool",
	description: "A test tool",
	parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
};

const context: Context = {
	systemPrompt: ["You are a test assistant."],
	messages: [{ role: "user", content: "Use the tool", timestamp: Date.now() }],
	tools: [testTool],
};

describe("forced tool_choice runtime self-healing downgrade", () => {
	it("Anthropic: retries on 400 opus-5-5 rejection and downgrades subsequent first request", async () => {
		const spec: ModelSpec<"anthropic-messages"> = {
			id: "claude-new-opus",
			name: "Claude New Opus",
			api: "anthropic-messages",
			provider: "anthropic",
			baseUrl: "https://api.anthropic.com",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 100_000,
			maxTokens: 4_096,
			compat: {
				supportsForcedToolChoice: true,
			},
		};
		const model = buildModel(spec);
		expect(model.compat.supportsForcedToolChoice).toBe(true);

		const sentBodies: Record<string, unknown>[] = [];
		const mockFetch: FetchImpl = async (_input, init) => {
			const body = JSON.parse(init?.body as string) as Record<string, unknown>;
			sentBodies.push(body);
			const toolChoice = body.tool_choice as { type?: string } | undefined;
			if (toolChoice?.type === "tool" || toolChoice?.type === "any") {
				return new Response(
					JSON.stringify({
						type: "error",
						error: {
							type: "invalid_request_error",
							message: 'tool_choice: type "tool" and "any" are not supported for this model',
						},
					}),
					{
						status: 400,
						headers: { "Content-Type": "application/json" },
					},
				);
			}
			return new Response(makeAnthropicSuccessStream(), {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			});
		};

		// First call: initial request has forced tool_choice, gets 400, retries with auto and succeeds
		const result1 = await streamAnthropic(model, context, {
			apiKey: "test-key",
			fetch: mockFetch,
			toolChoice: { type: "tool", name: "test_tool" },
		}).result();

		expect(result1.stopReason).toBe("stop");
		expect(sentBodies.length).toBe(2);
		expect(sentBodies[0]?.tool_choice).toEqual({ type: "tool", name: "test_tool" });
		expect(sentBodies[1]?.tool_choice).toEqual({ type: "auto" });

		// Subsequent call on the same model sends downgraded choice on its FIRST request
		sentBodies.length = 0;
		const result2 = await streamAnthropic(model, context, {
			apiKey: "test-key",
			fetch: mockFetch,
			toolChoice: { type: "tool", name: "test_tool" },
		}).result();

		expect(result2.stopReason).toBe("stop");
		expect(sentBodies.length).toBe(1);
		expect(sentBodies[0]?.tool_choice).toEqual({ type: "auto" });
	});

	it("OpenAI completions: retries on 400 only auto rejection and downgrades subsequent first request", async () => {
		const spec: ModelSpec<"openai-completions"> = {
			id: "gpt-new-compat",
			name: "GPT New Compat",
			api: "openai-completions",
			provider: "openai-compat-test",
			baseUrl: "https://compat.example.com/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 100_000,
			maxTokens: 4_096,
			compat: {
				supportsForcedToolChoice: true,
			},
		};
		const model = buildModel(spec);
		expect(model.compat.supportsForcedToolChoice).toBe(true);

		const sentBodies: Record<string, unknown>[] = [];
		const mockFetch: FetchImpl = async (_input, init) => {
			const body = JSON.parse(init?.body as string) as Record<string, unknown>;
			sentBodies.push(body);
			const toolChoice = body.tool_choice;
			if (toolChoice !== "auto" && toolChoice !== "none" && toolChoice !== undefined) {
				return new Response(
					JSON.stringify({
						error: {
							message: 'only "auto" is supported for tool_choice',
							type: "invalid_request_error",
						},
					}),
					{
						status: 400,
						headers: { "Content-Type": "application/json" },
					},
				);
			}
			return new Response(makeCompletionsSuccessStream(), {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			});
		};

		// First call: initial request has forced tool_choice, gets 400, retries with auto and succeeds
		const result1 = await streamOpenAICompletions(model, context, {
			apiKey: "test-key",
			fetch: mockFetch,
			toolChoice: { type: "tool", name: "test_tool" },
		}).result();

		expect(result1.stopReason).toBe("stop");
		expect(sentBodies.length).toBe(2);
		expect(sentBodies[0]?.tool_choice).toEqual({
			type: "function",
			function: { name: "test_tool" },
		});
		expect(sentBodies[1]?.tool_choice).toBe("auto");

		// Subsequent call sends downgraded choice on first request
		sentBodies.length = 0;
		const result2 = await streamOpenAICompletions(model, context, {
			apiKey: "test-key",
			fetch: mockFetch,
			toolChoice: { type: "tool", name: "test_tool" },
		}).result();

		expect(result2.stopReason).toBe("stop");
		expect(sentBodies.length).toBe(1);
		expect(sentBodies[0]?.tool_choice).toBe("auto");
	});

	it("OpenAI responses: retries on 400 only auto rejection and downgrades subsequent first request", async () => {
		const spec: ModelSpec<"openai-responses"> = {
			id: "gpt-new-responses-compat",
			name: "GPT New Responses Compat",
			api: "openai-responses",
			provider: "custom-responses-test",
			baseUrl: "https://responses.example.com/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 100_000,
			maxTokens: 4_096,
			compat: {
				supportsToolChoice: true,
				supportsForcedToolChoice: true,
			},
		};
		const model = buildModel(spec);
		expect(model.compat.supportsForcedToolChoice).toBe(true);

		const sentBodies: Record<string, unknown>[] = [];
		const mockFetch: FetchImpl = async (_input, init) => {
			const body = JSON.parse(init?.body as string) as Record<string, unknown>;
			sentBodies.push(body);
			const toolChoice = body.tool_choice;
			if (toolChoice !== "auto" && toolChoice !== "none" && toolChoice !== undefined) {
				return new Response(
					JSON.stringify({
						error: {
							message: 'only "auto" is supported for tool_choice',
							type: "invalid_request_error",
						},
					}),
					{
						status: 400,
						headers: { "Content-Type": "application/json" },
					},
				);
			}
			return new Response(makeResponsesSuccessStream(), {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			});
		};

		// First call: initial request has forced tool_choice, gets 400, retries with auto and succeeds
		const result1 = await streamOpenAIResponses(model, context, {
			apiKey: "test-key",
			fetch: mockFetch,
			toolChoice: { type: "tool", name: "test_tool" },
		}).result();

		expect(result1.stopReason).toBe("stop");
		expect(sentBodies.length).toBe(2);
		expect(sentBodies[0]?.tool_choice).toEqual({
			type: "function",
			name: "test_tool",
		});
		expect(sentBodies[1]?.tool_choice).toBe("auto");

		// Subsequent call sends downgraded choice on first request
		sentBodies.length = 0;
		const result2 = await streamOpenAIResponses(model, context, {
			apiKey: "test-key",
			fetch: mockFetch,
			toolChoice: { type: "tool", name: "test_tool" },
		}).result();

		expect(result2.stopReason).toBe("stop");
		expect(sentBodies.length).toBe(1);
		expect(sentBodies[0]?.tool_choice).toBe("auto");
	});

	it("surfaces non-matching 400 unchanged with no retry", async () => {
		const spec: ModelSpec<"anthropic-messages"> = {
			id: "claude-non-matching-test",
			name: "Claude Non Matching",
			api: "anthropic-messages",
			provider: "anthropic",
			baseUrl: "https://api.anthropic.com",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 100_000,
			maxTokens: 4_096,
			compat: {
				supportsForcedToolChoice: true,
			},
		};
		const model = buildModel(spec);

		let fetchCount = 0;
		const mockFetch: FetchImpl = async () => {
			fetchCount++;
			return new Response(
				JSON.stringify({
					type: "error",
					error: {
						type: "invalid_request_error",
						message: "Invalid parameter: max_tokens must be positive",
					},
				}),
				{
					status: 400,
					headers: { "Content-Type": "application/json" },
				},
			);
		};

		const result = await streamAnthropic(model, context, {
			apiKey: "test-key",
			fetch: mockFetch,
			toolChoice: { type: "tool", name: "test_tool" },
		}).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("Invalid parameter: max_tokens must be positive");
		expect(fetchCount).toBe(1);
	});
});
