/**
 * Contracts for replay-safe provider retries: empty and transient pre-output
 * attempts are bounded and discarded, while emitted content commits an attempt
 * so output is never duplicated.
 */
import { describe, expect, it } from "bun:test";
import type { AssistantMessage, AssistantMessageEvent, Context, FetchImpl, Usage } from "@oh-my-pi/pi-ai/types";
import { MAX_EMPTY_COMPLETION_RETRIES, withReplaySafeStreamRetry } from "@oh-my-pi/pi-ai/utils/empty-completion-retry";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { providerReplaysFrom, wireAttemptsOf } from "@oh-my-pi/pi-ai/utils/wire-attempts";

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

	interface CountedAttemptOptions {
		fetch?: FetchImpl;
		signal?: AbortSignal;
		providerRetryWait?: (delayMs: number, signal?: AbortSignal) => Promise<void>;
	}

	/**
	 * An attempt that spends `requests` on the wire through the request's
	 * counter, as every reporting provider does, and fails before output with
	 * the count that counter now holds.
	 */
	const countedFailure =
		(requestsPerAttempt: ReadonlyArray<number>, onAttempt: () => void = () => {}) =>
		(_model: unknown, _context: Context, options?: CountedAttemptOptions) => {
			onAttempt();
			const counter = wireAttemptsOf(options?.fetch);
			if (!counter) throw new Error("the attempt was not handed the request's counter");
			counter.count += requestsPerAttempt[Math.min(attemptIndex++, requestsPerAttempt.length - 1)];
			const message = assistant();
			message.stopReason = "error";
			message.errorMessage = "The socket connection was closed unexpectedly";
			message.providerReplays = providerReplaysFrom(counter);
			return streamFromEvents([
				{ type: "start", partial: message },
				{ type: "error", reason: "error", error: message },
			]);
		};
	let attemptIndex = 0;

	it("hands every attempt one counter, so the surfaced count holds the discarded attempts' requests", async () => {
		// The attempt it surfaces reports the request's whole count — including
		// the six requests the attempt it threw away had already spent — because
		// both counted into one counter. Nothing is added here, so nothing can be
		// counted twice.
		const run = async (requests: ReadonlyArray<number>): Promise<AssistantMessage> => {
			attemptIndex = 0;
			const stream = withReplaySafeStreamRetry(
				{},
				CTX,
				{ providerRetryWait: async () => {} },
				countedFailure(requests),
				{
					retryProviderErrors: true,
					maxProviderErrorRetries: 1,
				},
			);
			await drain(stream);
			return await stream.result();
		};

		// Six requests, then one: seven in all.
		expect((await run([6, 1])).providerReplays).toBe(6);
		// Six and six: twelve.
		expect((await run([6, 6])).providerReplays).toBe(11);
	});

	it("reports unknown, not a lower number, when the layer below counted only its own call", async () => {
		// A count over one counter never falls. An attempt that reports five and a
		// retry that reports zero cannot both be the request's count: the zero
		// is the retry's own call, and forwarding it would claim the request went
		// out once after it went out six times.
		const failing = (counts: ReadonlyArray<number | undefined>) => {
			let index = 0;
			return () => {
				const message = assistant();
				message.stopReason = "error";
				message.errorMessage = "The socket connection was closed unexpectedly";
				message.providerReplays = counts[Math.min(index++, counts.length - 1)];
				return streamFromEvents([
					{ type: "start", partial: message },
					{ type: "error", reason: "error", error: message },
				]);
			};
		};
		const run = async (counts: ReadonlyArray<number | undefined>): Promise<AssistantMessage> => {
			const stream = withReplaySafeStreamRetry({}, CTX, { providerRetryWait: async () => {} }, failing(counts), {
				retryProviderErrors: true,
				maxProviderErrorRetries: 1,
			});
			await drain(stream);
			return await stream.result();
		};

		expect((await run([5, 0])).providerReplays).toBeUndefined();
		// A number after an attempt that reported none is not the request's count either.
		expect((await run([undefined, 0])).providerReplays).toBeUndefined();
		// Nothing below reports: unknown, whatever this wrapper itself retried.
		expect((await run([undefined])).providerReplays).toBeUndefined();
	});

	it("does not write a count into a terminal message the layer below may reuse", async () => {
		const shared = assistant();
		shared.stopReason = "error";
		shared.errorMessage = "The socket connection was closed unexpectedly";
		shared.providerReplays = 3;
		const surfaced: Array<number | undefined> = [];
		let call = 0;
		for (let run = 0; run < 2; run++) {
			const stream = withReplaySafeStreamRetry(
				{},
				CTX,
				{ providerRetryWait: async () => {} },
				() => {
					// The first attempt of each run reports more than the shared message
					// does, so the wrapper must drop the count from what it forwards.
					const message = call++ % 2 === 0 ? { ...shared, providerReplays: 7 } : shared;
					return streamFromEvents([{ type: "error", reason: "error", error: message }]);
				},
				{ retryProviderErrors: true, maxProviderErrorRetries: 1 },
			);
			await drain(stream);
			surfaced.push((await stream.result()).providerReplays);
		}
		expect(surfaced).toEqual([undefined, undefined]);
		expect(shared.providerReplays).toBe(3);
	});

	it("reports what the counter holds when an abort ends the retry, before or during its wait", async () => {
		// Aborted during the first attempt: one attempt of six requests.
		const beforeWait = new AbortController();
		attemptIndex = 0;
		const abortedEarly = withReplaySafeStreamRetry(
			{},
			CTX,
			{ signal: beforeWait.signal, providerRetryWait: async () => {} },
			countedFailure([6], () => beforeWait.abort()),
			{ retryProviderErrors: true, maxProviderErrorRetries: 1 },
		);
		await drain(abortedEarly);
		expect((await abortedEarly.result()).providerReplays).toBe(5);

		// Aborted during the second retry wait: two attempts of six requests.
		const duringWait = new AbortController();
		attemptIndex = 0;
		let attempts = 0;
		let waits = 0;
		const abortedLate = withReplaySafeStreamRetry(
			{},
			CTX,
			{
				signal: duringWait.signal,
				providerRetryWait: async () => {
					if (++waits === 2) {
						duringWait.abort();
						throw new Error("cancelled");
					}
				},
			},
			countedFailure([6], () => {
				attempts++;
			}),
			{ retryProviderErrors: true, maxProviderErrorRetries: 2 },
		);
		await drain(abortedLate);
		expect(attempts).toBe(2);
		expect((await abortedLate.result()).providerReplays).toBe(11);
	});

	it("leaves the replay count absent when neither it nor the loop below replayed", async () => {
		const message = assistant();
		message.stopReason = "error";
		message.errorMessage = "Invalid tool schema";
		const stream = withReplaySafeStreamRetry(
			{},
			CTX,
			{ providerRetryWait: async () => {} },
			() =>
				streamFromEvents([
					{ type: "start", partial: message },
					{ type: "error", reason: "error", error: message },
				]),
			{ retryProviderErrors: true, maxProviderErrorRetries: 1 },
		);

		await drain(stream);
		expect((await stream.result()).providerReplays).toBeUndefined();
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

	it("retries when a tool call emits start and an empty end with no argument content before an error", async () => {
		let attempts = 0;
		const stream = withReplaySafeStreamRetry(
			{},
			CTX,
			{ providerRetryWait: async () => {} },
			() => {
				attempts++;
				if (attempts > 1) return contentAttempt();
				// Mirror the object-args producer branch: a delta event is pushed
				// per chunk even when empty, the `{}` flush is suppressed, and the
				// error sweep finalizes through the same finishToolCallBlock, so a
				// completed call there is event-identical to this unfilled one.
				const message = assistant();
				message.stopReason = "error";
				message.errorMessage = "The socket connection was closed unexpectedly";
				return streamFromEvents([
					{ type: "start", partial: message },
					{ type: "toolcall_start", contentIndex: 0, partial: message },
					{ type: "toolcall_delta", contentIndex: 0, delta: "", partial: message },
					{
						type: "toolcall_end",
						contentIndex: 0,
						toolCall: { type: "toolCall", id: "call-1", name: "read", arguments: {} },
						partial: message,
					},
					{ type: "error", reason: "error", error: message },
				] as unknown as AssistantMessageEvent[]);
			},
			{ retryProviderErrors: true, maxProviderErrorRetries: 1 },
		);

		const events = await drain(stream);
		const result = await stream.result();

		expect(attempts).toBe(2);
		// The failed attempt's toolcall lifecycle markers must not reach the consumer.
		expect(events.some(e => e.type === "toolcall_start")).toBe(false);
		expect(events.some(e => e.type === "toolcall_end")).toBe(false);
		expect(result.content).toEqual([{ type: "text", text: "hello" }]);
	});

	it("commits on a toolcall_delta with content and does not retry", async () => {
		let attempts = 0;
		const message = assistant();
		message.content = [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "/x" } }];
		const stream = withReplaySafeStreamRetry(
			{},
			CTX,
			{ providerRetryWait: async () => {} },
			() => {
				attempts++;
				return streamFromEvents([
					{ type: "start", partial: message },
					{ type: "toolcall_start", contentIndex: 0, partial: message },
					{ type: "toolcall_delta", contentIndex: 0, delta: '{"path":"/x"}', partial: message },
					{ type: "toolcall_end", contentIndex: 0, toolCall: message.content[0], partial: message },
					{ type: "done", reason: "stop", message },
				] as unknown as AssistantMessageEvent[]);
			},
			{ retryEmptyCompletion: true },
		);

		await drain(stream);

		expect(attempts).toBe(1);
	});

	it("does not retry a completed zero-argument tool call when the transport fails after toolcall_end", async () => {
		let attempts = 0;
		const message = assistant();
		message.content = [{ type: "toolCall", id: "call-1", name: "read", arguments: {} }];
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
					{ type: "toolcall_start", contentIndex: 0, partial: message },
					// String-arg hosts emit `{}` itself as a non-empty delta, which
					// commits the attempt before toolcall_end arrives.
					{ type: "toolcall_delta", contentIndex: 0, delta: "{}", partial: message },
					{ type: "toolcall_end", contentIndex: 0, toolCall: message.content[0], partial: message },
					{ type: "error", reason: "error", error: message },
				] as unknown as AssistantMessageEvent[]);
			},
			{ retryProviderErrors: true, maxProviderErrorRetries: 1 },
		);

		const events = await drain(stream);
		const result = await stream.result();

		expect(attempts).toBe(1);
		expect(events.at(-1)?.type).toBe("error");
		// The completed call reaches the consumer instead of being discarded.
		expect(events.some(e => e.type === "toolcall_end")).toBe(true);
		expect(result.stopReason).toBe("error");
	});
});
