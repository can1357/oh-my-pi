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

/** A proxy concurrency-admission 429: the transport surfaces it at once, so the stated wait reaches the provider retry. */
function concurrencyRejection(retryAfter: string): Response {
	return new Response(
		JSON.stringify({
			error: {
				message: "Max parallel request limit reached",
				type: "rate_limit_error",
				rate_limit_type: "max_parallel_requests",
			},
		}),
		{
			status: 429,
			headers: {
				"content-type": "application/json",
				"retry-after": retryAfter,
				rate_limit_type: "max_parallel_requests",
			},
		},
	);
}

describe("OpenAI-family provider-error retry honors the server-stated wait", () => {
	it("surfaces an OpenAI Completions 429 whose Retry-After exceeds maxRetryDelayMs after one request", async () => {
		let requests = 0;
		const fetchMock: FetchImpl = vi.fn(async () => {
			requests++;
			return requests === 1 ? concurrencyRejection("9") : completedCompletionsSse("must not be requested");
		});
		const providerRetryWait = vi.fn(async (_delayMs: number, _signal?: AbortSignal) => {});

		const result = await streamOpenAICompletions(completionsModel, context, {
			apiKey: "test-key",
			fetch: fetchMock,
			maxRetryDelayMs: 1,
			providerRetryWait,
		}).result();

		expect(requests).toBe(1);
		expect(providerRetryWait).not.toHaveBeenCalled();
		expect(result.stopReason).toBe("error");
		expect(result.errorStatus).toBe(429);
		expect(result.errorRetryAfterMs).toBe(9_000);
	});

	it("retries an OpenAI Completions 429 after its Retry-After when the wait fits maxRetryDelayMs", async () => {
		let requests = 0;
		const fetchMock: FetchImpl = vi.fn(async () => {
			requests++;
			return requests === 1 ? concurrencyRejection("0.8") : completedCompletionsSse("completions recovered");
		});
		const providerRetryWait = vi.fn(async (_delayMs: number, _signal?: AbortSignal) => {});

		const result = await streamOpenAICompletions(completionsModel, context, {
			apiKey: "test-key",
			fetch: fetchMock,
			maxRetryDelayMs: 1_000,
			providerRetryWait,
		}).result();

		expect(requests).toBe(2);
		expect(providerRetryWait).toHaveBeenCalledTimes(1);
		expect(providerRetryWait.mock.calls[0]?.[0]).toBe(800);
		expect(result.stopReason).toBe("stop");
		expect(result.content.find(block => block.type === "text")?.text).toBe("completions recovered");
	});

	it("surfaces an Azure Responses 429 whose Retry-After exceeds maxRetryDelayMs after one request", async () => {
		let requests = 0;
		const fetchMock: FetchImpl = vi.fn(async () => {
			requests++;
			return requests === 1 ? concurrencyRejection("9") : completedResponsesSse("must not be requested");
		});
		const providerRetryWait = vi.fn(async (_delayMs: number, _signal?: AbortSignal) => {});

		const result = await streamAzureOpenAIResponses(azureModel, context, {
			apiKey: "test-key",
			azureBaseUrl: azureModel.baseUrl,
			azureApiVersion: "v1",
			fetch: fetchMock,
			maxRetryDelayMs: 1,
			providerRetryWait,
		}).result();

		expect(requests).toBe(1);
		expect(providerRetryWait).not.toHaveBeenCalled();
		expect(result.stopReason).toBe("error");
		expect(result.errorStatus).toBe(429);
		expect(result.errorRetryAfterMs).toBe(9_000);
	});

	it("retries an Azure Responses 429 after its Retry-After when the wait fits maxRetryDelayMs", async () => {
		let requests = 0;
		const fetchMock: FetchImpl = vi.fn(async () => {
			requests++;
			return requests === 1 ? concurrencyRejection("0.8") : completedResponsesSse("azure recovered");
		});
		const providerRetryWait = vi.fn(async (_delayMs: number, _signal?: AbortSignal) => {});

		const result = await streamAzureOpenAIResponses(azureModel, context, {
			apiKey: "test-key",
			azureBaseUrl: azureModel.baseUrl,
			azureApiVersion: "v1",
			fetch: fetchMock,
			maxRetryDelayMs: 1_000,
			providerRetryWait,
		}).result();

		expect(requests).toBe(2);
		expect(providerRetryWait).toHaveBeenCalledTimes(1);
		expect(providerRetryWait.mock.calls[0]?.[0]).toBe(800);
		expect(result.stopReason).toBe("stop");
		expect(result.content.find(block => block.type === "text")?.text).toBe("azure recovered");
	});
});

/** An ordinary rate-limit 429, which the transport's own retry loop handles. */
function rateLimitRejection(retryAfter: string): Response {
	return new Response(
		JSON.stringify({
			error: { type: "rate_limit_error", code: "rate_limit_exceeded", message: "Too many requests" },
		}),
		{ status: 429, headers: { "content-type": "application/json", "retry-after": retryAfter } },
	);
}

interface TransportRetryOptions {
	fetch: FetchImpl;
	maxRetryDelayMs: number;
	providerRetryWait?: (delayMs: number, signal?: AbortSignal) => Promise<void>;
	providerRetryWaitCeilingMs?: number;
}

/** The routes whose transport retries a refusal: three through `postOpenAIStream`, and Codex SSE. */
const transportRoutes = [
	{
		name: "OpenAI Completions",
		success: () => completedCompletionsSse("recovered"),
		run: (options: TransportRetryOptions) =>
			streamOpenAICompletions(completionsModel, context, { apiKey: "test-key", ...options }),
	},
	{
		name: "Azure OpenAI Responses",
		success: () => completedResponsesSse("recovered"),
		run: (options: TransportRetryOptions) =>
			streamAzureOpenAIResponses(azureModel, context, {
				apiKey: "test-key",
				azureBaseUrl: azureModel.baseUrl,
				azureApiVersion: "v1",
				...options,
			}),
	},
	{
		name: "OpenAI Responses",
		success: () => completedResponsesSse("recovered"),
		run: (options: TransportRetryOptions) =>
			streamOpenAIResponses(responsesModel, context, { apiKey: "test-key", ...options }),
	},
	{
		name: "Codex SSE",
		success: () => completedCodexSse("recovered"),
		run: (options: TransportRetryOptions) =>
			streamOpenAICodexResponses(codexModel, context, { apiKey: "test-key", ...options }),
	},
];

describe("OpenAI-family transport retries of an ordinary 429 keep to the caller's cap and wait through providerRetryWait", () => {
	for (const route of transportRoutes) {
		it(`${route.name}: a 429 whose 50 ms Retry-After exceeds a 10 ms cap ends after one request`, async () => {
			let requests = 0;
			const fetchMock: FetchImpl = vi.fn(async () => {
				requests++;
				return requests === 1 ? rateLimitRejection("0.05") : route.success();
			});
			const providerRetryWait = vi.fn(async (_delayMs: number, _signal?: AbortSignal) => {});

			const result = await route.run({ fetch: fetchMock, maxRetryDelayMs: 10, providerRetryWait }).result();

			expect(requests).toBe(1);
			expect(providerRetryWait).not.toHaveBeenCalled();
			expect(result.stopReason).toBe("error");
			expect(result.errorStatus).toBe(429);
			expect(result.errorRetryAfterMs).toBe(50);
		});

		it(`${route.name}: a 429 whose 50 ms Retry-After fits a 1000 ms cap is retried after providerRetryWait`, async () => {
			let requests = 0;
			const fetchMock: FetchImpl = vi.fn(async () => {
				requests++;
				return requests === 1 ? rateLimitRejection("0.05") : route.success();
			});
			const providerRetryWait = vi.fn(async (_delayMs: number, _signal?: AbortSignal) => {});

			const result = await route.run({ fetch: fetchMock, maxRetryDelayMs: 1_000, providerRetryWait }).result();

			expect(requests).toBe(2);
			expect(providerRetryWait).toHaveBeenCalledTimes(1);
			expect(providerRetryWait.mock.calls[0]?.[0]).toBeGreaterThanOrEqual(50);
			expect(result.stopReason).toBe("stop");
			expect(result.content.find(block => block.type === "text")?.text).toBe("recovered");
		});
	}
});

describe("OpenAI-family transport retries and the providerRetryWaitCeilingMs opt-in", () => {
	const FIVE_MINUTES_MS = 5 * 60 * 1_000;
	const REFUSAL_NOTE =
		"(server asked to wait 15 s before retrying; the caller's 10 s providerRetryWaitCeilingMs refused it, so the provider did not retry)";

	for (const route of transportRoutes) {
		/** A 429 stating 15 s under a 5-minute cap, then a success. */
		const run = async (ceilingMs: number | undefined) => {
			let requests = 0;
			const fetchMock: FetchImpl = vi.fn(async () => {
				requests++;
				return requests === 1 ? rateLimitRejection("15") : route.success();
			});
			const providerRetryWait = vi.fn(async (_delayMs: number, _signal?: AbortSignal) => {});
			const result = await route
				.run({
					fetch: fetchMock,
					maxRetryDelayMs: FIVE_MINUTES_MS,
					providerRetryWaitCeilingMs: ceilingMs,
					providerRetryWait,
				})
				.result();
			return { requests, providerRetryWait, result };
		};

		it(`${route.name}: unset, a 429 stating 15 s is retried after sleeping it, as before`, async () => {
			const { requests, providerRetryWait, result } = await run(undefined);

			expect(requests).toBe(2);
			expect(providerRetryWait.mock.calls.map(call => call[0])).toEqual([15_000]);
			expect(result.stopReason).toBe("stop");
		});

		it(`${route.name}: set to 20 s and not exceeded, a 429 stating 15 s is retried after sleeping it`, async () => {
			const { requests, providerRetryWait } = await run(20_000);

			expect(requests).toBe(2);
			expect(providerRetryWait.mock.calls.map(call => call[0])).toEqual([15_000]);
		});

		it(`${route.name}: set to 10 s and exceeded, a 429 stating 15 s surfaces after one request, saying so, with its wait and classification kept`, async () => {
			const { requests, providerRetryWait, result } = await run(10_000);

			expect(requests).toBe(1);
			expect(providerRetryWait).not.toHaveBeenCalled();
			expect(result.stopReason).toBe("error");
			expect(result.errorStatus).toBe(429);
			expect(result.errorRetryAfterMs).toBe(15_000);
			expect(result.errorClassificationMessage).toBeDefined();
			expect(result.errorClassificationMessage).not.toContain("server asked");
			expect(result.errorMessage).toBe(`${result.errorClassificationMessage} ${REFUSAL_NOTE}`);
		});

		it.each([
			[
				"its body alone says Please retry in 15s",
				() =>
					new Response(
						JSON.stringify({
							error: { type: "rate_limit_error", code: "rate_limit_exceeded", message: "Please retry in 15s" },
						}),
						{ status: 429, headers: { "content-type": "application/json" } },
					),
				15_000,
			],
			[
				"its x-ratelimit-reset-after says 90 s",
				() =>
					new Response(
						JSON.stringify({
							error: { type: "rate_limit_error", code: "rate_limit_exceeded", message: "Too many requests" },
						}),
						{ status: 429, headers: { "content-type": "application/json", "x-ratelimit-reset-after": "90" } },
					),
				90_000,
			],
		] as [string, () => Response, number][])(
			`${route.name}: set to 10 s, a 429 whose %s is not slept, the transport's own sleep included`,
			async (_label, refusal, statedMs) => {
				// The transport read these waits from places the refusal check did
				// not: it slept 15 s and 90 s under a 10 s ceiling, with no countdown.
				let requests = 0;
				const fetchMock: FetchImpl = vi.fn(async () => {
					requests++;
					return requests === 1 ? refusal() : route.success();
				});
				const providerRetryWait = vi.fn(async (_delayMs: number, _signal?: AbortSignal) => {});

				const result = await route
					.run({
						fetch: fetchMock,
						maxRetryDelayMs: FIVE_MINUTES_MS,
						providerRetryWaitCeilingMs: 10_000,
						providerRetryWait,
					})
					.result();

				expect(requests).toBe(1);
				expect(providerRetryWait).not.toHaveBeenCalled();
				expect(result.stopReason).toBe("error");
				expect(result.errorStatus).toBe(429);
				expect(result.errorMessage).toContain(`server asked to wait ${statedMs / 1_000} s`);
				expect(result.errorMessage?.endsWith("so the provider did not retry)")).toBe(true);
			},
		);
	}
});
