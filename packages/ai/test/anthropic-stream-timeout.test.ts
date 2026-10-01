import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { streamAnthropic } from "@oh-my-pi/pi-ai/providers/anthropic";
import { AnthropicMessagesClient, type AnthropicMessagesClientLike } from "@oh-my-pi/pi-ai/providers/anthropic-client";
import type { Context, FetchImpl, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
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

function createAnthropicSseResponse(text: string): Response {
	const body = createSuccessfulAnthropicEvents(text)
		.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
		.join("");
	return new Response(body, {
		status: 200,
		headers: { "content-type": "text/event-stream", "request-id": "req_retry_success" },
	});
}

function createResponseClient(responses: Response[]): {
	calls: { count: number };
	client: AnthropicMessagesClientLike;
} {
	const calls = { count: 0 };
	const fetch: FetchImpl = async () => {
		const response = responses[Math.min(calls.count++, responses.length - 1)];
		if (!response) throw new Error("Expected an Anthropic mock response");
		return new Response(response.body, {
			status: response.status,
			statusText: response.statusText,
			headers: response.headers,
		});
	};
	return {
		calls,
		client: new AnthropicMessagesClient({ apiKey: "sk-test", maxRetries: 0, fetch }),
	};
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

const STREAM_TIMEOUT_ENV_KEYS = [
	"PI_STREAM_IDLE_TIMEOUT_MS",
	"PI_OPENAI_STREAM_IDLE_TIMEOUT_MS",
	"PI_STREAM_FIRST_EVENT_TIMEOUT_MS",
] as const;

type StreamTimeoutEnvKey = (typeof STREAM_TIMEOUT_ENV_KEYS)[number];

const originalStreamTimeoutEnv: Record<StreamTimeoutEnvKey, string | undefined> = {
	PI_STREAM_IDLE_TIMEOUT_MS: undefined,
	PI_OPENAI_STREAM_IDLE_TIMEOUT_MS: undefined,
	PI_STREAM_FIRST_EVENT_TIMEOUT_MS: undefined,
};

beforeEach(() => {
	for (const key of STREAM_TIMEOUT_ENV_KEYS) {
		originalStreamTimeoutEnv[key] = Bun.env[key];
		delete Bun.env[key];
	}
});

afterEach(() => {
	for (const key of STREAM_TIMEOUT_ENV_KEYS) {
		const previous = originalStreamTimeoutEnv[key];
		if (previous === undefined) {
			delete Bun.env[key];
		} else {
			Bun.env[key] = previous;
		}
	}

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
		// oxlint-disable-next-line unicorn/no-new-array -- length preallocation
		expect(requestTimeouts).toEqual(new Array(11).fill(1));
		// oxlint-disable-next-line unicorn/no-new-array -- length preallocation
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

describe("anthropic model compat stream idle timeout floor", () => {
	const baseModel = {
		id: "claude-sonnet-4-5",
		name: "Claude Sonnet 4.5",
		api: "anthropic-messages" as const,
		provider: "anthropic",
		baseUrl: "https://api.anthropic.com",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 8_192,
	} satisfies Parameters<typeof buildModel>[0];

	function createStalledAfterFirstEventClient(onIteratorStart?: () => void): {
		attempt: () => number;
		client: AnthropicMessagesClientLike;
	} {
		let attempt = 0;
		const create = ((_body: unknown, requestOptions?: { signal?: AbortSignal }) => {
			attempt += 1;
			return createAnthropicMockStream({
				signal: requestOptions?.signal,
				events: [
					{
						type: "message_start",
						message: {
							id: "msg_compat_stall",
							usage: {
								input_tokens: 12,
								output_tokens: 0,
								cache_read_input_tokens: 0,
								cache_creation_input_tokens: 0,
							},
						},
					},
				],
				hangAfterEvents: true,
				onIteratorStart,
			}) as never;
		}) as unknown as AnthropicMessagesClientLike["messages"]["create"];
		return { attempt: () => attempt, client: { messages: { create } } as AnthropicMessagesClientLike };
	}

	it("uses model.compat.streamIdleTimeoutMs as the idle floor when no caller option is set", async () => {
		const compatModel = buildModel({ ...baseModel, compat: { streamIdleTimeoutMs: 50 } });
		const { attempt, client } = createStalledAfterFirstEventClient();

		const result = await streamAnthropic(compatModel, context, {
			client,
			streamFirstEventTimeoutMs: 5_000,
		}).result();

		expect(attempt()).toBe(1);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe("Anthropic stream stalled while waiting for the next event");
	});

	it("disables the idle watchdog when model.compat.streamIdleTimeoutMs is 0", async () => {
		vi.useFakeTimers();
		const compatModel = buildModel({ ...baseModel, compat: { streamIdleTimeoutMs: 0 } });
		const controller = new AbortController();
		let iteratorStarted = false;
		const { attempt, client } = createStalledAfterFirstEventClient(() => {
			iteratorStarted = true;
		});

		let settled = false;
		const resultPromise = streamAnthropic(compatModel, context, {
			client,
			signal: controller.signal,
			// First-event watchdog stays out of this case's scope: it would need to
			// be cleared by the mock's first event, and fake-timer advancement can
			// outrun the microtask that consumes that event under filtered runs.
			streamFirstEventTimeoutMs: 0,
		}).result();
		void resultPromise.then(
			() => {
				settled = true;
			},
			() => {
				settled = true;
			},
		);

		await drainMicrotasksUntil(
			() => iteratorStarted,
			"Anthropic mock stream did not start for the compat-disabled watchdog test",
		);
		// Well past the default 300s idle floor: the disabled watchdog must not
		// classify the post-first-event silence as a stall.
		vi.advanceTimersByTime(400_000);
		await drainMicrotasksUntil(
			() => vi.getTimerCount() === 0,
			"Anthropic watchdog timer did not drain after advancing past the idle budget",
		);
		expect(settled).toBe(false);
		expect(attempt()).toBe(1);

		controller.abort();
		const result = await resolveAfterMicrotasks(
			resultPromise,
			"Anthropic compat-disabled stream did not settle after the caller aborted",
		);
		expect(result.stopReason).toBe("aborted");
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

describe("anthropic retry-after cap (maxRetryDelayMs)", () => {
	it("surfaces the original HTTP error without a second attempt when retry-after exceeds the default 60s cap", async () => {
		const { calls, client } = createResponseClient([
			new Response('{"type":"error","error":{"type":"rate_limit_error","message":"Too many requests"}}', {
				status: 429,
				headers: { "retry-after": "120" },
			}),
		]);
		const providerRetryWait = vi.fn(async () => {});

		const result = await streamAnthropic(model, context, { client, providerRetryWait }).result();

		expect(calls.count).toBe(1);
		expect(providerRetryWait).not.toHaveBeenCalled();
		expect(result.stopReason).toBe("error");
		expect(result.errorStatus).toBe(429);
		expect(result.errorMessage).toContain("rate_limit_error");
	});

	it("surfaces the original HTTP error when retry-after exceeds an explicit cap", async () => {
		const { calls, client } = createResponseClient([
			new Response('{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}', {
				status: 529,
				headers: { "retry-after-ms": "10000" },
			}),
		]);
		const providerRetryWait = vi.fn(async () => {});

		const result = await streamAnthropic(model, context, {
			client,
			providerRetryWait,
			maxRetryDelayMs: 5_000,
		}).result();

		expect(calls.count).toBe(1);
		expect(providerRetryWait).not.toHaveBeenCalled();
		expect(result.stopReason).toBe("error");
		expect(result.errorStatus).toBe(529);
	});

	it("disables the cap when maxRetryDelayMs is negative", async () => {
		const { calls, client } = createResponseClient([
			new Response('{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}', {
				status: 529,
				headers: { "retry-after": "1" },
			}),
			createAnthropicSseResponse("after unbounded wait"),
		]);
		const providerRetryWait = vi.fn(async () => {});

		const result = await streamAnthropic(model, context, {
			client,
			providerRetryWait,
			maxRetryDelayMs: -1,
		}).result();

		expect(calls.count).toBe(2);
		expect(providerRetryWait).toHaveBeenCalledWith(1_000, undefined);
		expect(result.stopReason).toBe("stop");
	});

	it("disables the cap when maxRetryDelayMs is 0 and waits the full server hint", async () => {
		const { calls, client } = createResponseClient([
			new Response('{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}', {
				status: 529,
				headers: { "retry-after": "120" },
			}),
			createAnthropicSseResponse("after long wait"),
		]);
		const providerRetryWait = vi.fn(async () => {});

		const result = await streamAnthropic(model, context, {
			client,
			providerRetryWait,
			maxRetryDelayMs: 0,
		}).result();

		expect(calls.count).toBe(2);
		expect(providerRetryWait).toHaveBeenCalledWith(120_000, undefined);
		expect(result.stopReason).toBe("stop");
	});

	it("retries when the HTTP retry-after hint is under the cap", async () => {
		const { calls, client } = createResponseClient([
			new Response('{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}', {
				status: 529,
				headers: { "retry-after": "30" },
			}),
			createAnthropicSseResponse("after backoff"),
		]);
		const providerRetryWait = vi.fn(async () => {});

		const result = await streamAnthropic(model, context, {
			client,
			providerRetryWait,
			maxRetryDelayMs: 60_000,
		}).result();

		expect(calls.count).toBe(2);
		expect(providerRetryWait).toHaveBeenCalledWith(30_000, undefined);
		expect(result.stopReason).toBe("stop");
	});

	it("honors retry headers from structurally compatible injected SDK errors", async () => {
		let attempt = 0;
		const error = Object.assign(new Error("529 overloaded"), {
			status: 529,
			headers: new Headers({ "retry-after-ms": "10000" }),
		});
		const create = ((_body: unknown) => {
			attempt += 1;
			return createRejectedAnthropicRequest(error) as never;
		}) as unknown as AnthropicMessagesClientLike["messages"]["create"];
		const providerRetryWait = vi.fn(async () => {});

		const result = await streamAnthropic(model, context, {
			client: { messages: { create } },
			providerRetryWait,
			maxRetryDelayMs: 5_000,
		}).result();

		expect(attempt).toBe(1);
		expect(providerRetryWait).not.toHaveBeenCalled();
		expect(result.stopReason).toBe("error");
		expect(result.errorStatus).toBe(529);
	});

	it("honors record-valued retry headers from injected SDK errors", async () => {
		let attempt = 0;
		const error = Object.assign(new Error("529 overloaded"), {
			status: 529,
			headers: { "Retry-After-Ms": "10000" },
		});
		const create = ((_body: unknown) => {
			attempt += 1;
			return createRejectedAnthropicRequest(error) as never;
		}) as unknown as AnthropicMessagesClientLike["messages"]["create"];
		const providerRetryWait = vi.fn(async () => {});

		const result = await streamAnthropic(model, context, {
			client: { messages: { create } },
			providerRetryWait,
			maxRetryDelayMs: 5_000,
		}).result();

		expect(attempt).toBe(1);
		expect(providerRetryWait).not.toHaveBeenCalled();
		expect(result.stopReason).toBe("error");
		expect(result.errorStatus).toBe(529);
	});

	it("honors nested response retry headers from injected SDK errors", async () => {
		let attempt = 0;
		const error = Object.assign(new Error("529 overloaded"), {
			response: { status: 529, headers: { "retry-after-ms": "10000" } },
		});
		const create = ((_body: unknown) => {
			attempt += 1;
			return createRejectedAnthropicRequest(error) as never;
		}) as unknown as AnthropicMessagesClientLike["messages"]["create"];
		const providerRetryWait = vi.fn(async () => {});

		const result = await streamAnthropic(model, context, {
			client: { messages: { create } },
			providerRetryWait,
			maxRetryDelayMs: 5_000,
		}).result();

		expect(attempt).toBe(1);
		expect(providerRetryWait).not.toHaveBeenCalled();
		expect(result.stopReason).toBe("error");
		expect(result.errorStatus).toBe(529);
	});

	it("passes maxRetryDelayMs to internally constructed Anthropic clients", async () => {
		let calls = 0;
		const fetch: FetchImpl = async () => {
			calls += 1;
			return new Response('{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}', {
				status: 429,
				headers: { "retry-after-ms": "10" },
			});
		};

		const result = await streamAnthropic(model, context, { fetch, maxRetryDelayMs: 5 }).result();

		expect(calls).toBe(1);
		expect(result.stopReason).toBe("error");
		expect(result.errorStatus).toBe(429);
	});
});
