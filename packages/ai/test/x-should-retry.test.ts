import { describe, expect, test } from "bun:test";
import * as AIError from "../src/error";
import { OpenAIHttpError, postOpenAIStream } from "../src/utils/openai-http";
import { mockFetch } from "./helpers/fetch-mock";

// A retrying gateway that already exhausted its own attempts answers with a
// terminal 5xx plus `x-should-retry: false`. The removed `openai` SDK obeyed
// that verdict; the wire transport and the provider retry loops must too, or
// every layer replays a request the gateway already gave up on (#17920).
function terminal503(): Response {
	return new Response(JSON.stringify({ error: { message: "upstream unavailable", type: "server_error" } }), {
		status: 503,
		headers: { "content-type": "application/json", "x-should-retry": "false", "retry-after-ms": "1" },
	});
}

async function captureStreamError(response: () => Response): Promise<{ attempts: number; error: unknown }> {
	let attempts = 0;
	const fetch = mockFetch(() => {
		attempts++;
		return response();
	});
	const error = await postOpenAIStream({
		url: "http://gateway.local/v1/chat/completions",
		headers: {},
		body: {},
		signal: new AbortController().signal,
		fetch,
	}).then(
		() => undefined,
		(err: unknown) => err,
	);
	return { attempts, error };
}

describe("x-should-retry on the OpenAI wire (#17920)", () => {
	test("transport surfaces a terminal 503 on the first attempt", async () => {
		const { attempts, error } = await captureStreamError(terminal503);

		expect(attempts).toBe(1);
		expect(error).toBeInstanceOf(OpenAIHttpError);
		expect((error as OpenAIHttpError).status).toBe(503);
	});

	test("provider retry classification obeys the captured verdict over status", async () => {
		const { error } = await captureStreamError(terminal503);
		expect(AIError.isProviderRetryableError(error)).toBe(false);

		const forcedRetry = new OpenAIHttpError("400 try again", {
			status: 400,
			headers: new Headers({ "x-should-retry": "true" }),
		});
		expect(AIError.isProviderRetryableError(forcedRetry)).toBe(true);
	});
});

// LiteLLM (and compatible proxies) shed over-concurrency requests before the
// upstream call with an immediate HTTP 429 marked `rate_limit_type:
// max_parallel_requests` and `Retry-After: 60`. A 60s hint equals the
// transport's `maxDelayMs` cap, so sleeping and retrying would burn ~300s before
// the error reaches `TurnRecovery`, which owns the real concurrency backoff and
// model fallback. The transport surfaces this admission failure on the first attempt.
describe("OpenAI transport concurrency-admission 429", () => {
	const concurrencyBody = JSON.stringify({
		error: {
			message: "Max parallel request limit reached",
			type: "rate_limit_error",
			rate_limit_type: "max_parallel_requests",
		},
	});

	test("surfaces a header-marked limiter 429 on the first attempt", async () => {
		const { attempts, error } = await captureStreamError(
			() =>
				new Response(concurrencyBody, {
					status: 429,
					headers: {
						"content-type": "application/json",
						"retry-after": "60",
						rate_limit_type: "max_parallel_requests",
					},
				}),
		);

		expect(attempts).toBe(1);
		expect(error).toBeInstanceOf(OpenAIHttpError);
		expect((error as OpenAIHttpError).status).toBe(429);
	});

	test("surfaces a body-marked limiter 429 even without the header", async () => {
		const { attempts, error } = await captureStreamError(
			() =>
				new Response(concurrencyBody, {
					status: 429,
					headers: { "content-type": "application/json", "retry-after": "60" },
				}),
		);

		expect(attempts).toBe(1);
		expect(error).toBeInstanceOf(OpenAIHttpError);
		expect((error as OpenAIHttpError).status).toBe(429);
	});

	// Scope guard: the opt-out must not globally disable Retry-After. A generic
	// RPM/quota 429 without the concurrency marker is still retried.
	test("still retries a generic 429 that lacks the concurrency marker", async () => {
		let attempts = 0;
		const fetch = mockFetch(() => {
			attempts++;
			if (attempts === 1) {
				return new Response(JSON.stringify({ error: { message: "Rate limit reached" } }), {
					status: 429,
					// Short delta hint so the retry sleep is negligible in-test.
					headers: { "content-type": "application/json", "retry-after-ms": "5" },
				});
			}
			return new Response("data: [DONE]\n\n", {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			});
		});

		const handle = await postOpenAIStream({
			url: "https://api.openai.com/v1/chat/completions",
			headers: {},
			body: { model: "gpt-4o", messages: [] },
			signal: new AbortController().signal,
			fetch,
		});

		expect(attempts).toBe(2);
		expect(handle.response.status).toBe(200);
	});
});

// Mistral answers a model the plan does not cover with a 429 whose
// `x-ratelimit-limit-req-minute` is 0 and no Retry-After. No wait or replay can
// succeed, so the transport must surface it on the first attempt as a terminal
// usage limit that names the header, instead of feeding transport, stream, and
// TurnRecovery retries.
describe("OpenAI transport zero rate-limit allowance 429", () => {
	const mistralBody = JSON.stringify({
		object: "error",
		message: "Rate limit exceeded",
		type: "rate_limited",
		code: "1300",
		raw_status_code: 429,
	});

	function mistral429(headers: Record<string, string>): () => Response {
		return () =>
			new Response(mistralBody, { status: 429, headers: { "content-type": "application/json", ...headers } });
	}

	test("fails fast as a non-waitable usage limit naming the header", async () => {
		const { attempts, error } = await captureStreamError(
			mistral429({ "x-ratelimit-limit-req-minute": "0", "x-ratelimit-remaining-req-minute": "0" }),
		);

		expect(attempts).toBe(1);
		expect(error).toBeInstanceOf(OpenAIHttpError);
		const message = (error as OpenAIHttpError).message;
		expect(message).toContain("x-ratelimit-limit-req-minute: 0");
		expect(AIError.isProviderRetryableError(error)).toBe(false);
		expect(AIError.isUsageLimit(error)).toBe(true);
		expect(AIError.isBillingCapUsageLimit(429, message)).toBe(true);
	});

	// Scope guard: a spent but non-zero window still reopens, so it stays a
	// transient rate limit the transport retries.
	test("still retries a spent window with a non-zero limit", async () => {
		const { attempts, error } = await captureStreamError(
			mistral429({
				"x-ratelimit-limit-req-minute": "60",
				"x-ratelimit-remaining-req-minute": "0",
				"retry-after-ms": "5",
			}),
		);

		expect(attempts).toBeGreaterThan(1);
		expect(AIError.isUsageLimit(error)).toBe(false);
		expect(AIError.isProviderRetryableError(error)).toBe(true);
	});
});
