import { describe, expect, test } from "bun:test";
import * as AIError from "../src/error";
import { OpenAIHttpError, postOpenAIStream } from "../src/utils/openai-http";
import { mockFetch } from "./helpers/fetch-mock";

// Mistral answers a model the plan does not cover with a 429 whose
// `x-ratelimit-limit-req-minute` is 0 and no Retry-After. No wait or replay can
// succeed, so the transport must surface it on the first attempt as a terminal
// usage limit that names the header, instead of feeding transport, stream, and
// TurnRecovery retries (#19300).
describe("zero rate-limit allowance 429 (#19300)", () => {
	const mistralBody = JSON.stringify({
		object: "error",
		message: "Rate limit exceeded",
		type: "rate_limited",
		code: "1300",
		raw_status_code: 429,
	});

	async function post(headers: Record<string, string>, onAttempt: () => void): Promise<unknown> {
		const fetch = mockFetch(() => {
			onAttempt();
			return new Response(mistralBody, { status: 429, headers: { "content-type": "application/json", ...headers } });
		});
		return postOpenAIStream({
			url: "https://api.mistral.ai/v1/chat/completions",
			headers: {},
			body: { model: "mistral-medium-latest", messages: [] },
			signal: new AbortController().signal,
			fetch,
		}).then(
			() => undefined,
			(err: unknown) => err,
		);
	}

	test("fails fast as a non-waitable usage limit naming the header", async () => {
		let attempts = 0;
		const error = await post(
			{ "x-ratelimit-limit-req-minute": "0", "x-ratelimit-remaining-req-minute": "0" },
			() => attempts++,
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
		let attempts = 0;
		const error = await post(
			{ "x-ratelimit-limit-req-minute": "60", "x-ratelimit-remaining-req-minute": "0", "retry-after-ms": "5" },
			() => attempts++,
		);

		expect(attempts).toBeGreaterThan(1);
		expect(AIError.isUsageLimit(error)).toBe(false);
		expect(AIError.isProviderRetryableError(error)).toBe(true);
	});
});
