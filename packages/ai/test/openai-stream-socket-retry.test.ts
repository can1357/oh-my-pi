import { afterEach, describe, expect, it, vi } from "bun:test";
import { scheduler } from "node:timers/promises";
import { streamAzureOpenAIResponses } from "@oh-my-pi/pi-ai/providers/azure-openai-responses";
import { streamOpenAICodexResponses } from "@oh-my-pi/pi-ai/providers/openai-codex-responses";
import { streamOpenAICompletions } from "@oh-my-pi/pi-ai/providers/openai-completions";
import { streamOpenAIResponses } from "@oh-my-pi/pi-ai/providers/openai-responses";
import type { Context, FetchImpl, Model, ModelSpec } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

const SOCKET_CLOSE_MESSAGE =
	"The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()";
const context: Context = {
	messages: [{ role: "user", content: "Say hello", timestamp: 1_000 }],
};

const modelDefaults: Pick<ModelSpec, "id" | "name" | "reasoning" | "input" | "cost" | "contextWindow" | "maxTokens"> = {
	id: "gpt-test",
	name: "GPT test",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128_000,
	maxTokens: 16_384,
};

const completionsModel: Model<"openai-completions"> = buildModel({
	...modelDefaults,
	api: "openai-completions",
	provider: "openai",
	baseUrl: "https://api.openai.test/v1",
});

const responsesModel: Model<"openai-responses"> = buildModel({
	...modelDefaults,
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://api.openai.test/v1",
});

const azureModel: Model<"azure-openai-responses"> = buildModel({
	...modelDefaults,
	api: "azure-openai-responses",
	provider: "azure",
	baseUrl: "https://example.openai.azure.com/openai/v1",
});

const codexModel: Model<"openai-codex-responses"> = buildModel({
	...modelDefaults,
	api: "openai-codex-responses",
	provider: "openai-codex",
	baseUrl: "https://chatgpt.com/backend-api",
	preferWebsockets: false,
});

function createSseResponse(events: unknown[], done = false): Response {
	const frames = events.map(event => `data: ${JSON.stringify(event)}`);
	if (done) frames.push("data: [DONE]");
	return new Response(`${frames.join("\n\n")}\n\n`, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

function createSocketCloseResponse(events: unknown[]): Response {
	const bytes = new TextEncoder().encode(`${events.map(event => `data: ${JSON.stringify(event)}`).join("\n\n")}\n\n`);
	let sentPrefix = false;
	return new Response(
		new ReadableStream<Uint8Array>(
			{
				pull(controller) {
					if (!sentPrefix) {
						sentPrefix = true;
						controller.enqueue(bytes);
						return;
					}
					controller.error(new TypeError(SOCKET_CLOSE_MESSAGE));
				},
			},
			{ highWaterMark: 0 },
		),
		{ status: 200, headers: { "content-type": "text/event-stream" } },
	);
}

function completedResponsesSse(text: string): Response {
	return createSseResponse([
		{ type: "response.created", response: { id: "resp_recovered", status: "in_progress" } },
		{
			type: "response.output_item.added",
			output_index: 0,
			item: { type: "message", id: "msg_recovered", role: "assistant", status: "in_progress", content: [] },
		},
		{ type: "response.output_text.delta", output_index: 0, item_id: "msg_recovered", delta: text },
		{
			type: "response.output_item.done",
			output_index: 0,
			item: {
				type: "message",
				id: "msg_recovered",
				role: "assistant",
				status: "completed",
				content: [{ type: "output_text", text }],
			},
		},
		{
			type: "response.completed",
			response: {
				id: "resp_recovered",
				status: "completed",
				usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7, input_tokens_details: { cached_tokens: 0 } },
			},
		},
	]);
}

function completedCompletionsSse(text: string): Response {
	return createSseResponse(
		[
			{ id: "chatcmpl_recovered", choices: [{ index: 0, delta: { content: text }, finish_reason: null }] },
			{
				id: "chatcmpl_recovered",
				choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
				usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
			},
		],
		true,
	);
}

function completedCodexSse(text: string): Response {
	return createSseResponse([
		{
			type: "response.output_item.added",
			item: { type: "message", id: "msg_recovered", role: "assistant", status: "in_progress", content: [] },
		},
		{ type: "response.content_part.added", part: { type: "output_text", text: "" } },
		{ type: "response.output_text.delta", delta: text },
		{
			type: "response.output_item.done",
			item: {
				type: "message",
				id: "msg_recovered",
				role: "assistant",
				status: "completed",
				content: [{ type: "output_text", text }],
			},
		},
		{
			type: "response.completed",
			response: {
				status: "completed",
				usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7, input_tokens_details: { cached_tokens: 0 } },
			},
		},
	]);
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("OpenAI-family mid-stream socket-close retry", () => {
	it("retries OpenAI Responses before replay-unsafe output", async () => {
		let requests = 0;
		const fetchMock: FetchImpl = vi.fn(async () => {
			requests++;
			return requests === 1
				? createSocketCloseResponse([
						{ type: "response.created", response: { id: "resp_failed", status: "in_progress" } },
					])
				: completedResponsesSse("responses recovered");
		});

		const result = await streamOpenAIResponses(responsesModel, context, {
			apiKey: "test-key",
			fetch: fetchMock,
			providerRetryWait: async () => {},
		}).result();

		expect(requests).toBe(2);
		expect(result.stopReason).toBe("stop");
		expect(result.content.find(block => block.type === "text")?.text).toBe("responses recovered");
	});

	it("retries OpenAI Completions before replay-unsafe output", async () => {
		let requests = 0;
		const fetchMock: FetchImpl = vi.fn(async () => {
			requests++;
			return requests === 1
				? createSocketCloseResponse([
						{ id: "chatcmpl_failed", choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] },
					])
				: completedCompletionsSse("completions recovered");
		});

		const result = await streamOpenAICompletions(completionsModel, context, {
			apiKey: "test-key",
			fetch: fetchMock,
			providerRetryWait: async () => {},
		}).result();

		expect(requests).toBe(2);
		expect(result.stopReason).toBe("stop");
		expect(result.content.find(block => block.type === "text")?.text).toBe("completions recovered");
	});

	it("retries Azure OpenAI Responses before replay-unsafe output", async () => {
		let requests = 0;
		const fetchMock: FetchImpl = vi.fn(async () => {
			requests++;
			return requests === 1
				? createSocketCloseResponse([
						{ type: "response.created", response: { id: "resp_failed", status: "in_progress" } },
					])
				: completedResponsesSse("azure recovered");
		});

		const result = await streamAzureOpenAIResponses(azureModel, context, {
			apiKey: "test-key",
			azureBaseUrl: azureModel.baseUrl,
			azureApiVersion: "v1",
			fetch: fetchMock,
			providerRetryWait: async () => {},
		}).result();

		expect(requests).toBe(2);
		expect(result.stopReason).toBe("stop");
		expect(result.content.find(block => block.type === "text")?.text).toBe("azure recovered");
	});

	it("retries Codex SSE before replay-unsafe output", async () => {
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		let requests = 0;
		const fetchMock: FetchImpl = vi.fn(async () => {
			requests++;
			return requests === 1
				? createSocketCloseResponse([
						{ type: "response.created", response: { id: "resp_failed", status: "in_progress" } },
					])
				: completedCodexSse("codex recovered");
		});

		const result = await streamOpenAICodexResponses(codexModel, context, {
			apiKey: "test-key",
			fetch: fetchMock,
		}).result();

		expect(requests).toBe(2);
		expect(result.stopReason).toBe("stop");
		expect(result.content.find(block => block.type === "text")?.text).toBe("codex recovered");
	});

	it("retries Codex SSE when a socket close follows an empty opened block", async () => {
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		let requests = 0;
		const fetchMock: FetchImpl = vi.fn(async () => {
			requests++;
			// First attempt opens a message block (emits text_start) but closes the
			// socket before any output_text delta — replay-safe, must retry.
			return requests === 1
				? createSocketCloseResponse([
						{
							type: "response.output_item.added",
							item: { type: "message", id: "msg_empty", role: "assistant", status: "in_progress", content: [] },
						},
						{ type: "response.content_part.added", part: { type: "output_text", text: "" } },
					])
				: completedCodexSse("codex recovered after empty block");
		});

		const events: string[] = [];
		const stream = streamOpenAICodexResponses(codexModel, context, {
			apiKey: "test-key",
			fetch: fetchMock,
		});
		for await (const event of stream) events.push(event.type);
		const result = await stream.result();

		expect(requests).toBe(2);
		expect(result.stopReason).toBe("stop");
		expect(result.content.find(block => block.type === "text")?.text).toBe("codex recovered after empty block");
		// The abandoned attempt's text_start is balanced by a text_end before the
		// replay: no orphaned block-start reaches the consumer.
		expect(events.filter(type => type === "text_start")).toHaveLength(
			events.filter(type => type === "text_end").length,
		);
	});

	it("does not retry Codex SSE after text output commits", async () => {
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		let requests = 0;
		const fetchMock: FetchImpl = vi.fn(async () => {
			requests++;
			return createSocketCloseResponse([
				{
					type: "response.output_item.added",
					item: { type: "message", id: "msg_partial", role: "assistant", status: "in_progress", content: [] },
				},
				{ type: "response.content_part.added", part: { type: "output_text", text: "" } },
				{ type: "response.output_text.delta", delta: "partial" },
			]);
		});

		const result = await streamOpenAICodexResponses(codexModel, context, {
			apiKey: "test-key",
			fetch: fetchMock,
		}).result();

		expect(requests).toBe(1);
		expect(result.stopReason).toBe("error");
		expect(result.content.find(block => block.type === "text")?.text).toBe("partial");
	});

	it("does not retry Codex SSE after a whitespace-only text delta commits", async () => {
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		let requests = 0;
		const fetchMock: FetchImpl = vi.fn(async () => {
			requests++;
			// A whitespace-only delta still reached the consumer as text_delta;
			// replaying would duplicate it, so the socket close must surface.
			return createSocketCloseResponse([
				{
					type: "response.output_item.added",
					item: { type: "message", id: "msg_ws", role: "assistant", status: "in_progress", content: [] },
				},
				{ type: "response.content_part.added", part: { type: "output_text", text: "" } },
				{ type: "response.output_text.delta", delta: "  \n" },
			]);
		});

		const result = await streamOpenAICodexResponses(codexModel, context, {
			apiKey: "test-key",
			fetch: fetchMock,
		}).result();

		expect(requests).toBe(1);
		expect(result.stopReason).toBe("error");
		expect(result.content.find(block => block.type === "text")?.text).toBe("  \n");
	});

	it("does not retry Codex SSE after thinking output commits", async () => {
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		let requests = 0;
		const fetchMock: FetchImpl = vi.fn(async () => {
			requests++;
			// A reasoning delta already reached the consumer as thinking_delta;
			// replaying would duplicate it, so the socket close must surface.
			return createSocketCloseResponse([
				{ type: "response.output_item.added", item: { type: "reasoning", id: "rs_partial", summary: [] } },
				{ type: "response.reasoning_text.delta", item_id: "rs_partial", delta: "deliberating" },
			]);
		});

		const result = await streamOpenAICodexResponses(codexModel, context, {
			apiKey: "test-key",
			fetch: fetchMock,
		}).result();

		expect(requests).toBe(1);
		expect(result.stopReason).toBe("error");
		expect(result.content.find(block => block.type === "thinking")?.thinking).toBe("deliberating");
	});
});
