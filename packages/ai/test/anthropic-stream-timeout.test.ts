import { afterEach, describe, expect, it, vi } from "bun:test";
import * as AIError from "@pk-nerdsaver-ai/pi-ai/error";
import { streamAnthropic } from "@pk-nerdsaver-ai/pi-ai/providers/anthropic";
import type { AnthropicMessagesClientLike } from "@pk-nerdsaver-ai/pi-ai/providers/anthropic-client";
import type { Context, Model } from "@pk-nerdsaver-ai/pi-ai/types";
import { buildModel } from "@pk-nerdsaver-ai/pi-catalog/build";
import { waitForDelayOrAbort } from "./helpers";

const model: Model<"anthropic-messages"> = buildModel({
	id: "claude-sonnet-4-5",
	name: "Claude Sonnet 4.5",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 8_192,
});

const context: Context = {
	messages: [{ role: "user", content: "Say hi", timestamp: Date.now() }],
};

type MockAnthropicEvent = Record<string, unknown>;
type MockAnthropicStream = AsyncIterable<MockAnthropicEvent>;

type MockAnthropicRequest = {
	withResponse(): Promise<{
		data: MockAnthropicStream;
		response: Response;
		request_id: string | null;
	}>;
};

async function waitForAbortAndThrowAbortError(signal: AbortSignal | undefined): Promise<never> {
	if (signal?.aborted) {
		throw new Error("Request was aborted.");
	}

	const { promise, reject } = Promise.withResolvers<void>();
	const onAbort = () => reject(new Error("Request was aborted."));
	signal?.addEventListener("abort", onAbort, { once: true });

	try {
		await promise;
		throw new Error("Anthropic mock stream unexpectedly resumed");
	} finally {
		signal?.removeEventListener("abort", onAbort);
	}
}

function createSuccessfulAnthropicEvents(text: string): MockAnthropicEvent[] {
	return [
		{
			type: "message_start",
			message: {
				id: "msg_retry_success",
				usage: {
					input_tokens: 12,
					output_tokens: 0,
					cache_read_input_tokens: 0,
					cache_creation_input_tokens: 0,
				},
			},
		},
		{
			type: "content_block_start",
			index: 0,
			content_block: { type: "text", text: "" },
		},
		{
			type: "content_block_delta",
			index: 0,
			delta: { type: "text_delta", text },
		},
		{ type: "content_block_stop", index: 0 },
		{
			type: "message_delta",
			delta: { stop_reason: "end_turn" },
			usage: {
				input_tokens: 12,
				output_tokens: 4,
				cache_read_input_tokens: 0,
				cache_creation_input_tokens: 0,
			},
		},
		{ type: "message_stop" },
	];
}

function createAnthropicMockStream({
	signal,
	connectDelayMs = 0,
	events,
	hangAfterEvents = false,
	onIteratorStart,
}: {
	signal: AbortSignal | undefined;
	connectDelayMs?: number;
	events?: MockAnthropicEvent[];
	hangAfterEvents?: boolean;
	onIteratorStart?: () => void;
}): MockAnthropicRequest {
	const response = new Response(null, {
		status: 200,
		headers: { "request-id": "req_mock" },
	});

	const stream: MockAnthropicStream = {
		async *[Symbol.asyncIterator]() {
			onIteratorStart?.();
			if (!events) {
				await waitForAbortAndThrowAbortError(signal);
				return;
			}
			for (const event of events) {
				yield event;
			}
			if (hangAfterEvents) {
				await waitForAbortAndThrowAbortError(signal);
			}
		},
	};

	return {
		async withResponse() {
			if (connectDelayMs > 0) {
				await waitForDelayOrAbort(connectDelayMs, signal);
			}
			return {
				data: stream,
				response,
				request_id: response.headers.get("request-id"),
			};
		},
	};
}

function createRejectedAnthropicRequest(error: Error): MockAnthropicRequest {
	return {
		async withResponse() {
			throw error;
		},
	};
}

type PromiseOutcome<T> = { kind: "fulfilled"; value: T } | { kind: "rejected"; error: unknown };

async function drainMicrotasksUntil(predicate: () => boolean, errorMessage: string): Promise<void> {
	for (let i = 0; i < 1000; i++) {
		if (predicate()) return;
		await Promise.resolve();
	}
	throw new Error(errorMessage);
}

async function resolveAfterMicrotasks<T>(promise: Promise<T>, errorMessage: string): Promise<T> {
	let outcome: PromiseOutcome<T> | undefined;
	promise.then(
		value => {
			outcome = { kind: "fulfilled", value };
		},
		error => {
			outcome = { kind: "rejected", error };
		},
	);
	for (let i = 0; i < 1000 && !outcome; i++) {
		await Promise.resolve();
	}
	if (!outcome) throw new Error(errorMessage);
	if (outcome.kind === "rejected") throw outcome.error;
	return outcome.value;
}

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("anthropic first-event timeout retries", () => {
	it("retries when the provider never sends the first stream event", async () => {
		vi.useFakeTimers();
		let attempt = 0;
		let firstAttemptIteratorStarted = false;
		const requestTimeouts: Array<number | undefined> = [];
		const requestMaxRetries: Array<number | undefined> = [];
		const create = ((
			_body: unknown,
			requestOptions?: { signal?: AbortSignal; timeout?: number; maxRetries?: number },
		) => {
			attempt += 1;
			requestTimeouts.push(requestOptions?.timeout);
			requestMaxRetries.push(requestOptions?.maxRetries);
			return createAnthropicMockStream({
				signal: requestOptions?.signal,
				events: attempt === 1 ? undefined : createSuccessfulAnthropicEvents("retry recovered"),
				onIteratorStart:
					attempt === 1
						? () => {
								firstAttemptIteratorStarted = true;
							}
						: undefined,
			}) as never;
		}) as unknown as AnthropicMessagesClientLike["messages"]["create"];
		const client = { messages: { create } } as AnthropicMessagesClientLike;
		const providerRetryWait = vi.fn(async (_delayMs: number, _signal: AbortSignal | undefined) => {});

		const resultPromise = streamAnthropic(model, context, {
			client,
			streamFirstEventTimeoutMs: 1,
			providerRetryWait,
		}).result();

		await drainMicrotasksUntil(
			() => firstAttemptIteratorStarted,
			"Anthropic mock stream did not enter the hung first attempt",
		);
		await drainMicrotasksUntil(() => vi.getTimerCount() > 0, "Anthropic first-event watchdog timer was not armed");
		expect(attempt).toBe(1);

		vi.advanceTimersByTime(1);
		const result = await resolveAfterMicrotasks(
			resultPromise,
			"Anthropic retry did not settle after the deterministic first-event timeout",
		);

		expect(attempt).toBe(2);
		expect(providerRetryWait).toHaveBeenCalledTimes(1);
		const retryDelayMs = providerRetryWait.mock.calls[0]?.[0];
		if (typeof retryDelayMs !== "number") {
			throw new Error("Expected provider retry wait delay");
		}
		expect(retryDelayMs).toBeGreaterThanOrEqual(375);
		expect(retryDelayMs).toBeLessThanOrEqual(500);
		expect(requestTimeouts).toEqual([1, 1]);
		expect(requestMaxRetries).toEqual([0, 0]);
		expect(result.stopReason).toBe("stop");
		expect(JSON.parse(JSON.stringify(result.content))).toEqual([{ type: "text", text: "retry recovered" }]);
		expect(result.responseId).toBe("msg_retry_success");
	});

	it("keeps the first-event watchdog armed when only pings arrive before message_start", async () => {
		vi.useFakeTimers();
		let attempt = 0;
		let firstAttemptIteratorStarted = false;
		const create = ((_body: unknown, requestOptions?: { signal?: AbortSignal }) => {
			attempt += 1;
			return createAnthropicMockStream({
				signal: requestOptions?.signal,
				events: attempt === 1 ? [{ type: "ping" }] : createSuccessfulAnthropicEvents("retry recovered"),
				hangAfterEvents: attempt === 1,
				onIteratorStart:
					attempt === 1
						? () => {
								firstAttemptIteratorStarted = true;
							}
						: undefined,
			}) as never;
		}) as unknown as AnthropicMessagesClientLike["messages"]["create"];
		const client = { messages: { create } } as AnthropicMessagesClientLike;
		const providerRetryWait = vi.fn(async () => {});

		const resultPromise = streamAnthropic(model, context, {
			client,
			streamFirstEventTimeoutMs: 1,
			streamIdleTimeoutMs: 60_000,
			providerRetryWait,
		}).result();

		await drainMicrotasksUntil(
			() => firstAttemptIteratorStarted,
			"Anthropic mock stream did not enter the ping-then-hang first attempt",
		);
		await drainMicrotasksUntil(() => vi.getTimerCount() > 0, "Anthropic watchdog timer was not armed");

		// A keepalive must not consume the first-event watchdog: if it did, the
		// stall would be classified as a (non-retryable) 60s idle timeout and
		// advancing 1ms would never settle the stream.
		vi.advanceTimersByTime(1);
		const result = await resolveAfterMicrotasks(
			resultPromise,
			"Anthropic ping-then-stall did not retry via the first-event watchdog",
		);

		expect(attempt).toBe(2);
		expect(result.stopReason).toBe("stop");
		expect(JSON.parse(JSON.stringify(result.content))).toEqual([{ type: "text", text: "retry recovered" }]);
	});

	it("does not arm the Anthropic first-event watchdog before the stream connects", async () => {
		let seenRequestTimeout: number | undefined;
		let seenRequestMaxRetries: number | undefined;
		const create = ((
			_body: unknown,
			requestOptions?: { signal?: AbortSignal; timeout?: number; maxRetries?: number },
		) => {
			seenRequestTimeout = requestOptions?.timeout;
			seenRequestMaxRetries = requestOptions?.maxRetries;
			return createAnthropicMockStream({
				signal: requestOptions?.signal,
				connectDelayMs: 2,
				events: createSuccessfulAnthropicEvents("delayed connect"),
			}) as never;
		}) as unknown as AnthropicMessagesClientLike["messages"]["create"];
		const client = { messages: { create } } as AnthropicMessagesClientLike;

		const result = await streamAnthropic(model, context, {
			client,
			streamFirstEventTimeoutMs: 20,
		}).result();

		expect(result.stopReason).toBe("stop");
		expect(seenRequestTimeout).toBe(20);
		expect(seenRequestMaxRetries).toBe(0);
		expect(JSON.parse(JSON.stringify(result.content))).toEqual([{ type: "text", text: "delayed connect" }]);
	});

	it("times out before the Anthropic stream connects and forwards the budget to the SDK request", async () => {
		let attempt = 0;
		const requestTimeouts: Array<number | undefined> = [];
		const requestMaxRetries: Array<number | undefined> = [];
		const create = ((
			_body: unknown,
			requestOptions?: { signal?: AbortSignal; timeout?: number; maxRetries?: number },
		) => {
			attempt += 1;
			requestTimeouts.push(requestOptions?.timeout);
			requestMaxRetries.push(requestOptions?.maxRetries);
			return createAnthropicMockStream({
				signal: requestOptions?.signal,
				connectDelayMs: 20,
				events: createSuccessfulAnthropicEvents("too late"),
			}) as never;
		}) as unknown as AnthropicMessagesClientLike["messages"]["create"];
		const client = { messages: { create } } as AnthropicMessagesClientLike;
		const providerRetryWait = vi.fn(async () => {});

		const result = await streamAnthropic(model, context, {
			client,
			streamFirstEventTimeoutMs: 1,
			providerRetryWait,
		}).result();

		expect(attempt).toBe(11);
		expect(providerRetryWait).toHaveBeenCalledTimes(10);
		expect(requestTimeouts).toEqual(new Array(11).fill(1));
		expect(requestMaxRetries).toEqual(new Array(11).fill(0));
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe("Anthropic stream timed out while waiting for the first event");
	});
	it("keeps caller aborts as aborted instead of retrying them as first-event timeouts", async () => {
		let attempt = 0;
		const create = ((_body: unknown, requestOptions?: { signal?: AbortSignal }) => {
			attempt += 1;
			return createAnthropicMockStream({ signal: requestOptions?.signal }) as never;
		}) as unknown as AnthropicMessagesClientLike["messages"]["create"];
		const client = { messages: { create } } as AnthropicMessagesClientLike;

		const controller = new AbortController();
		setTimeout(() => controller.abort(), 1);

		const result = await streamAnthropic(model, context, {
			client,
			signal: controller.signal,
			streamFirstEventTimeoutMs: 10,
		}).result();

		expect(attempt).toBe(1);
		expect(result.stopReason).toBe("aborted");
		expect(result.errorMessage).not.toBe("Anthropic stream timed out while waiting for the first event");
		expect((result.errorMessage ?? "").toLowerCase()).toContain("abort");
	});
	it("fails hung Anthropic streams between tool-call events instead of waiting forever", async () => {
		let attempt = 0;
		const create = ((_body: unknown, requestOptions?: { signal?: AbortSignal }) => {
			attempt += 1;
			return createAnthropicMockStream({
				signal: requestOptions?.signal,
				events: [
					{
						type: "message_start",
						message: {
							id: "msg_stalled_tool",
							usage: {
								input_tokens: 12,
								output_tokens: 0,
								cache_read_input_tokens: 0,
								cache_creation_input_tokens: 0,
							},
						},
					},
					{
						type: "content_block_start",
						index: 0,
						content_block: {
							type: "tool_use",
							id: "toolu_stalled_todo",
							name: "todo",
							input: {},
						},
					},
				],
				hangAfterEvents: true,
			}) as never;
		}) as unknown as AnthropicMessagesClientLike["messages"]["create"];
		const client = { messages: { create } } as AnthropicMessagesClientLike;
		const providerRetryWait = vi.fn(async () => {});

		const result = await streamAnthropic(model, context, {
			client,
			streamFirstEventTimeoutMs: 5000,
			streamIdleTimeoutMs: 50,
			providerRetryWait,
		}).result();

		expect(attempt).toBe(1);
		expect(providerRetryWait).not.toHaveBeenCalled();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe("Anthropic stream stalled while waiting for the next event");
		expect(JSON.parse(JSON.stringify(result.content))).toEqual([
			{
				type: "toolCall",
				id: "toolu_stalled_todo",
				name: "todo",
				arguments: {},
			},
		]);
	});
});

describe("anthropic provider retry delays", () => {
	it("waits at least the server-suggested retry-after before retrying a retryable API error", async () => {
		let attempt = 0;
		const create = ((_body: unknown, requestOptions?: { signal?: AbortSignal }) => {
			attempt += 1;
			if (attempt === 1) {
				return createRejectedAnthropicRequest(
					new AIError.AnthropicApiError(
						529,
						'529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
						new Headers({ "retry-after": "30" }),
					),
				) as never;
			}
			return createAnthropicMockStream({
				signal: requestOptions?.signal,
				events: createSuccessfulAnthropicEvents("after backoff"),
			}) as never;
		}) as unknown as AnthropicMessagesClientLike["messages"]["create"];
		const client = { messages: { create } } as AnthropicMessagesClientLike;
		const providerRetryWait = vi.fn(async () => {});

		const result = await streamAnthropic(model, context, { client, providerRetryWait }).result();

		// Header says 30s; the 2s exponential backoff must not undercut it.
		expect(attempt).toBe(2);
		expect(providerRetryWait).toHaveBeenCalledWith(30_000, undefined);
		expect(result.stopReason).toBe("stop");
		expect(JSON.parse(JSON.stringify(result.content))).toEqual([{ type: "text", text: "after backoff" }]);
	});

	it("retries transient TLS server errors before surfacing them to the session", async () => {
		let attempt = 0;
		const create = ((_body: unknown, requestOptions?: { signal?: AbortSignal }) => {
			attempt += 1;
			if (attempt === 1) {
				return createRejectedAnthropicRequest(
					new Error(
						'Post "https://api.anthropic.com/v1/messages?beta=true": remote error: tls: bad record MAC (type=server_error)',
					),
				) as never;
			}
			return createAnthropicMockStream({
				signal: requestOptions?.signal,
				events: createSuccessfulAnthropicEvents("recovered from tls retry"),
			}) as never;
		}) as unknown as AnthropicMessagesClientLike["messages"]["create"];
		const client = { messages: { create } } as AnthropicMessagesClientLike;
		const providerRetryWait = vi.fn(async (_delayMs: number, _signal: AbortSignal | undefined) => {});

		const result = await streamAnthropic(model, context, { client, providerRetryWait }).result();

		expect(attempt).toBe(2);
		expect(providerRetryWait).toHaveBeenCalledTimes(1);
		expect(result.stopReason).toBe("stop");
		expect(JSON.parse(JSON.stringify(result.content))).toEqual([{ type: "text", text: "recovered from tls retry" }]);
	});

	it("does not retry permanent TLS configuration failures", async () => {
		let attempt = 0;
		const create = ((_body: unknown) => {
			attempt += 1;
			return createRejectedAnthropicRequest(new Error("tls: failed to verify certificate")) as never;
		}) as unknown as AnthropicMessagesClientLike["messages"]["create"];
		const client = { messages: { create } } as AnthropicMessagesClientLike;
		const providerRetryWait = vi.fn(async (_delayMs: number, _signal: AbortSignal | undefined) => {});

		const result = await streamAnthropic(model, context, { client, providerRetryWait }).result();

		expect(attempt).toBe(1);
		expect(providerRetryWait).not.toHaveBeenCalled();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("tls: failed to verify certificate");
	});

	it("retries 502s ten times with Anthropic-style capped backoff", async () => {
		vi.spyOn(Math, "random").mockReturnValue(0);
		let attempt = 0;
		const create = ((_body: unknown, requestOptions?: { signal?: AbortSignal }) => {
			attempt += 1;
			if (attempt <= 10) {
				return createRejectedAnthropicRequest(
					new AIError.AnthropicApiError(502, "502 Bad Gateway", new Headers()),
				) as never;
			}
			return createAnthropicMockStream({
				signal: requestOptions?.signal,
				events: createSuccessfulAnthropicEvents("recovered from 502"),
			}) as never;
		}) as unknown as AnthropicMessagesClientLike["messages"]["create"];
		const client = { messages: { create } } as AnthropicMessagesClientLike;
		const providerRetryWait = vi.fn(async (_delayMs: number, _signal: AbortSignal | undefined) => {});

		const result = await streamAnthropic(model, context, { client, providerRetryWait }).result();

		expect(attempt).toBe(11);
		expect(providerRetryWait.mock.calls.map(call => call[0])).toEqual([
			500, 1000, 2000, 4000, 8000, 8000, 8000, 8000, 8000, 8000,
		]);
		expect(result.stopReason).toBe("stop");
		expect(JSON.parse(JSON.stringify(result.content))).toEqual([{ type: "text", text: "recovered from 502" }]);
	});
});
