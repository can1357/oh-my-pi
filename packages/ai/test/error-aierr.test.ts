import { describe, expect, it } from "bun:test";
import * as AIError from "@pk-nerdsaver-ai/pi-ai/error";

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

	it("maps 401/403 to authFailed via status", () => {
		expect(
			AIError.is(AIError.classify(new AIError.ProviderHttpError("Unauthorized", 401)), AIError.Flag.AuthFailed),
		).toBe(true);
		expect(
			AIError.is(AIError.classify(new AIError.ProviderHttpError("Forbidden", 403)), AIError.Flag.AuthFailed),
		).toBe(true);
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
});
