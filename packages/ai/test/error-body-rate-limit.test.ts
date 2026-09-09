/**
 * Coverage for rate-limit/overload failures that arrive *inside* an HTTP 200
 * stream body (`{"error":{…}}`, `{"code":429}`, or a plain-text frame from a
 * proxy that already committed to the stream).
 *
 * Tests run through the real provider paths — `streamOpenAICompletions` with a
 * mocked SSE body (asserting the finalized `AssistantMessage`) and
 * `processResponsesStream` (asserting the thrown error) — instead of only on
 * the classifier helper. Three contracts are pinned:
 *
 * 1. a recognised throttle yields a real 429/5xx `ProviderHttpError`, so the
 *    `Flag.Transient` lane and `retry.fallbackChains` advance;
 * 2. no status is ever fabricated from prose — a body that merely *mentions*
 *    401/403 keeps `errorStatus` undefined, and `errorStatus` can only be 429
 *    or 5xx, never an auth code;
 * 3. an unreadable/opaque body cannot burn a credential: `isAuthRetryableError`
 *    (which drives rotation) stays false.
 *
 * Envelopes that are not a recognised throttle must fall through untouched.
 */
import { describe, expect, it } from "bun:test";
import { processResponsesStream } from "@oh-my-pi/pi-ai/providers/openai-shared";
import { streamOpenAICompletions } from "@oh-my-pi/pi-ai/providers/openai-completions";
import type { AssistantMessage, Context, FetchImpl, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { isAuthRetryableError } from "@oh-my-pi/pi-ai/error/auth-classify";
import { classify, Flag, is, retriable } from "@oh-my-pi/pi-ai/error/flags";
import { isUsageLimitOutcome } from "@oh-my-pi/pi-ai/error/rate-limit";
import { ProviderHttpError } from "@oh-my-pi/pi-ai/error/classes";
import { createInBandProviderError, createInBandProviderErrorFromText } from "@oh-my-pi/pi-ai/error/body-error";

function createSseResponse(events: unknown[]): Response {
	const payload = `${events
		.map(event => `data: ${typeof event === "string" ? event : JSON.stringify(event)}`)
		.join("\n\n")}\n\n`;
	return new Response(payload, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

function createMockFetch(events: unknown[]): FetchImpl {
	async function mockFetch(_input: string | URL | Request, _init?: RequestInit): Promise<Response> {
		return createSseResponse(events);
	}
	return Object.assign(mockFetch, { preconnect: fetch.preconnect });
}

function baseContext(): Context {
	return {
		messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
		tools: [],
	};
}

/** Stream one in-band frame through the real provider and return the finalized message. */
async function streamFrame(frame: unknown) {
	const model = getBundledModel<"openai-completions">("minimax-code-cn", "MiniMax-M3");
	return streamOpenAICompletions(model, baseContext(), {
		apiKey: "test-key",
		fetch: createMockFetch([frame, "[DONE]"]),
	}).result();
}

/**
 * Frames the OpenAI wire reports in a 200 body for a transient upstream
 * failure. Every row must land in the retry lane with a real 429/5xx status.
 */
const IN_BAND_THROTTLES: [label: string, frame: unknown, status: number][] = [
	["nested error.type", { error: { type: "rate_limit_error" } }, 429],
	["nested error.code", { error: { code: "rate_limit_exceeded" } }, 429],
	["openai too_many_requests", { error: { type: "too_many_requests" } }, 429],
	["bare numeric code", { code: 429 }, 429],
	["flat status and message", { status: 429, message: "slow down" }, 429],
	["string status field", { error: { status: "429", message: "compat status" } }, 429],
	["typed error event", { type: "error", error: { type: "rate_limit_error" } }, 429],
	["anthropic overloaded_error", { error: { type: "overloaded_error" } }, 503],
];

describe("in-band 429/5xx bodies (openai-completions stream)", () => {
	for (const [label, frame, status] of IN_BAND_THROTTLES) {
		it(`${label} classifies as a transient ${status} and stays out of the credential lane`, async () => {
			const result = await streamFrame(frame);

			expect(result.stopReason).toBe("error");
			expect(result.errorStatus).toBe(status);
			expect(is(result.errorId, Flag.Transient)).toBe(true);
			expect(retriable(result.errorId)).toBe(true);
			// A plain throttle is a backoff signal, not an exhausted account.
			expect(is(result.errorId, Flag.UsageLimit)).toBe(false);
			// The message keeps the numeric status first so text-based retry hints
			// and the placeholder are unambiguous.
			expect(result.errorMessage?.startsWith(`${status} `)).toBe(true);
		});
	}

	it("advances the retry lane for the body the shipped classifier missed: bare { code: 429 }", async () => {
		// The legacy stream-error guard only fires on an object `error` member, so
		// before the probe ran first this frame produced errorId 0 (terminal).
		const result = await streamFrame({ code: 429 });
		expect(result.errorId).not.toBe(0);
		expect(retriable(result.errorId)).toBe(true);
	});

	it("an opaque body cannot trigger credential rotation", async () => {
		const result = await streamFrame({ status: 429, message: "{}" });

		expect(result.errorStatus).toBe(429);
		expect(retriable(result.errorId)).toBe(true);
		// The synthesized message must not itself read as an opaque status body,
		// otherwise the usage-limit rule would treat it as quota exhaustion.
		expect(isUsageLimitOutcome(429, result.errorMessage ?? "")).toBe(false);
		expect(isAuthRetryableError(new Error(result.errorMessage ?? ""))).toBe(false);
		expect(result.errorMessage).toBe("429 Provider returned an in-band provider error");
	});

	it("does not fabricate a status from prose that mentions an auth code", async () => {
		const result = await streamFrame({ error: { message: "Too many requests (401 from billing shim)" } });

		// No HTTP status of any kind is invented: the transport succeeded.
		expect(result.errorStatus).toBeUndefined();
		expect(is(result.errorId, Flag.Transient)).toBe(true);
		expect(retriable(result.errorId)).toBe(true);
		// Rotating on a body whose only auth signal is prose burns a working key.
		expect(isAuthRetryableError(new Error(result.errorMessage ?? ""))).toBe(false);
		expect(result.errorMessage).toBe("Too many requests (401 from billing shim)");
	});

	it("keeps the upstream text verbatim when it already leads with the status", async () => {
		const result = await streamFrame("429 Too Many Requests");

		expect(result.errorStatus).toBe(429);
		expect(is(result.errorId, Flag.Transient)).toBe(true);
		expect(retriable(result.errorId)).toBe(true);
		expect(result.errorMessage).toBe("429 Too Many Requests");
	});

	it("strips the markup from an HTML throttle page and reports its status", async () => {
		const result = await streamFrame(
			"<html><head><title>503 Service Temporarily Unavailable</title></head><body>nginx</body></html>",
		);

		expect(result.errorStatus).toBe(503);
		expect(is(result.errorId, Flag.Transient)).toBe(true);
		expect(result.errorMessage).toBe("503 Service Temporarily Unavailable nginx");
	});

	it("reads a retry hint out of the in-band message", async () => {
		// `extractRetryHint` works on message text, so the upstream detail has to
		// survive into the message rather than being hidden behind a placeholder.
		const result = await streamFrame({ status: 429, message: "slow down, retry in 30 seconds" });
		expect(result.errorMessage).toBe("429 slow down, retry in 30 seconds");
	});

	it("leaves the normal stream path alone", async () => {
		const result = await streamFrame({
			choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }],
		});
		expect(result.stopReason).toBe("stop");
		expect(result.errorStatus).toBeUndefined();
	});

	for (const [label, frame, message] of [
		["non-throttle error member", { error: { type: "invalid_request_error", message: "bad" } }, "bad"],
		["quota code stays unclassified in-band", { error: { code: "insufficient_quota", message: "pay up" } }, "pay up"],
	] as [string, unknown, string][]) {
		it(`${label} keeps its pre-existing handling`, async () => {
			const result = await streamFrame(frame);
			expect(result.stopReason).toBe("error");
			expect(result.errorId).toBe(0);
			expect(result.errorStatus).toBeUndefined();
			expect(result.errorMessage).toBe(message);
		});
	}

	it("does not turn a model id that looks like a status into a 5xx", async () => {
		// "gpt-500x" used to be read as status 500 out of prose.
		const result = await streamFrame("model gpt-500x rejected the request");
		expect(result.errorStatus).toBeUndefined();
		expect(result.errorId).toBe(0);
		expect(result.errorMessage).toContain("JSON Parse error");
	});
});

describe("createInBandProviderError", () => {
	it("returns undefined for envelopes that are not a recognised throttle", () => {
		expect(createInBandProviderError({ error: { type: "invalid_request_error", message: "bad" } })).toBeUndefined();
		expect(createInBandProviderError({ type: "response.output_text.delta" })).toBeUndefined();
		expect(createInBandProviderError({ error: { code: "constructor" } })).toBeUndefined();
		expect(createInBandProviderError({ error: { status: 404, message: "no such model" } })).toBeUndefined();
		expect(createInBandProviderError({ error: { code: 401, message: "nope" } })).toBeUndefined();
		expect(createInBandProviderErrorFromText("model gpt-500x rejected the request")).toBeUndefined();
		expect(createInBandProviderErrorFromText("hello world")).toBeUndefined();
	});

	it("rejects prose statuses that are not a standalone token", () => {
		// A 4290 prefix must not be read as 429.
		expect(createInBandProviderErrorFromText("4290 requests in flight")).toBeUndefined();
	});
});

function makeResponsesModel(): Model<"openai-responses"> {
	return buildModel({
		api: "openai-responses",
		name: "GPT Test",
		id: "gpt-test",
		provider: "openai",
		baseUrl: "https://api.openai.com/v1",
		contextWindow: 8192,
		maxTokens: 2048,
		input: ["text"],
		reasoning: false,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	});
}

function makeResponsesOutput(): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		timestamp: Date.now(),
		provider: "openai",
		model: "gpt-test",
		api: "openai-responses",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
	};
}

async function* asEvents(events: unknown[]): AsyncIterable<never> {
	for (const event of events) yield event as never;
}

/** Run the Responses terminal/error probes and return what they threw. */
async function processEvents(events: unknown[]): Promise<Error | undefined> {
	const noopStream = { push: () => {}, end: () => {} } as never;
	try {
		await processResponsesStream(asEvents(events), makeResponsesOutput(), noopStream, makeResponsesModel());
		return undefined;
	} catch (error) {
		return error as Error;
	}
}

describe("in-band 429/5xx bodies (responses probes)", () => {
	it("reads a status reported beside the error member on a failed response", async () => {
		// The probe receives the whole envelope, so `status` next to `error` counts
		// even when the inner object carries no code of its own.
		const error = await processEvents([
			{
				type: "response.failed",
				response: { status: 429, error: { message: "slow down" } },
			},
		]);

		expect(error).toBeInstanceOf(ProviderHttpError);
		expect((error as ProviderHttpError).status).toBe(429);
		expect(is(classify(error), Flag.Transient)).toBe(true);
		expect(retriable(classify(error))).toBe(true);
		expect(error?.message).toBe("429 slow down");
	});

	it("classifies a flat typed error event", async () => {
		const error = await processEvents([{ type: "error", code: "rate_limit_exceeded", message: "back off" }]);

		expect((error as ProviderHttpError).status).toBe(429);
		expect(error?.message).toBe("429 back off (rate_limit_exceeded)");
	});

	it("leaves a generic terminal server_error to the existing envelope format", async () => {
		// Azure reports terminal backend failures as `server_error` inside a 200
		// stream. The shared text rules already retry that wording, and tests pin
		// the `"<code>: <message>"` shape, so the probe must not reformat it.
		const error = await processEvents([
			{ type: "response.failed", response: { error: { code: "server_error", message: "backend exploded" } } },
		]);

		expect(error).toBeDefined();
		expect(error).not.toBeInstanceOf(ProviderHttpError);
		expect(error?.message).toBe("server_error: backend exploded");
	});

	it("leaves an unrelated error event untouched", async () => {
		const error = await processEvents([
			{ type: "error", error: { code: "context_length_exceeded", message: "Your input exceeds the limit" } },
		]);

		expect(error?.message).toBe("Error Code context_length_exceeded: Your input exceeds the limit");
		expect(error).not.toBeInstanceOf(ProviderHttpError);
	});

	it("classifies a throttle carried in a completed terminal envelope", async () => {
		// `response.completed` with `status: "failed"` reaches the third probe, which
		// also receives the whole envelope so a top-level `code` counts.
		const error = await processEvents([
			{
				type: "response.completed",
				response: { status: "failed", code: 429, error: { message: "Too many requests, retry later" } },
			},
		]);

		expect((error as ProviderHttpError).status).toBe(429);
		expect(retriable(classify(error))).toBe(true);
		expect(error?.message).toBe("429 Too many requests, retry later");
		expect(isAuthRetryableError(error)).toBe(false);
		expect(isUsageLimitOutcome(429, error?.message ?? "")).toBe(false);
	});
});
