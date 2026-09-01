/**
 * Contracts for replay-safe provider retries: empty and transient pre-output
 * attempts are bounded and discarded, while emitted content commits an attempt
 * so output is never duplicated.
 */
import { describe, expect, it } from "bun:test";
import type { AssistantMessage, AssistantMessageEvent, Context, Usage } from "@oh-my-pi/pi-ai/types";
import { MAX_EMPTY_COMPLETION_RETRIES, withReplaySafeStreamRetry } from "@oh-my-pi/pi-ai/utils/empty-completion-retry";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";

const CTX = {} as Context;

function usage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function assistant(texts: string[] = []): AssistantMessage {
	return {
		role: "assistant",
		content: texts.map(text => ({ type: "text" as const, text })),
		api: "openai-completions",
		provider: "test",
		model: "test-model",
		timestamp: 1,
		stopReason: "stop",
		usage: usage(),
	};
}

function streamFromEvents(events: AssistantMessageEvent[]): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	for (const event of events) stream.push(event);
	return stream;
}

/** start + stop with no content/usage — the flaky-gateway empty completion. */
function emptyAttempt(): AssistantMessageEventStream {
	const message = assistant();
	return streamFromEvents([
		{ type: "start", partial: message },
		{ type: "done", reason: "stop", message },
	] as unknown as AssistantMessageEvent[]);
}

/** start + stop with no visible content and a single EOS output token. */
function eosOnlyAttempt(): AssistantMessageEventStream {
	const message = assistant();
	message.usage.output = 1;
	message.usage.totalTokens = 1;
	return streamFromEvents([
		{ type: "start", partial: message },
		{ type: "done", reason: "stop", message },
	] as unknown as AssistantMessageEvent[]);
}

function contentAttempt(): AssistantMessageEventStream {
	const message = assistant(["hello"]);
	return streamFromEvents([
		{ type: "start", partial: message },
		{ type: "text_start", contentIndex: 0, partial: message },
		{ type: "text_delta", contentIndex: 0, delta: "hello", partial: message },
		{ type: "text_end", contentIndex: 0, content: "hello", partial: message },
		{ type: "done", reason: "stop", message },
	] as unknown as AssistantMessageEvent[]);
}

async function drain(stream: AssistantMessageEventStream): Promise<AssistantMessageEvent[]> {
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) events.push(event);
	return events;
}

describe("withReplaySafeStreamRetry", () => {
	it("retries past empty attempts and delivers the first non-empty one", async () => {
		let attempts = 0;
		const waits: number[] = [];
		const stream = withReplaySafeStreamRetry(
			{},
			CTX,
			{ providerRetryWait: async ms => void waits.push(ms) },
			() => {
				attempts++;
				return attempts <= MAX_EMPTY_COMPLETION_RETRIES ? emptyAttempt() : contentAttempt();
			},
			{ retryEmptyCompletion: true },
		);

		const events = await drain(stream);
		const result = await stream.result();

		expect(attempts).toBe(MAX_EMPTY_COMPLETION_RETRIES + 1);
		expect(waits).toHaveLength(MAX_EMPTY_COMPLETION_RETRIES);
		// Discarded attempts' `start` events must not leak — exactly one survives.
		expect(events.filter(e => e.type === "start")).toHaveLength(1);
		expect(events.some(e => e.type === "text_delta")).toBe(true);
		expect(events.at(-1)?.type).toBe("done");
		expect(result.content).toEqual([{ type: "text", text: "hello" }]);
	});

	it("retries an EOS-only empty stop that reports one output token", async () => {
		let attempts = 0;
		const waits: number[] = [];
		const stream = withReplaySafeStreamRetry(
			{},
			CTX,
			{ providerRetryWait: async ms => void waits.push(ms) },
			() => {
				attempts++;
				return attempts === 1 ? eosOnlyAttempt() : contentAttempt();
			},
			{ retryEmptyCompletion: true },
		);

		const events = await drain(stream);
		const result = await stream.result();

		expect(attempts).toBe(2);
		expect(waits).toEqual([500]);
		expect(events.filter(e => e.type === "start")).toHaveLength(1);
		expect(result.content).toEqual([{ type: "text", text: "hello" }]);
	});

	it("delivers the empty result after exhausting the retry cap", async () => {
		let attempts = 0;
		const waits: number[] = [];
		const stream = withReplaySafeStreamRetry(
			{},
			CTX,
			{ providerRetryWait: async ms => void waits.push(ms) },
			() => {
				attempts++;
				return emptyAttempt();
			},
			{ retryEmptyCompletion: true },
		);

		const events = await drain(stream);
		const result = await stream.result();

		expect(attempts).toBe(MAX_EMPTY_COMPLETION_RETRIES + 1);
		expect(waits).toHaveLength(MAX_EMPTY_COMPLETION_RETRIES);
		expect(events.filter(e => e.type === "start")).toHaveLength(1);
		expect(events.at(-1)?.type).toBe("done");
		expect(result.content).toEqual([]);
	});

	it("does not retry an empty pause_turn completion", async () => {
		let attempts = 0;
		const waits: number[] = [];
		const stream = withReplaySafeStreamRetry(
			{},
			CTX,
			{ providerRetryWait: async ms => void waits.push(ms) },
			() => {
				attempts++;
				const message = assistant();
				message.stopDetails = { type: "pause_turn" };
				return streamFromEvents([
					{ type: "start", partial: message },
					{ type: "done", reason: "stop", message },
				] as unknown as AssistantMessageEvent[]);
			},
			{ retryEmptyCompletion: true },
		);

		const events = await drain(stream);
		const result = await stream.result();

		expect(attempts).toBe(1);
		expect(waits).toEqual([]);
		expect(events.filter(event => event.type === "start")).toHaveLength(1);
		expect(result.stopDetails).toEqual({ type: "pause_turn" });
	});

	it("does not retry when the first attempt streams content", async () => {
		let attempts = 0;
		let waited = false;
		const stream = withReplaySafeStreamRetry(
			{},
			CTX,
			{
				providerRetryWait: async () => {
					waited = true;
				},
			},
			() => {
				attempts++;
				return contentAttempt();
			},
			{ retryEmptyCompletion: true },
		);

		await drain(stream);

		expect(attempts).toBe(1);
		expect(waited).toBe(false);
	});

	it("commits on streamed thinking and does not retry a thinking-only stop", async () => {
		let attempts = 0;
		const stream = withReplaySafeStreamRetry(
			{},
			CTX,
			{},
			() => {
				attempts++;
				const message = assistant(); // no visible content; only thinking streams
				return streamFromEvents([
					{ type: "start", partial: message },
					{ type: "thinking_delta", contentIndex: 0, delta: "pondering", partial: message },
					{ type: "done", reason: "stop", message },
				] as unknown as AssistantMessageEvent[]);
			},
			{ retryEmptyCompletion: true },
		);

		const events = await drain(stream);

		expect(attempts).toBe(1);
		expect(events.some(e => e.type === "thinking_delta")).toBe(true);
	});

	it("propagates a non-abort backoff failure instead of masking the empty result", async () => {
		const stream = withReplaySafeStreamRetry(
			{},
			CTX,
			{
				providerRetryWait: async () => {
					throw new Error("wait boom");
				},
			},
			() => emptyAttempt(),
			{ retryEmptyCompletion: true },
		);

		let caught: unknown;
		try {
			await drain(stream);
		} catch (error) {
			caught = error;
		}
		expect((caught as Error | undefined)?.message).toBe("wait boom");
	});

	it("delivers the empty result when aborted during backoff", async () => {
		const controller = new AbortController();
		let attempts = 0;
		const stream = withReplaySafeStreamRetry(
			{},
			CTX,
			{
				signal: controller.signal,
				providerRetryWait: async () => {
					controller.abort();
					throw new Error("aborted");
				},
			},
			() => {
				attempts++;
				return emptyAttempt();
			},
			{ retryEmptyCompletion: true },
		);

		const events = await drain(stream);
		const result = await stream.result();

		expect(attempts).toBe(1);
		expect(events.at(-1)?.type).toBe("done");
		expect(result.content).toEqual([]);
	});

	it("discards buffered pre-content markers from a retried empty attempt", async () => {
		let attempts = 0;
		const stream = withReplaySafeStreamRetry(
			{},
			CTX,
			{ providerRetryWait: async () => {} },
			() => {
				attempts++;
				if (attempts === 1) {
					const message = assistant();
					return streamFromEvents([
						{ type: "start", partial: message },
						{ type: "thinking_start", contentIndex: 0, partial: message },
						{ type: "done", reason: "stop", message },
					] as unknown as AssistantMessageEvent[]);
				}
				return contentAttempt();
			},
			{ retryEmptyCompletion: true },
		);

		const events = await drain(stream);

		expect(attempts).toBe(2);
		// The empty attempt's start + thinking_start were discarded; only the
		// successful attempt's events reach the consumer.
		expect(events.filter(e => e.type === "start")).toHaveLength(1);
		expect(events.some(e => e.type === "thinking_start")).toBe(false);
		expect(events.some(e => e.type === "text_delta")).toBe(true);
	});

	it("streams content as it arrives without waiting for the terminal event", async () => {
		let waited = false;
		const message = assistant(["streamed"]);
		const inner = new AssistantMessageEventStream();
		const stream = withReplaySafeStreamRetry(
			{},
			CTX,
			{
				providerRetryWait: async () => {
					waited = true;
				},
			},
			() => inner,
			{ retryEmptyCompletion: true },
		);

		const iterator = stream[Symbol.asyncIterator]();
		// Push content with no terminal yet: the buffered start then the delta must
		// surface before any `done` exists, proving the wrapper does not buffer
		// meaningful content until completion.
		inner.push({ type: "start", partial: message } as unknown as AssistantMessageEvent);
		inner.push({
			type: "text_delta",
			contentIndex: 0,
			delta: "streamed",
			partial: message,
		} as unknown as AssistantMessageEvent);

		expect((await iterator.next()).value?.type).toBe("start");
		expect((await iterator.next()).value?.type).toBe("text_delta");

		inner.push({ type: "done", reason: "stop", message } as unknown as AssistantMessageEvent);
		expect((await iterator.next()).value?.type).toBe("done");
		expect(waited).toBe(false);
	});

	it("retries a transient provider error before output commits", async () => {
		let attempts = 0;
		const stream = withReplaySafeStreamRetry(
			{},
			CTX,
			{ providerRetryWait: async () => {} },
			() => {
				attempts++;
				if (attempts > 1) return contentAttempt();
				const message = assistant();
				message.stopReason = "error";
				message.errorMessage = "The socket connection was closed unexpectedly";
				return streamFromEvents([
					{ type: "start", partial: message },
					{ type: "error", reason: "error", error: message },
				]);
			},
			{ retryProviderErrors: true, maxProviderErrorRetries: 1 },
		);

		const events = await drain(stream);
		const result = await stream.result();

		expect(attempts).toBe(2);
		expect(events.filter(event => event.type === "start")).toHaveLength(1);
		expect(result.content).toEqual([{ type: "text", text: "hello" }]);
	});

	it("does not retry a transient provider error after output commits", async () => {
		let attempts = 0;
		const message = assistant(["partial"]);
		message.stopReason = "error";
		message.errorMessage = "The socket connection was closed unexpectedly";
		const stream = withReplaySafeStreamRetry(
			{},
			CTX,
			{ providerRetryWait: async () => {} },
			() => {
				attempts++;
				return streamFromEvents([
					{ type: "start", partial: message },
					{ type: "text_start", contentIndex: 0, partial: message },
					{ type: "text_delta", contentIndex: 0, delta: "partial", partial: message },
					{ type: "error", reason: "error", error: message },
				]);
			},
			{ retryProviderErrors: true, maxProviderErrorRetries: 1 },
		);

		const events = await drain(stream);
		const result = await stream.result();

		expect(attempts).toBe(1);
		expect(events.at(-1)?.type).toBe("error");
		expect(result.stopReason).toBe("error");
		expect(result.content).toEqual([{ type: "text", text: "partial" }]);
	});

	it("settles the outer stream when the attempt factory throws synchronously", async () => {
		const configError = new Error("explicit prompt caching is unsupported");
		const stream = withReplaySafeStreamRetry(
			{},
			CTX,
			{ providerRetryWait: async () => {} },
			() => {
				throw configError;
			},
			{ retryProviderErrors: true, maxProviderErrorRetries: 1 },
		);

		await expect(stream.result()).rejects.toBe(configError);
	});
});
