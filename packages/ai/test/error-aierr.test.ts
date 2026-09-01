import { describe, expect, it } from "bun:test";
import * as AIError from "@oh-my-pi/pi-ai/error";

describe("AIError.classify — structural provider errors", () => {
	it("classifies an Anthropic connection timeout as timeout + transient (no regex)", () => {
		const id = AIError.classify(new AIError.AnthropicConnectionTimeoutError());
		expect(AIError.is(id, AIError.Flag.Timeout)).toBe(true);
		expect(AIError.is(id, AIError.Flag.Transient)).toBe(true);
	});

	it("classifies an Anthropic connection error as transient", () => {
		const id = AIError.classify(new AIError.AnthropicConnectionError(new Error("ECONNRESET")));
		expect(AIError.is(id, AIError.Flag.Transient)).toBe(true);
	});

	it("maps a 5xx ProviderHttpError to transient via status", () => {
		const id = AIError.classify(new AIError.ProviderHttpError("Service Unavailable", 503));
		expect(AIError.is(id, AIError.Flag.Transient)).toBe(true);
	});

	it("maps the overloaded_error code to transient regardless of status", () => {
		const id = AIError.classify(new AIError.ProviderHttpError("Overloaded", 529, { code: "overloaded_error" }));
		expect(AIError.is(id, AIError.Flag.Transient)).toBe(true);
	});

	it("classifies statusless provider capacity errors as transient and retryable", () => {
		const messages = [
			"Error Code no_capacity: The system is currently experiencing high demand",
			"Provider is at capacity",
			"Insufficient capacity during peak load",
			"Capacity exhausted",
		];
		for (const message of messages) {
			const id = AIError.classify(new Error(message));
			expect(AIError.is(id, AIError.Flag.Transient)).toBe(true);
			expect(AIError.retriable(id)).toBe(true);
		}
	});

	it("does not treat benign capacity descriptions as transient", () => {
		const id = AIError.classify(new Error("This model has a 128k token capacity"));
		expect(AIError.is(id, AIError.Flag.Transient)).toBe(false);
	});

	it("maps 401/403 to authFailed via status", () => {
		expect(
			AIError.is(AIError.classify(new AIError.ProviderHttpError("Unauthorized", 401)), AIError.Flag.AuthFailed),
		).toBe(true);
		expect(
			AIError.is(AIError.classify(new AIError.ProviderHttpError("Forbidden", 403)), AIError.Flag.AuthFailed),
		).toBe(true);
	});

	it("classifies a typed AWS credential-resolution failure as authFailed", () => {
		const id = AIError.classify(new AIError.AwsCredentialsError("opaque provider setup failure", "resolution"));
		expect(AIError.is(id, AIError.Flag.AuthFailed)).toBe(true);
	});

	it("maps the usage_limit_reached code to usageLimit on a 429", () => {
		const id = AIError.classify(
			new AIError.ProviderHttpError("Payment Required", 429, { code: "usage_limit_reached" }),
		);
		expect(AIError.is(id, AIError.Flag.UsageLimit)).toBe(true);
	});

	it("recognizes Codex transport errors by name without importing the provider", () => {
		const transport = Object.assign(new Error("websocket closed"), { name: "CodexWebSocketTransportError" });
		expect(AIError.is(AIError.classify(transport), AIError.Flag.Transient)).toBe(true);
		const retryableStream = Object.assign(new Error("server error"), {
			name: "CodexProviderStreamError",
			retryable: true,
		});
		expect(AIError.is(AIError.classify(retryableStream), AIError.Flag.Transient)).toBe(true);
		const fatalStream = Object.assign(new Error("bad request"), {
			name: "CodexProviderStreamError",
			retryable: false,
		});
		expect(AIError.is(AIError.classify(fatalStream), AIError.Flag.Transient)).toBe(false);
	});

	it("classifies an incomplete provider stream as transient + retryable", () => {
		const err = new AIError.ProviderResponseError(
			"Google API stream ended without a finish reason (connection dropped or response truncated)",
			{ provider: "google", kind: "incomplete-stream" },
		);
		const id = AIError.classify(err);
		expect(AIError.is(id, AIError.Flag.Transient)).toBe(true);
		expect(AIError.retriable(id)).toBe(true);
	});

	it("keeps empty response bodies on the generic transient fallback path", () => {
		const err = new AIError.ProviderResponseError("Google API returned an empty response body", {
			provider: "google",
			kind: "empty-body",
		});
		const id = AIError.classify(err);
		expect(AIError.is(id, AIError.Flag.Transient)).toBe(true);
		expect(AIError.is(id, AIError.Flag.EmptyResponse)).toBe(false);
		expect(AIError.retriable(id)).toBe(true);
	});

	it("classifies thought-only output as transient + empty-response + retryable", () => {
		const err = new AIError.ProviderResponseError(
			"Cloud Code Assist API returned a thought-only response without final output",
			{
				provider: "google-antigravity",
				kind: "empty-output",
			},
		);
		const id = AIError.classify(err);
		expect(AIError.is(id, AIError.Flag.Transient)).toBe(true);
		expect(AIError.is(id, AIError.Flag.EmptyResponse)).toBe(true);
		expect(AIError.retriable(id)).toBe(true);
	});

	it("does not mark a terminal output provider error as transient", () => {
		const err = new AIError.ProviderResponseError("upstream error", { provider: "google", kind: "output" });
		expect(AIError.retriable(AIError.classify(err))).toBe(false);
	});
});

describe("AIError.finalize", () => {
	it("bundles id, status, error stopReason, and message for a connection timeout", async () => {
		const result = await AIError.finalize(new AIError.AnthropicConnectionTimeoutError(), {});
		expect(result.stopReason).toBe("error");
		expect(AIError.is(result.id, AIError.Flag.Timeout)).toBe(true);
		expect(AIError.is(result.id, AIError.Flag.Transient)).toBe(true);
		expect(result.message.length).toBeGreaterThan(0);
	});

	it("reports aborted when the caller signal is aborted", async () => {
		const controller = new AbortController();
		controller.abort();
		const result = await AIError.finalize(new Error("cancelled"), { signal: controller.signal });
		expect(result.stopReason).toBe("aborted");
	});

	it("surfaces the HTTP status from a ProviderHttpError", async () => {
		const result = await AIError.finalize(new AIError.ProviderHttpError("Bad Gateway", 502), {});
		expect(result.status).toBe(502);
		expect(AIError.is(result.id, AIError.Flag.Transient)).toBe(true);
	});

	it("preserves nested token-overflow evidence through finalization", async () => {
		const inner = Object.assign(new Error("Error: maximum context length is 128000 tokens"), { status: 413 });
		const result = await AIError.finalize(new Error("Provider returned error", { cause: inner }));

		expect(AIError.is(result.id, AIError.Flag.ContextOverflow)).toBe(true);
		expect(AIError.is(result.id, AIError.Flag.PayloadRejected)).toBe(false);
	});

	it("keeps an incomplete-stream provider error retryable through finalize + classifyMessage", async () => {
		const result = await AIError.finalize(
			new AIError.ProviderResponseError("stream ended without a finish reason", { kind: "incomplete-stream" }),
			{},
		);
		expect(result.stopReason).toBe("error");
		expect(AIError.retriable(result.id)).toBe(true);
		// The transient flag survives a re-classify from the persisted message fields.
		const reId = AIError.classifyMessage({ errorId: result.id, errorMessage: result.message });
		expect(AIError.retriable(reId)).toBe(true);
	});
});

describe("aierr flag helpers", () => {
	it("compose then has round-trips multiple flags", () => {
		const id = AIError.create(AIError.Flag.ThinkingLoop, AIError.Flag.Transient);
		expect(AIError.is(id, AIError.Flag.ThinkingLoop)).toBe(true);
		expect(AIError.is(id, AIError.Flag.Transient)).toBe(true);
		expect(AIError.is(id, AIError.Flag.Timeout)).toBe(false);
	});

	it("treats transient and usageLimit ids as retryable", () => {
		expect(AIError.retriable(AIError.create(AIError.Flag.Transient))).toBe(true);
		expect(AIError.retriable(AIError.create(AIError.Flag.UsageLimit))).toBe(true);
	});

	it("recognizes explicit transient stream parse diagnostics without broad text false positives", () => {
		const message = "JSON Parse error: Unterminated string";
		expect(AIError.isTransientStreamParseError(new Error(message))).toBe(true);
		expect(AIError.isTransientStreamParseError(new Error("response truncated"))).toBe(true);
		expect(AIError.isTransientStreamParseError(message)).toBe(true);
		expect(AIError.isTransientStreamParseError("Unexpected end of JSON input")).toBe(true);
		expect(AIError.isTransientStreamParseError("JSON.parse: unexpected end of data at line 1 column 8")).toBe(true);
		expect(AIError.isTransientStreamParseError("Unexpected EOF")).toBe(true);
		expect(AIError.isTransientStreamParseError("EOF while parsing")).toBe(true);
		expect(AIError.isTransientStreamParseError("truncated")).toBe(false);
		expect(AIError.isTransientStreamParseError("end of file")).toBe(false);
		expect(AIError.isTransientStreamParseError("Unexpected token in JSON")).toBe(false);
	});
});
