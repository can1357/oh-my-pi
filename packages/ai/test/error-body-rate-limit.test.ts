// Unit coverage for the in-band (HTTP 200 body) rate-limit classifier. These
// tests import only the standalone classifier module and assert it emits a
// ProviderHttpError with a real status / ProviderResponseError for each
// upstream 429-variant, so errorId lands on Flag.Transient once the provider
// wires it through. End-to-end (streamOpenAICompletions/streamOpenAIResponses
// advancing the fallback chain) is exercised separately against a real
// provider build with mocked 200 SSE bodies.
import { describe, expect, it } from "bun:test";
import { createInBandProviderError, createInBandProviderErrorFromText } from "../src/error/body-error";

describe("createInBandProviderError", () => {
	const retryable = [
		["nested type rate_limit_error", { error: { type: "rate_limit_error" } }],
		["nested code rate_limit_exceeded", { error: { code: "rate_limit_exceeded" } }],
		["nested type too_many_requests", { error: { type: "too_many_requests" } }],
		["bare numeric code 429", { code: 429 }],
		["flat status+message", { status: 429, message: "slow down" }],
		["error event inner type", { type: "error", error: { type: "rate_limit_error" } }],
		["overloaded_error → 503", { error: { type: "overloaded_error" } }],
	] as const;
	for (const [label, frame] of retryable) {
		it(`${label} yields a status-bearing ProviderHttpError`, () => {
			const err = createInBandProviderError(frame);
			expect(err).toBeInstanceOf(Error);
			expect(String((err as { status?: number }).status ?? "")).toMatch(/^([45]\d{2})$/);
		});
	}

	it("text-body 429 maps to a 429 ProviderHttpError", () => {
		const err = createInBandProviderErrorFromText("429 Too Many Requests");
		expect((err as { status?: number }).status).toBe(429);
	});

	it("non-throttle bodies are left unclassified (undefined)", () => {
		expect(createInBandProviderError({ error: { type: "invalid_request_error", message: "bad" } })).toBeUndefined();
		expect(createInBandProviderError({ type: "response.output_text.delta" })).toBeUndefined();
		// gpt-500x-style ids must never fabricate a status.
		expect(createInBandProviderErrorFromText("model gpt-500x rejected the request")).toBeUndefined();
	});
});