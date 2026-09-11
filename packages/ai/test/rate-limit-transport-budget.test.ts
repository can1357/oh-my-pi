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
import { describe, expect, it, vi } from "bun:test";
import { scheduler } from "node:timers/promises";
import { streamAnthropic } from "@oh-my-pi/pi-ai/providers/anthropic";
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

describe("transport rate-limit budget", () => {
	it("spends one request on a persistent 429 that offers no recovery signal", async () => {
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const outcome = await countCompletionsRequests(() => rateLimited());
		expect(outcome.requests).toBe(1);
		expect(outcome.stopReason).toBe("error");
		expect(outcome.errorStatus).toBe(429);
		vi.restoreAllMocks();
	});

	it("spends at most MAX_RATE_LIMIT_ATTEMPTS requests on a persistent 429 with a short retry hint", async () => {
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const outcome = await countCompletionsRequests(() => rateLimited({ "retry-after-ms": "20" }));
		expect(MAX_RATE_LIMIT_ATTEMPTS).toBe(2);
		expect(outcome.requests).toBe(MAX_RATE_LIMIT_ATTEMPTS);
		expect(outcome.stopReason).toBe("error");
		expect(outcome.errorStatus).toBe(429);
		vi.restoreAllMocks();
	});

	it("still recovers in-place when a short-hinted 429 clears on the next attempt", async () => {
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const outcome = await countCompletionsRequests(request =>
			request === 1 ? rateLimited({ "retry-after-ms": "20" }) : completionsSuccess("recovered"),
		);
		expect(outcome.requests).toBe(2);
		expect(outcome.stopReason).toBe("stop");
		expect(outcome.text).toBe("recovered");
		vi.restoreAllMocks();
	});

	it("spends one request on a quota-exhaustion 429 so credential rotation runs immediately", async () => {
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const outcome = await countCompletionsRequests(() =>
			rateLimited({}, '{"error":{"message":"You have hit your usage limit","type":"insufficient_quota"}}'),
		);
		expect(outcome.requests).toBe(1);
		expect(outcome.stopReason).toBe("error");
		vi.restoreAllMocks();
	});

	it("spends one request on a 429 whose recovery window is too long to wait out", async () => {
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const outcome = await countCompletionsRequests(() => rateLimited({ "retry-after": "600" }));
		expect(outcome.requests).toBe(1);
		expect(outcome.stopReason).toBe("error");
		vi.restoreAllMocks();
	});

	it("keeps the full transport budget for provider capacity failures", async () => {
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const outcome = await countCompletionsRequests(() => new Response("overloaded", { status: 503 }));
		expect(outcome.requests).toBeGreaterThan(MAX_RATE_LIMIT_ATTEMPTS);
		expect(outcome.stopReason).toBe("error");
		vi.restoreAllMocks();
	});

	it("does not retry a 401 at the transport layer", async () => {
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const outcome = await countCompletionsRequests(() => new Response('{"error":"bad key"}', { status: 401 }));
		expect(outcome.requests).toBe(1);
		expect(outcome.stopReason).toBe("error");
		expect(outcome.errorStatus).toBe(401);
		vi.restoreAllMocks();
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
		vi.restoreAllMocks();
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
		vi.restoreAllMocks();
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
		vi.restoreAllMocks();
	});
});
