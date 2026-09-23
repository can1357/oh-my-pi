// Regression coverage for gateways (OpenRouter, Vercel AI Gateway, …) that
// report upstream model failures as a bare `finish_reason: "error"` — e.g.
// Gemini MALFORMED_FUNCTION_CALL behind an OpenAI-compat endpoint. The mapped
// error message must match the session retry classifier's transient-transport
// pattern (`provider.?returned.?error` in agent-session's
// #isTransientTransportErrorMessage) so the turn is auto-retried instead of
// stopping with a pinned error banner.
import { describe, expect, it } from "bun:test";
import { streamOpenAICompletions } from "@oh-my-pi/pi-ai/providers/openai-completions";
import type { Context, FetchImpl, Model } from "@oh-my-pi/pi-ai/types";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";

// Mirrors the transient-transport alternative the session retry gate matches on.
const RETRYABLE_PATTERN = /provider.?returned.?error/i;

const completionsModel = {
	...(getBundledModel("openai", "gpt-4o-mini") as Model<"openai-completions">),
	api: "openai-completions",
} satisfies Model<"openai-completions">;

function baseContext(): Context {
	return {
		messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
	};
}

function createSseFetch(events: unknown[]): FetchImpl {
	async function mockFetch(_input: string | URL | Request, _init?: RequestInit): Promise<Response> {
		const encoder = new TextEncoder();
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				for (const event of events) {
					const data = typeof event === "string" ? event : JSON.stringify(event);
					controller.enqueue(encoder.encode(`data: ${data}\n\n`));
				}
				controller.close();
			},
		});
		return new Response(stream, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});
	}
	return mockFetch as typeof fetch;
}

function completionChunk(extra: Record<string, unknown>): unknown {
	return {
		id: "chatcmpl-error-finish",
		object: "chat.completion.chunk",
		created: 0,
		model: completionsModel.id,
		...extra,
	};
}

describe("finish_reason: error", () => {
	it("maps to a retryable error message", async () => {
		const fetchMock = createSseFetch([
			completionChunk({ choices: [{ index: 0, delta: { role: "assistant", content: "Hel" } }] }),
			completionChunk({ choices: [{ index: 0, delta: {}, finish_reason: "error" }] }),
			"[DONE]",
		]);

		const result = await streamOpenAICompletions(completionsModel, baseContext(), {
			apiKey: "test-key",
			fetch: fetchMock,
		}).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toMatch(RETRYABLE_PATTERN);
	}, 10_000);

	it("stays an error even when the stream carried tool calls", async () => {
		// The user-visible failure mode: the model garbles a tool call, the
		// gateway ends the stream with `finish_reason: "error"`. Tool-call
		// promotion (stop → toolUse) must not paper over the error finish.
		const fetchMock = createSseFetch([
			completionChunk({
				choices: [
					{
						index: 0,
						delta: {
							role: "assistant",
							tool_calls: [
								{
									index: 0,
									id: "call_1",
									type: "function",
									function: { name: "read", arguments: '{"pattern":"x"}' },
								},
							],
						},
					},
				],
			}),
			completionChunk({ choices: [{ index: 0, delta: {}, finish_reason: "error" }] }),
			"[DONE]",
		]);

		const result = await streamOpenAICompletions(completionsModel, baseContext(), {
			apiKey: "test-key",
			fetch: fetchMock,
		}).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toMatch(RETRYABLE_PATTERN);
	}, 10_000);
});

describe("in-band SSE error envelope", () => {
	it("surfaces a queue-full error carried inside a successful HTTP stream", async () => {
		const fetchMock = createSseFetch([
			{
				error: {
					object: "error",
					message: "The request queue is full.",
					type: "SERVICE_UNAVAILABLE",
					param: null,
					code: 503,
				},
			},
			"[DONE]",
		]);

		const result = await streamOpenAICompletions(completionsModel, baseContext(), {
			apiKey: "test-key",
			fetch: fetchMock,
		}).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorStatus).toBe(503);
		expect(result.errorMessage).toContain("The request queue is full.");
	}, 10_000);

	it("surfaces a flat error string carried inside a successful HTTP stream", async () => {
		const fetchMock = createSseFetch([{ error: "rate limit exceeded" }, "[DONE]"]);

		const result = await streamOpenAICompletions(completionsModel, baseContext(), {
			apiKey: "test-key",
			fetch: fetchMock,
		}).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("rate limit exceeded");
	}, 10_000);

	it("surfaces a flat message-only error carried inside a successful HTTP stream", async () => {
		const fetchMock = createSseFetch([{ message: "provider temporarily unavailable" }, "[DONE]"]);

		const result = await streamOpenAICompletions(completionsModel, baseContext(), {
			apiKey: "test-key",
			fetch: fetchMock,
		}).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("provider temporarily unavailable");
	}, 10_000);

	it("does not replay after content precedes an in-band error", async () => {
		let attempts = 0;
		const baseFetch = createSseFetch([
			completionChunk({ choices: [{ index: 0, delta: { role: "assistant", content: "Partial" } }] }),
			{
				error: {
					message: "Request timed out in the queue.",
					type: "REQUEST_TIMEOUT",
				},
			},
			"[DONE]",
		]);
		const fetchMock: FetchImpl = async (input, init) => {
			attempts++;
			return baseFetch(input, init);
		};

		const result = await streamOpenAICompletions(completionsModel, baseContext(), {
			apiKey: "test-key",
			fetch: fetchMock,
		}).result();

		expect(attempts).toBe(1);
		expect(result.stopReason).toBe("error");
		expect(result.errorStatus).toBe(408);
		expect(result.content).toEqual([{ type: "text", text: "Partial" }]);
	}, 10_000);
});

describe("finish_reason: insufficient_system_resource", () => {
	// DeepSeek interrupts the generation mid-stream when its inference system
	// runs out of resources; the terminal chunk carries
	// `finish_reason: "insufficient_system_resource"`. It must surface as a
	// retryable provider error — never as a clean `stop`.
	it("maps to a retryable error message", async () => {
		const fetchMock = createSseFetch([
			completionChunk({ choices: [{ index: 0, delta: { role: "assistant", content: "Hel" } }] }),
			completionChunk({ choices: [{ index: 0, delta: {}, finish_reason: "insufficient_system_resource" }] }),
			"[DONE]",
		]);

		const result = await streamOpenAICompletions(completionsModel, baseContext(), {
			apiKey: "test-key",
			fetch: fetchMock,
		}).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toMatch(RETRYABLE_PATTERN);
	}, 10_000);
});

describe("premature stream closure", () => {
	// The connection dies mid-generation without any `finish_reason` chunk
	// (DeepSeek insufficient-system-resource interruption, flaky gateway).
	// Before the guard, the partial message finalized as a clean `stop` and
	// the agent loop treated the truncated turn as complete — the silent
	// mid-sentence halt. Now it must surface as an error turn.
	it("fails the turn instead of silently stopping", async () => {
		const fetchMock = createSseFetch([
			completionChunk({ choices: [{ index: 0, delta: { role: "assistant", content: "Hel" } }] }),
			completionChunk({ choices: [{ index: 0, delta: { content: "lo" } }] }),
		]);

		const eventTypes: string[] = [];
		let errorMessage: string | undefined;
		for await (const event of streamOpenAICompletions(completionsModel, baseContext(), {
			apiKey: "test-key",
			fetch: fetchMock,
		})) {
			eventTypes.push(event.type);
			if (event.type === "error") errorMessage = event.error.errorMessage;
		}

		expect(eventTypes).toEqual(["start", "text_start", "text_delta", "text_delta", "text_end", "error"]);
		expect(errorMessage).toContain("finish_reason");
	}, 10_000);

	it("still retries a genuinely empty close via the empty-completion path", async () => {
		// Zero content + no finish_reason is the flaky-gateway empty completion:
		// it stays a clean `stop` so withEmptyCompletionRetry can re-sample
		// instead of failing outright.
		let attempts = 0;
		async function fetchMock(_input: string | URL | Request, _init?: RequestInit): Promise<Response> {
			attempts++;
			const events =
				attempts === 1
					? []
					: [
							completionChunk({ choices: [{ index: 0, delta: { role: "assistant", content: "Hi" } }] }),
							completionChunk({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
							"[DONE]",
						];
			const encoder = new TextEncoder();
			const stream = new ReadableStream<Uint8Array>({
				start(controller) {
					for (const event of events) {
						const data = typeof event === "string" ? event : JSON.stringify(event);
						controller.enqueue(encoder.encode(`data: ${data}\n\n`));
					}
					controller.close();
				},
			});
			return new Response(stream, {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			});
		}

		const result = await streamOpenAICompletions(completionsModel, baseContext(), {
			apiKey: "test-key",
			fetch: fetchMock as typeof fetch,
		}).result();

		expect(attempts).toBeGreaterThan(1);
		expect(result.stopReason).toBe("stop");
		expect(result.content).toEqual([{ type: "text", text: "Hi" }]);
	}, 10_000);
});

describe("uppercase finish_reason", () => {
	// Some OpenAI-compatible gateways fronting Gemini backends emit the native
	// uppercase reasons (`STOP`, `MAX_TOKENS`) instead of the lowercase OpenAI
	// contract values. `mapStopReason` must fold case and map `MAX_TOKENS` to
	// `length`, not surface a clean completion as an error.
	it("maps STOP to a clean stop", async () => {
		const fetchMock = createSseFetch([
			completionChunk({ choices: [{ index: 0, delta: { role: "assistant", content: "Hel" } }] }),
			completionChunk({ choices: [{ index: 0, delta: {}, finish_reason: "STOP" }] }),
			"[DONE]",
		]);

		const result = await streamOpenAICompletions(completionsModel, baseContext(), {
			apiKey: "test-key",
			fetch: fetchMock,
		}).result();

		expect(result.stopReason).toBe("stop");
		expect(result.errorMessage).toBeUndefined();
	}, 10_000);

	it("maps MAX_TOKENS to length", async () => {
		const fetchMock = createSseFetch([
			completionChunk({ choices: [{ index: 0, delta: { role: "assistant", content: "Hel" } }] }),
			completionChunk({ choices: [{ index: 0, delta: {}, finish_reason: "MAX_TOKENS" }] }),
			"[DONE]",
		]);

		const result = await streamOpenAICompletions(completionsModel, baseContext(), {
			apiKey: "test-key",
			fetch: fetchMock,
		}).result();

		expect(result.stopReason).toBe("length");
		expect(result.errorMessage).toBeUndefined();
	}, 10_000);
});

describe("non-string finish_reason", () => {
	// A malformed provider SSE can put a non-string `finish_reason` on the
	// chunk. Folding case must not throw on it — it falls through to the
	// unknown-reason error path with the original value surfaced.
	it("falls through to an error instead of throwing", async () => {
		const fetchMock = createSseFetch([
			completionChunk({ choices: [{ index: 0, delta: { role: "assistant", content: "Hel" } }] }),
			completionChunk({ choices: [{ index: 0, delta: {}, finish_reason: 42 }] }),
			"[DONE]",
		]);

		const result = await streamOpenAICompletions(completionsModel, baseContext(), {
			apiKey: "test-key",
			fetch: fetchMock,
		}).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe("Provider finish_reason: 42");
	}, 10_000);
});
