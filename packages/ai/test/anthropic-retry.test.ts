import { describe, expect, it } from "bun:test";
import { isProviderRetryableError } from "@oh-my-pi/pi-ai/error";

describe("isProviderRetryableError", () => {
	it("retries known transient rate-limit errors", () => {
		expect(isProviderRetryableError(new Error("Rate limit exceeded"))).toBe(true);
		expect(isProviderRetryableError(new Error("error 1302 from upstream"))).toBe(true);
	});

	it("retries transient stream parse errors and pre-content envelope failures", () => {
		expect(isProviderRetryableError(new Error("JSON Parse error: Unterminated string"))).toBe(true);
		expect(isProviderRetryableError(new Error("Unexpected end of JSON input"))).toBe(true);
		expect(
			isProviderRetryableError(
				new Error("Anthropic stream envelope error: received content_block_start before message_start"),
			),
		).toBe(true);
		expect(
			isProviderRetryableError(new Error("Anthropic stream envelope error: stream ended before message_start")),
		).toBe(true);
	});

	it("does not classify post-content envelope failures as provider-retryable", () => {
		expect(
			isProviderRetryableError(
				new Error("Anthropic stream envelope error: stream ended before terminal stop signal"),
			),
		).toBe(false);
	});

	it("retries HTTP/2 stream errors (INTERNAL_ERROR)", () => {
		expect(
			isProviderRetryableError(new Error("stream error: stream ID 391; INTERNAL_ERROR; received from peer")),
		).toBe(true);
	});

	it("retries Anthropic TLS server transport errors", () => {
		expect(
			isProviderRetryableError(
				new Error(
					'Post "https://api.anthropic.com/v1/messages?beta=true": remote error: tls: bad record MAC (type=server_error)',
				),
			),
		).toBe(true);
	});

	it("does not retry permanent TLS configuration failures (no server annotation)", () => {
		expect(isProviderRetryableError(new Error("tls: failed to verify certificate"))).toBe(false);
	});

	it("retries Bun socket closure errors", () => {
		expect(
			isProviderRetryableError(
				new Error(
					"The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()",
				),
			),
		).toBe(true);
	});

	it("retries first-event timeout errors", () => {
		expect(isProviderRetryableError(new Error("Anthropic stream timed out while waiting for the first event"))).toBe(
			true,
		);
	});

	it("does not retry non-transient validation errors", () => {
		expect(isProviderRetryableError(new Error("Invalid tool schema"))).toBe(false);
		expect(isProviderRetryableError(new Error("Bad request"))).toBe(false);
	});

	it("does not retry persistent account usage/quota limits despite rate-limit wording", () => {
		// Account-level 429 that says "rate limit" but is really a parked
		// credential (long retry-after). Must surface immediately so the
		// credential-rotation layer takes over instead of looping on backoff.
		expect(
			isProviderRetryableError(
				new Error(
					'429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account\'s rate limit. Please try again later."}}',
				),
			),
		).toBe(false);
		expect(isProviderRetryableError(new Error("usage_limit_reached"))).toBe(false);
		expect(isProviderRetryableError(new Error("You have hit your ChatGPT usage limit"))).toBe(false);
		// Anthropic monthly spend-cap 429 (issue #4787): must not retry, or the
		// provider loop burns its budget on minutes-long retry-after backoff and
		// surfaces "Deadline exceeded" instead of the quota error.
		expect(
			isProviderRetryableError(
				new Error(
					'429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account\'s monthly spend limit. Please try again later."}}',
				),
			),
		).toBe(false);
		// A generic transient rate limit (no account/usage framing) still retries.
		expect(isProviderRetryableError(new Error("Rate limit exceeded"))).toBe(true);
	});

	it("does not retry Copilot 400 model rejections", () => {
		// Both codes are deterministic: GitHub gates models per integrator and
		// per account, so a replay of the same request fails identically.
		for (const code of ["model_not_supported", "model_not_available_for_integrator"]) {
			const body = {
				error: {
					message: "The requested model is not supported.",
					code,
					param: "model",
					type: "invalid_request_error",
				},
			};
			const err = Object.assign(new Error(`400 ${JSON.stringify(body)}`), { status: 400, code, error: body });
			expect(isProviderRetryableError(err)).toBe(false);
		}
	});
});
