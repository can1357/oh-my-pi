import { afterEach, describe, expect, it, vi } from "bun:test";
import * as AIError from "@oh-my-pi/pi-ai/error";
import * as BedrockProvider from "@oh-my-pi/pi-ai/providers/amazon-bedrock";
import { setBedrockProviderModule, streamBedrock } from "@oh-my-pi/pi-ai/providers/register-builtins";
import type { AssistantMessage, Context, Model } from "@oh-my-pi/pi-ai/types";
import type { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

// The transport override is process-global: put the built-in back so later files stream for real.
afterEach(() => setBedrockProviderModule(BedrockProvider));

async function drainMicrotasksUntil(predicate: () => boolean, errorMessage: string): Promise<void> {
	for (let i = 0; i < 1000; i++) {
		if (predicate()) return;
		await Promise.resolve();
	}
	throw new Error(errorMessage);
}

function createModel(
	overrides: { reasoning?: boolean; compat?: { streamIdleTimeoutMs?: number } } = {},
): Model<"bedrock-converse-stream"> {
	return buildModel({
		id: "mock-bedrock",
		name: "Mock Bedrock",
		api: "bedrock-converse-stream",
		provider: "amazon-bedrock",
		baseUrl: "https://example.invalid",
		reasoning: overrides.reasoning ?? false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 2048,
		compat: overrides.compat,
	});
}

function createAssistantMessage(
	stopReason: AssistantMessage["stopReason"] = "stop",
	errorMessage?: string,
): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: errorMessage ? `error: ${errorMessage}` : "ok" }],
		api: "bedrock-converse-stream",
		provider: "amazon-bedrock",
		model: "mock-bedrock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		errorMessage,
		timestamp: Date.now(),
	};
}

const baseContext: Context = { messages: [] };

async function resultAfterCallerAbort(reason: unknown): Promise<AssistantMessage> {
	const abortController = new AbortController();
	const partialMessage = createAssistantMessage("stop");
	let providerSignal: AbortSignal | undefined;
	const source = {
		async *[Symbol.asyncIterator]() {
			yield { type: "start", partial: partialMessage } as const;
			const { promise, reject } = Promise.withResolvers<never>();
			if (providerSignal?.aborted) {
				reject(new Error("transport stopped"));
			}
			providerSignal?.addEventListener("abort", () => reject(new Error("transport stopped")), {
				once: true,
			});
			await promise;
		},
	} as unknown as AssistantMessageEventStream;

	setBedrockProviderModule({
		streamBedrock: (_model, _context, options) => {
			providerSignal = options.signal;
			return source;
		},
	});

	const stream = streamBedrock(createModel(), baseContext, {
		signal: abortController.signal,
		streamIdleTimeoutMs: 500,
	});
	const iterator = stream[Symbol.asyncIterator]();
	const firstEvent = await iterator.next();
	expect(firstEvent.value?.type).toBe("start");

	abortController.abort(reason);
	return stream.result();
}

describe("register-builtins lazy streams", () => {
	it("resolves the outer stream result from source.result() when no terminal event is iterated", async () => {
		const finalMessage = createAssistantMessage("stop");
		const partialMessage = createAssistantMessage("stop");
		const source = {
			async *[Symbol.asyncIterator]() {
				yield { type: "start", partial: partialMessage } as const;
			},
			result: async () => finalMessage,
		} as unknown as AssistantMessageEventStream;

		setBedrockProviderModule({
			streamBedrock: () => source,
		});

		const stream = streamBedrock(createModel(), baseContext, {});
		const result = await Promise.race([stream.result(), Bun.sleep(100).then(() => "timeout" as const)]);

		expect(result).not.toBe("timeout");
		if (result === "timeout") {
			throw new Error("Timed out waiting for forwarded stream result");
		}
		expect(result).toEqual(finalMessage);
	});

	it("turns iterator failures into terminal error results", async () => {
		const partialMessage = createAssistantMessage("stop");
		const source = {
			async *[Symbol.asyncIterator]() {
				yield { type: "start", partial: partialMessage } as const;
				throw new Error("bedrock exploded");
			},
		} as unknown as AssistantMessageEventStream;

		setBedrockProviderModule({
			streamBedrock: () => source,
		});

		const stream = streamBedrock(createModel(), baseContext, {});
		const result = await Promise.race([stream.result(), Bun.sleep(100).then(() => "timeout" as const)]);

		expect(result).not.toBe("timeout");
		if (result === "timeout") {
			throw new Error("Timed out waiting for forwarded error result");
		}
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("bedrock exploded");
	});

	it("turns idle lazy provider streams into retryable terminal errors", async () => {
		const partialMessage = createAssistantMessage("stop");
		let providerSignal: AbortSignal | undefined;
		const source = {
			async *[Symbol.asyncIterator]() {
				yield { type: "start", partial: partialMessage } as const;
				yield { type: "text_delta", contentIndex: 0, delta: "hello", partial: partialMessage } as const;
				const { promise, reject } = Promise.withResolvers<never>();
				if (providerSignal?.aborted) {
					reject(new Error("Request was aborted"));
				}
				providerSignal?.addEventListener("abort", () => reject(new Error("Request was aborted")), {
					once: true,
				});
				await promise;
			},
		} as unknown as AssistantMessageEventStream;

		setBedrockProviderModule({
			streamBedrock: (_model, _context, options) => {
				providerSignal = options.signal;
				return source;
			},
		});

		const stream = streamBedrock(createModel(), baseContext, { streamIdleTimeoutMs: 10 });
		const result = await Promise.race([stream.result(), Bun.sleep(500).then(() => "timeout" as const)]);

		expect(result).not.toBe("timeout");
		if (result === "timeout") {
			throw new Error("Timed out waiting for forwarded stream stall result");
		}
		expect(providerSignal?.aborted).toBe(true);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe("Provider stream stalled while waiting for the next event");
		// The watchdog's StreamTimeoutError classification must survive onto the
		// message so session-level auto-retry can classify it structurally.
		expect(AIError.is(result.errorId, AIError.Flag.Transient)).toBe(true);
		expect(AIError.is(result.errorId, AIError.Flag.Timeout)).toBe(true);
		expect(AIError.retriable(result.errorId)).toBe(true);
	});

	it("honors model.compat.streamIdleTimeoutMs as the lazy watchdog fallback", async () => {
		const partialMessage = createAssistantMessage("stop");
		let providerSignal: AbortSignal | undefined;
		const source = {
			async *[Symbol.asyncIterator]() {
				yield { type: "start", partial: partialMessage } as const;
				yield { type: "text_delta", contentIndex: 0, delta: "hello", partial: partialMessage } as const;
				const { promise, reject } = Promise.withResolvers<never>();
				if (providerSignal?.aborted) {
					reject(new Error("Request was aborted"));
				}
				providerSignal?.addEventListener("abort", () => reject(new Error("Request was aborted")), {
					once: true,
				});
				await promise;
			},
		} as unknown as AssistantMessageEventStream;

		setBedrockProviderModule({
			streamBedrock: (_model, _context, options) => {
				providerSignal = options.signal;
				return source;
			},
		});

		// No per-call option: the catalog compat override must reach the lazy
		// watchdog (a stalled Bedrock stream previously waited the generic 300s
		// default because model.compat was ignored on this path).
		const model = createModel({ reasoning: true, compat: { streamIdleTimeoutMs: 20 } });
		expect(model.compat.streamIdleTimeoutMs).toBe(20);
		const stream = streamBedrock(model, baseContext, {});
		// Real-clock race guard (matching this file's other lazy-stream tests):
		// the lazy watchdog runs on the platform clock, so fake timers cannot
		// drive it; the 20ms compat deadline settles the result long before the
		// bound, which exists only to fail fast instead of hanging the test.
		const result = await Promise.race([stream.result(), Bun.sleep(2_000).then(() => "timeout" as const)]);

		expect(result).not.toBe("timeout");
		if (result === "timeout") {
			throw new Error("Timed out waiting for compat-driven stream stall result");
		}
		expect(providerSignal?.aborted).toBe(true);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe("Provider stream stalled while waiting for the next event");
	});

	it("disables the lazy watchdog when model.compat.streamIdleTimeoutMs is 0", async () => {
		vi.useFakeTimers();
		try {
			const partialMessage = createAssistantMessage("stop");
			const abortController = new AbortController();
			let providerSignal: AbortSignal | undefined;
			let steadyState = false;
			const source = {
				async *[Symbol.asyncIterator]() {
					yield { type: "start", partial: partialMessage } as const;
					yield { type: "text_delta", contentIndex: 0, delta: "hello", partial: partialMessage } as const;
					steadyState = true;
					const { promise, reject } = Promise.withResolvers<never>();
					if (providerSignal?.aborted) {
						reject(new Error("Request was aborted"));
					}
					providerSignal?.addEventListener("abort", () => reject(new Error("Request was aborted")), {
						once: true,
					});
					await promise;
				},
			} as unknown as AssistantMessageEventStream;

			setBedrockProviderModule({
				streamBedrock: (_model, _context, options) => {
					providerSignal = options.signal;
					return source;
				},
			});

			// reasoning:true would floor the watchdog at 600s for this id — the
			// explicit 0 override must disable it entirely through the lazy
			// wrapper, not fall back to any default (e.g. via a `||` regression).
			const model = createModel({ reasoning: true, compat: { streamIdleTimeoutMs: 0 } });
			expect(model.compat.streamIdleTimeoutMs).toBe(0);
			let settled = false;
			// First-event watchdog stays out of this case's scope (mirrors the
			// direct-Anthropic 0-disable test): fake-timer advancement could
			// otherwise outrun the microtask that consumes the first event.
			const resultPromise = streamBedrock(model, baseContext, {
				signal: abortController.signal,
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
				() => steadyState,
				"Bedrock mock stream did not reach steady-state idle for the compat-disabled watchdog test",
			);
			// Well past the generic 300s idle budget: the disabled watchdog must
			// not classify the post-first-event silence as a stall.
			vi.advanceTimersByTime(400_000);
			await drainMicrotasksUntil(
				() => vi.getTimerCount() === 0,
				"lazy watchdog timer did not drain after advancing past the idle budget",
			);
			expect(settled).toBe(false);
			expect(providerSignal?.aborted).toBe(false);

			abortController.abort();
			const result = await resultPromise;
			expect(result.stopReason).toBe("aborted");
			expect(result.errorMessage).toBe("Request was aborted");
		} finally {
			vi.useRealTimers();
		}
	});

	it("forwards a caller's abort label instead of replacing it with generic text", async () => {
		const result = await resultAfterCallerAbort("Interrupted by user");

		expect(result.stopReason).toBe("aborted");
		expect(result.errorMessage).toBe("Interrupted by user");
		expect(AIError.is(result.errorId, AIError.Flag.Abort)).toBe(false);
	});

	it("keeps structural flags from the original caller abort reason, even with an empty message", async () => {
		const labelled = await resultAfterCallerAbort(new AIError.StreamTimeoutError("budget spent"));
		expect(labelled.stopReason).toBe("aborted");
		expect(labelled.errorMessage).toBe("budget spent");
		expect(AIError.is(labelled.errorId, AIError.Flag.Timeout)).toBe(true);
		expect(AIError.is(labelled.errorId, AIError.Flag.Transient)).toBe(true);
		expect(AIError.is(labelled.errorId, AIError.Flag.Abort)).toBe(false);

		const emptyMessage = await resultAfterCallerAbort(new AIError.StreamTimeoutError(""));
		expect(emptyMessage.stopReason).toBe("aborted");
		expect(emptyMessage.errorMessage).toBe("Request was aborted");
		expect(AIError.is(emptyMessage.errorId, AIError.Flag.Timeout)).toBe(true);
		expect(AIError.is(emptyMessage.errorId, AIError.Flag.Transient)).toBe(true);
		expect(AIError.is(emptyMessage.errorId, AIError.Flag.Abort)).toBe(false);
	});

	it("does not fabricate an HTTP status from a status-looking caller abort label", async () => {
		const result = await resultAfterCallerAbort("Stopped after HTTP 404");

		expect(result.stopReason).toBe("aborted");
		expect(result.errorMessage).toBe("Stopped after HTTP 404");
		expect(result.errorStatus).toBeUndefined();
		expect(result.errorId).toBeUndefined();
	});

	it("preserves an already-settled terminal HTTP result during an iterator abort race without waiting on a pending provider", async () => {
		const partialMessage = createAssistantMessage("stop");

		// 1. Abort while iterator.next() is pending and source.result() already published a 404 AssistantMessage.
		const abortFulfilled = new AbortController();
		const terminalMessage = createAssistantMessage("error", "404 Not Found");
		terminalMessage.errorStatus = 404;
		const fulfilledSource = {
			async *[Symbol.asyncIterator]() {
				yield { type: "start", partial: partialMessage } as const;
				await Promise.withResolvers<never>().promise;
			},
			result: () => Promise.resolve(terminalMessage),
		} as unknown as AssistantMessageEventStream;
		setBedrockProviderModule({ streamBedrock: () => fulfilledSource });

		const fulfilledStream = streamBedrock(createModel(), baseContext, {
			signal: abortFulfilled.signal,
			streamIdleTimeoutMs: 500,
		});
		const fulfilledIterator = fulfilledStream[Symbol.asyncIterator]();
		expect((await fulfilledIterator.next()).value?.type).toBe("start");
		abortFulfilled.abort();
		const fulfilledResult = await Promise.race([
			fulfilledStream.result(),
			Bun.sleep(500).then(() => "timeout" as const),
		]);
		expect(fulfilledResult).not.toBe("timeout");
		if (fulfilledResult === "timeout") throw new Error("Timed out waiting for aborted race result");
		expect(fulfilledResult.stopReason).toBe("aborted");
		expect(fulfilledResult.errorMessage).toBe("Request was aborted");
		expect(fulfilledResult.errorStatus).toBe(404);
		expect(AIError.is(fulfilledResult.errorId, AIError.Flag.Abort)).toBe(true);

		// 2. Abort while iterator.next() is pending and source.result() already rejected with ProviderHttpError(404).
		const abortRejected = new AbortController();
		const rejectedPromise = Promise.reject(new AIError.ProviderHttpError("missing model", 404));
		rejectedPromise.catch(() => {});
		const rejectedSource = {
			async *[Symbol.asyncIterator]() {
				yield { type: "start", partial: partialMessage } as const;
				await Promise.withResolvers<never>().promise;
			},
			result: () => rejectedPromise,
		} as unknown as AssistantMessageEventStream;
		setBedrockProviderModule({ streamBedrock: () => rejectedSource });

		const rejectedStream = streamBedrock(createModel(), baseContext, {
			signal: abortRejected.signal,
			streamIdleTimeoutMs: 500,
		});
		const rejectedIterator = rejectedStream[Symbol.asyncIterator]();
		expect((await rejectedIterator.next()).value?.type).toBe("start");
		abortRejected.abort();
		const rejectedResult = await Promise.race([
			rejectedStream.result(),
			Bun.sleep(500).then(() => "timeout" as const),
		]);
		expect(rejectedResult).not.toBe("timeout");
		if (rejectedResult === "timeout") throw new Error("Timed out waiting for aborted rejected-result race");
		expect(rejectedResult.stopReason).toBe("aborted");
		expect(rejectedResult.errorMessage).toBe("Request was aborted");
		expect(rejectedResult.errorStatus).toBe(404);
		expect(AIError.is(rejectedResult.errorId, AIError.Flag.Abort)).toBe(true);

		// 3. Abort while both iterator.next() and source.result() stay pending: settles without waiting on the provider.
		const abortPending = new AbortController();
		const pendingSource = {
			async *[Symbol.asyncIterator]() {
				yield { type: "start", partial: partialMessage } as const;
				await Promise.withResolvers<never>().promise;
			},
			result: () => Promise.withResolvers<AssistantMessage>().promise,
		} as unknown as AssistantMessageEventStream;
		setBedrockProviderModule({ streamBedrock: () => pendingSource });

		const pendingStream = streamBedrock(createModel(), baseContext, {
			signal: abortPending.signal,
			streamIdleTimeoutMs: 500,
		});
		const pendingIterator = pendingStream[Symbol.asyncIterator]();
		expect((await pendingIterator.next()).value?.type).toBe("start");
		abortPending.abort();
		const pendingResult = await Promise.race([pendingStream.result(), Bun.sleep(500).then(() => "timeout" as const)]);
		expect(pendingResult).not.toBe("timeout");
		if (pendingResult === "timeout") throw new Error("Timed out waiting for still-running provider abort");
		expect(pendingResult.stopReason).toBe("aborted");
		expect(pendingResult.errorMessage).toBe("Request was aborted");
		expect(pendingResult.errorStatus).toBeUndefined();
		expect(AIError.is(pendingResult.errorId, AIError.Flag.Abort)).toBe(true);
	});

	it("reads a tool-scoped caller reason and settles even if its cause getter throws", async () => {
		const toolScopedResult = await resultAfterCallerAbort({
			kind: "tool-scoped-abort",
			message: "Streaming edit preview failed",
			toolCallMessages: {},
			defaultToolCallMessage: "Streaming edit preview failed",
		});
		expect(toolScopedResult.errorMessage).toBe("Streaming edit preview failed");
		expect(AIError.is(toolScopedResult.errorId, AIError.Flag.Abort)).toBe(false);

		const throwingCauseResult = await Promise.race([
			resultAfterCallerAbort({
				kind: "tool-scoped-abort",
				message: "Streaming edit preview failed",
				toolCallMessages: {},
				defaultToolCallMessage: "Streaming edit preview failed",
				get cause() {
					throw new Error("boom");
				},
			}),
			Bun.sleep(500).then(() => "timeout" as const),
		]);
		expect(throwingCauseResult).not.toBe("timeout");
		if (throwingCauseResult === "timeout")
			throw new Error("Stream result stayed pending after throwing cause getter");
		expect(throwingCauseResult.stopReason).toBe("aborted");
		expect(throwingCauseResult.errorMessage).toBe("Streaming edit preview failed");
		expect(AIError.is(throwingCauseResult.errorId, AIError.Flag.Abort)).toBe(false);
	});

	it("preserves caller aborts while forwarding lazy provider streams", async () => {
		const abortController = new AbortController();
		const partialMessage = createAssistantMessage("stop");
		let providerSignal: AbortSignal | undefined;
		const source = {
			async *[Symbol.asyncIterator]() {
				yield { type: "start", partial: partialMessage } as const;
				const { promise, reject } = Promise.withResolvers<never>();
				if (providerSignal?.aborted) {
					reject(new Error("Request was aborted"));
				}
				providerSignal?.addEventListener("abort", () => reject(new Error("Request was aborted")), {
					once: true,
				});
				await promise;
			},
		} as unknown as AssistantMessageEventStream;

		setBedrockProviderModule({
			streamBedrock: (_model, _context, options) => {
				providerSignal = options.signal;
				return source;
			},
		});

		const stream = streamBedrock(createModel(), baseContext, {
			signal: abortController.signal,
			streamIdleTimeoutMs: 500,
		});
		const iterator = stream[Symbol.asyncIterator]();
		const firstEvent = await iterator.next();
		expect(firstEvent.value?.type).toBe("start");

		abortController.abort();
		const result = await Promise.race([stream.result(), Bun.sleep(500).then(() => "timeout" as const)]);

		expect(result).not.toBe("timeout");
		if (result === "timeout") {
			throw new Error("Timed out waiting for forwarded caller abort result");
		}
		expect(result.stopReason).toBe("aborted");
		expect(result.errorMessage).toBe("Request was aborted");
		expect(result.errorId).toBe(AIError.create(AIError.Flag.Abort));
	});
});
