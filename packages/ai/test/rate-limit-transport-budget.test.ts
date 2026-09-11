/**
 * A rate-limited route must not be hammered.
 *
 * A 429 says the route (endpoint + credential) is saturated; re-issuing the
 * same request cannot clear it. Every extra same-route attempt only delays the
 * recovery layers that *can* clear it — credential rotation and model fallback
 * — and, with several subagents running in parallel, multiplies the load that
 * caused the limit. The transport therefore spends at most
 * `MAX_RATE_LIMIT_ATTEMPTS` requests on a 429, and only when the response
 * itself promises a short recovery window; transient 5xx/408 keep their full
 * transport budget.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import { scheduler } from "node:timers/promises";
import { streamAnthropic } from "@oh-my-pi/pi-ai/providers/anthropic";
import { __anthropicApiErrorForTesting } from "@oh-my-pi/pi-ai/error";
import {
	AnthropicApiError,
	AnthropicMessagesClient,
	type AnthropicMessagesClientLike,
} from "@oh-my-pi/pi-ai/providers/anthropic-client";
import { streamOpenAICompletions } from "@oh-my-pi/pi-ai/providers/openai-completions";
import type { Context, FetchImpl, Model, ModelSpec } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { MAX_RATE_LIMIT_ATTEMPTS } from "@oh-my-pi/pi-utils";

const context: Context = { messages: [{ role: "user", content: "Say hello", timestamp: 1_000 }] };

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

const anthropicModel: Model<"anthropic-messages"> = buildModel({
	...modelDefaults,
	id: "claude-test",
	name: "Claude test",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.test",
});

function rateLimited(headers: Record<string, string> = {}, body = '{"error":{"message":"Rate limit reached"}}') {
	return new Response(body, { status: 429, headers: { "content-type": "application/json", ...headers } });
}

function completionsSuccess(text: string): Response {
	const frames = [
		{ id: "chatcmpl_ok", choices: [{ index: 0, delta: { content: text }, finish_reason: null }] },
		{
			id: "chatcmpl_ok",
			choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
			usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
		},
	];
	return new Response(`${frames.map(frame => `data: ${JSON.stringify(frame)}`).join("\n\n")}\n\ndata: [DONE]\n\n`, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

function anthropicSuccess(text: string): Response {
	const events = [
		{
			type: "message_start",
			message: {
				id: "msg_ok",
				usage: {
					input_tokens: 5,
					output_tokens: 0,
					cache_read_input_tokens: 0,
					cache_creation_input_tokens: 0,
				},
			},
		},
		{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
		{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
		{ type: "content_block_stop", index: 0 },
		{
			type: "message_delta",
			delta: { stop_reason: "end_turn" },
			usage: {
				input_tokens: 5,
				output_tokens: 1,
				cache_read_input_tokens: 0,
				cache_creation_input_tokens: 0,
			},
		},
		{ type: "message_stop" },
	];
	return new Response(
		`${events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}`).join("\n\n")}\n\n`,
		{
			status: 200,
			headers: { "content-type": "text/event-stream" },
		},
	);
}

/** Counts transport requests for one full provider call. */
async function countCompletionsRequests(respond: (request: number) => Response): Promise<{
	requests: number;
	stopReason: string;
	errorStatus?: number;
	text?: string;
}> {
	let requests = 0;
	const fetchMock: FetchImpl = async () => {
		requests++;
		return respond(requests);
	};
	const result = await streamOpenAICompletions(completionsModel, context, {
		apiKey: "test-key",
		fetch: fetchMock,
		providerRetryWait: async () => {},
	}).result();
	return {
		requests,
		stopReason: result.stopReason,
		errorStatus: result.errorStatus,
		text: result.content.find(block => block.type === "text")?.text,
	};
}
afterEach(() => {
	vi.restoreAllMocks();
	__anthropicApiErrorForTesting.setBodyReadTimeoutMs(undefined);
});

describe("transport rate-limit budget", () => {
	it("spends one request on a persistent 429 that offers no recovery signal", async () => {
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const outcome = await countCompletionsRequests(() => rateLimited());
		expect(outcome.requests).toBe(1);
		expect(outcome.stopReason).toBe("error");
		expect(outcome.errorStatus).toBe(429);
	});

	it("spends at most MAX_RATE_LIMIT_ATTEMPTS requests on a persistent 429 with a short retry hint", async () => {
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const outcome = await countCompletionsRequests(() => rateLimited({ "retry-after-ms": "20" }));
		expect(MAX_RATE_LIMIT_ATTEMPTS).toBe(2);
		expect(outcome.requests).toBe(MAX_RATE_LIMIT_ATTEMPTS);
		expect(outcome.stopReason).toBe("error");
		expect(outcome.errorStatus).toBe(429);
	});

	it("still recovers in-place when a short-hinted 429 clears on the next attempt", async () => {
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const outcome = await countCompletionsRequests(request =>
			request === 1 ? rateLimited({ "retry-after-ms": "20" }) : completionsSuccess("recovered"),
		);
		expect(outcome.requests).toBe(2);
		expect(outcome.stopReason).toBe("stop");
		expect(outcome.text).toBe("recovered");
	});

	it("spends one request on a quota-exhaustion 429 so credential rotation runs immediately", async () => {
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const outcome = await countCompletionsRequests(() =>
			rateLimited({}, '{"error":{"message":"You have hit your usage limit","type":"insufficient_quota"}}'),
		);
		expect(outcome.requests).toBe(1);
		expect(outcome.stopReason).toBe("error");
	});
	it("spends one request on a quota-exhaustion 429 even when it carries a short retry hint", async () => {
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const outcome = await countCompletionsRequests(() =>
			rateLimited(
				{ "retry-after-ms": "1" },
				'{"error":{"message":"You have hit your usage limit","type":"insufficient_quota"}}',
			),
		);
		expect(outcome.requests).toBe(1);
		expect(outcome.stopReason).toBe("error");
	});

	it("spends one request on a 429 whose recovery window is too long to wait out", async () => {
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const outcome = await countCompletionsRequests(() => rateLimited({ "retry-after": "600" }));
		expect(outcome.requests).toBe(1);
		expect(outcome.stopReason).toBe("error");
	});

	it("keeps the full transport budget for provider capacity failures", async () => {
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const outcome = await countCompletionsRequests(() => new Response("overloaded", { status: 503 }));
		expect(outcome.requests).toBeGreaterThan(MAX_RATE_LIMIT_ATTEMPTS);
		expect(outcome.stopReason).toBe("error");
	});

	it("does not retry a 401 at the transport layer", async () => {
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const outcome = await countCompletionsRequests(() => new Response('{"error":"bad key"}', { status: 401 }));
		expect(outcome.requests).toBe(1);
		expect(outcome.stopReason).toBe("error");
		expect(outcome.errorStatus).toBe(401);
	});

	it("keeps N parallel callers at O(N) requests against a rate-limited route", async () => {
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const callers = 8;
		let requests = 0;
		const fetchMock: FetchImpl = async () => {
			requests++;
			return rateLimited({ "retry-after-ms": "20" });
		};
		const results = await Promise.all(
			Array.from({ length: callers }, () =>
				streamOpenAICompletions(completionsModel, context, {
					apiKey: "test-key",
					fetch: fetchMock,
					providerRetryWait: async () => {},
				}).result(),
			),
		);
		expect(results.every(result => result.stopReason === "error")).toBe(true);
		expect(requests).toBeLessThanOrEqual(callers * MAX_RATE_LIMIT_ATTEMPTS);
	});

	it("bounds the anthropic transport the same way", async () => {
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		let requests = 0;
		const fetchMock: FetchImpl = async () => {
			requests++;
			return new Response('{"type":"error","error":{"type":"rate_limit_error","message":"Too many requests"}}', {
				status: 429,
				headers: { "content-type": "application/json", "retry-after-ms": "20" },
			});
		};
		const result = await streamAnthropic(anthropicModel, context, {
			apiKey: "sk-test",
			fetch: fetchMock,
			providerRetryWait: async () => {},
		}).result();
		expect(result.stopReason).toBe("error");
		expect(requests).toBeLessThanOrEqual(MAX_RATE_LIMIT_ATTEMPTS);
	});

	it("preserves one short-hinted retry through the production anthropic stream", async () => {
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		let requests = 0;
		const fetchMock: FetchImpl = async () => {
			requests++;
			return requests === 1
				? rateLimited(
						{ "retry-after-ms": "20" },
						'{"type":"error","error":{"type":"rate_limit_error","message":"Too many requests"}}',
					)
				: anthropicSuccess("Hello");
		};
		const result = await streamAnthropic(anthropicModel, context, {
			apiKey: "sk-test",
			fetch: fetchMock,
			providerRetryWait: async () => {},
		}).result();
		expect(result.errorMessage).toBeUndefined();
		expect(result.stopReason).toBe("stop");
		expect(result.content.find(block => block.type === "text")?.text).toBe("Hello");
		expect(requests).toBe(MAX_RATE_LIMIT_ATTEMPTS);
	});

	it("preserves one short-hinted retry for an injected anthropic client", async () => {
		let requests = 0;
		const client: AnthropicMessagesClientLike = {
			messages: {
				create: () =>
					({
						async asResponse() {
							requests++;
							if (requests === 1) {
								throw new AnthropicApiError(429, "Too many requests", new Headers({ "retry-after-ms": "20" }));
							}
							return anthropicSuccess("Hello");
						},
					}) as never,
			},
		};
		const result = await streamAnthropic(anthropicModel, context, {
			client,
			providerRetryWait: async () => {},
		}).result();
		expect(result.errorMessage).toBeUndefined();
		expect(result.stopReason).toBe("stop");
		expect(result.content.find(block => block.type === "text")?.text).toBe("Hello");
		expect(requests).toBe(MAX_RATE_LIMIT_ATTEMPTS);
	});

	// An in-band `rate_limit_error` frame arrives on a 200 stream, so it carries
	// no HTTP status of its own. Left status-less it reads as generic transient
	// rate-limit text and the provider loop replays it up to PROVIDER_MAX_RETRIES
	// times — the same storm by another route. It must classify as 429.
	it("classifies a status-less in-band rate_limit_error frame as rate-limited", async () => {
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		let requests = 0;
		const fetchMock: FetchImpl = async () => {
			requests++;
			return new Response(
				'event: error\ndata: {"type":"error","error":{"type":"rate_limit_error","message":"Too many requests"}}\n\n',
				{ status: 200, headers: { "content-type": "text/event-stream" } },
			);
		};
		const result = await streamAnthropic(anthropicModel, context, {
			apiKey: "sk-test",
			fetch: fetchMock,
			providerRetryWait: async () => {},
		}).result();
		expect(result.stopReason).toBe("error");
		expect(result.errorStatus).toBe(429);
		expect(requests).toBe(1);
	});

	// Anthropic states the recovery window in the error body as often as in a
	// header ("Please retry in 250ms"). The credibility gate must read the same
	// header+body sources as the shared transport helper, or a body-only short
	// hint is discarded and an in-place recovery never happens.
	it("honors a body-only short retry hint on the anthropic transport", async () => {
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		let requests = 0;
		const fetchMock: FetchImpl = async () => {
			requests++;
			return requests === 1
				? new Response(
						'{"type":"error","error":{"type":"rate_limit_error","message":"Too many requests. Please retry in 20ms"}}',
						{ status: 429, headers: { "content-type": "application/json" } },
					)
				: new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } });
		};
		const client = new AnthropicMessagesClient({ apiKey: "sk-test", maxRetries: 5, fetch: fetchMock });

		const response = await client.messages
			.create({ model: "claude-test", max_tokens: 16, messages: [] } as never)
			.asResponse();

		expect(response.status).toBe(200);
		expect(requests).toBe(MAX_RATE_LIMIT_ATTEMPTS);
	});

	it("applies the caller's retry-delay cap to an anthropic body-only hint", async () => {
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		let requests = 0;
		const fetchMock: FetchImpl = async () => {
			requests++;
			return rateLimited(
				{},
				'{"type":"error","error":{"type":"rate_limit_error","message":"Too many requests. Please retry in 100ms"}}',
			);
		};
		const client = new AnthropicMessagesClient({ apiKey: "sk-test", maxRetries: 5, fetch: fetchMock });

		const error = await client.messages
			.create({ model: "claude-test", max_tokens: 16, messages: [] } as never, { maxRetryDelayMs: 1 })
			.asResponse()
			.catch((err: unknown) => err);

		expect(error).toBeInstanceOf(AnthropicApiError);
		expect(requests).toBe(1);
	});

	it("spends one request on an anthropic quota 429 even when it carries a short hint", async () => {
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		let requests = 0;
		const fetchMock: FetchImpl = async () => {
			requests++;
			return rateLimited(
				{ "retry-after-ms": "1" },
				'{"type":"error","error":{"type":"insufficient_quota","message":"You have hit your usage limit"}}',
			);
		};
		const client = new AnthropicMessagesClient({ apiKey: "sk-test", maxRetries: 5, fetch: fetchMock });

		const error = await client.messages
			.create({ model: "claude-test", max_tokens: 16, messages: [] } as never)
			.asResponse()
			.catch((err: unknown) => err);

		expect(error).toBeInstanceOf(AnthropicApiError);
		expect(requests).toBe(1);
	});

	it("surfaces a body-only long retry hint on the anthropic transport immediately", async () => {
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		let requests = 0;
		const fetchMock: FetchImpl = async () => {
			requests++;
			return new Response(
				'{"type":"error","error":{"type":"rate_limit_error","message":"Too many requests. Please retry in 300s"}}',
				{ status: 429, headers: { "content-type": "application/json" } },
			);
		};
		const client = new AnthropicMessagesClient({ apiKey: "sk-test", maxRetries: 5, fetch: fetchMock });

		const error = await client.messages
			.create({ model: "claude-test", max_tokens: 16, messages: [] } as never)
			.asResponse()
			.catch((err: unknown) => err);

		expect(error).toBeInstanceOf(AnthropicApiError);
		if (!(error instanceof AnthropicApiError)) throw error;
		expect(error.status).toBe(429);
		expect(requests).toBe(1);
	});

	it("uses the bounded anthropic error-body decoder before deciding whether to retry", async () => {
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		__anthropicApiErrorForTesting.setBodyReadTimeoutMs(0);
		let requests = 0;
		const fetchMock: FetchImpl = async () => {
			requests++;
			return rateLimited(
				{},
				'{"type":"error","error":{"type":"rate_limit_error","message":"Too many requests. Please retry in 20ms"}}',
			);
		};
		const client = new AnthropicMessagesClient({ apiKey: "sk-test", maxRetries: 5, fetch: fetchMock });

		const error = await client.messages
			.create({ model: "claude-test", max_tokens: 16, messages: [] } as never)
			.asResponse()
			.catch((err: unknown) => err);

		expect(error).toBeInstanceOf(AnthropicApiError);
		expect(requests).toBe(1);
	});
});
