import { describe, expect, test } from "bun:test";
import { OpenAIHttpError, postOpenAIStream } from "../src/utils/openai-http";
import { mockFetch } from "./helpers/fetch-mock";

// LiteLLM (and compatible proxies) shed over-concurrency requests before the
// upstream call with an immediate HTTP 429 marked `rate_limit_type:
// max_parallel_requests` and `Retry-After: 60`. Because a 60s hint equals the
// transport's `maxDelayMs` cap, `fetchWithRetry` used to sleep and retry it up
// to 6 times (~300s) before the error ever reached `TurnRecovery`, which owns
// the real concurrency backoff + model fallback. The transport must surface
// this admission failure on the first attempt instead. Regression guard for #8854.
describe("OpenAI transport concurrency-admission 429 (#8854)", () => {
	const concurrencyBody = JSON.stringify({
		error: {
			message: "Max parallel request limit reached",
			type: "rate_limit_error",
			rate_limit_type: "max_parallel_requests",
		},
	});

	test("surfaces a header-marked limiter 429 on the first attempt", async () => {
		let attempts = 0;
		const fetch = mockFetch(() => {
			attempts++;
			return new Response(concurrencyBody, {
				status: 429,
				headers: {
					"content-type": "application/json",
					"retry-after": "60",
					rate_limit_type: "max_parallel_requests",
				},
			});
		});

		const error = await postOpenAIStream({
			url: "https://litellm.local/v1/chat/completions",
			headers: {},
			body: { model: "gpt-4o", messages: [] },
			signal: new AbortController().signal,
			fetch,
		}).then(
			() => undefined,
			(err: unknown) => err,
		);

		expect(attempts).toBe(1);
		expect(error).toBeInstanceOf(OpenAIHttpError);
		expect((error as OpenAIHttpError).status).toBe(429);
	});

	test("surfaces a body-marked limiter 429 even without the header", async () => {
		let attempts = 0;
		const fetch = mockFetch(() => {
			attempts++;
			return new Response(concurrencyBody, {
				status: 429,
				headers: { "content-type": "application/json", "retry-after": "60" },
			});
		});

		const error = await postOpenAIStream({
			url: "https://litellm.local/v1/chat/completions",
			headers: {},
			body: { model: "gpt-4o", messages: [] },
			signal: new AbortController().signal,
			fetch,
		}).then(
			() => undefined,
			(err: unknown) => err,
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
