import { describe, expect, it } from "bun:test";
import { retryTransientCompletion } from "@oh-my-pi/pi-ai/oneshot-retry";
import type { AssistantMessage, Usage } from "@oh-my-pi/pi-ai/types";

/**
 * Defends the contract every oneshot LLM call site now depends on:
 * `completeSimple` reports a transient provider failure by RESOLVING with
 * `stopReason: "error"` rather than throwing, so a retry layer that only
 * catches exceptions silently never fires. Before this helper, an Anthropic
 * `overloaded_error` / 429 / 529 on a summary, title, handoff or image
 * description failed on the first blip — or was swallowed into `null`, making a
 * transient overload indistinguishable from a legitimate empty result.
 *
 * These tests pin the four properties the call sites rely on: transient
 * error-stops are re-issued, non-transient ones are not, the final failure is
 * handed back unchanged (so existing `null`/throw fallbacks still work), and a
 * caller abort wins immediately.
 */

const emptyUsage = (): Usage =>
	({
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	}) as unknown as Usage;

function message(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-6",
		usage: emptyUsage(),
		stopReason: "stop",
		timestamp: 0,
		...overrides,
	} as AssistantMessage;
}

const overloaded = (): AssistantMessage =>
	message({
		stopReason: "error",
		errorStatus: 529,
		errorMessage: "Anthropic stream error (overloaded_error): Overloaded",
	});

const rateLimited = (): AssistantMessage =>
	message({ stopReason: "error", errorStatus: 429, errorMessage: "rate_limit_error: too many requests" });

// Keep the suite fast: the helper's real backoff floor is 500ms.
const fast = { baseDelayMs: 1, maxAttempts: 3 } as const;

describe("retryTransientCompletion", () => {
	it("re-issues an Anthropic 529 error-stop and returns the eventual success", async () => {
		const results = [overloaded(), overloaded(), message({ stopReason: "stop" })];
		let calls = 0;
		const final = await retryTransientCompletion(() => {
			calls += 1;
			return Promise.resolve(results.shift()!);
		}, fast);

		expect(calls).toBe(3);
		expect(final.stopReason).toBe("stop");
	});

	it("re-issues a 429 rate-limit error-stop", async () => {
		let calls = 0;
		const final = await retryTransientCompletion(() => {
			calls += 1;
			return Promise.resolve(calls === 1 ? rateLimited() : message());
		}, fast);

		expect(calls).toBe(2);
		expect(final.stopReason).toBe("stop");
	});

	it("re-issues a status-only 503 error-stop", async () => {
		let calls = 0;
		const final = await retryTransientCompletion(() => {
			calls += 1;
			return Promise.resolve(
				calls === 1
					? message({ stopReason: "error", errorStatus: 503, errorMessage: "request failed" })
					: message(),
			);
		}, fast);

		expect(calls).toBe(2);
		expect(final.stopReason).toBe("stop");
	});

	it("returns the failing message unchanged once attempts are exhausted, so caller fallbacks still apply", async () => {
		let calls = 0;
		const final = await retryTransientCompletion(() => {
			calls += 1;
			return Promise.resolve(overloaded());
		}, fast);

		expect(calls).toBe(3);
		expect(final.stopReason).toBe("error");
		expect(final.errorMessage).toContain("overloaded_error");
	});

	it("does not retry a non-transient provider error", async () => {
		let calls = 0;
		const final = await retryTransientCompletion(
			() => {
				calls += 1;
				return Promise.resolve(
					message({
						stopReason: "error",
						errorStatus: 400,
						errorMessage: "invalid_request_error: messages: at least one message is required",
					}),
				);
			},
			{ ...fast, maxAttempts: 5 },
		);

		expect(calls).toBe(1);
		expect(final.stopReason).toBe("error");
	});

	it("does not retry an input the model cannot fit", async () => {
		// A oneshot replays a fixed prompt: the same overflow comes back every
		// attempt, so the retries only delay the caller's fallback. Observed live
		// as 10 identical 3M-token compaction summarization calls.
		let calls = 0;
		const final = await retryTransientCompletion(
			() => {
				calls += 1;
				return Promise.resolve(
					message({
						stopReason: "error",
						errorStatus: 400,
						errorMessage:
							"invalid_request_error: prompt is too long: 3059586 tokens > 1000000 maximum (raw-http-request=/logs/1787022540720-3o503gxo48bvb.json)",
					}),
				);
			},
			{ ...fast, maxAttempts: 5 },
		);

		expect(calls).toBe(1);
		expect(final.stopReason).toBe("error");
	});

	it("does not retry a transient-wrapped payload rejection", async () => {
		let calls = 0;
		const final = await retryTransientCompletion(
			() => {
				calls += 1;
				return Promise.resolve(
					message({
						stopReason: "error",
						errorStatus: 413,
						errorMessage: "Provider returned error: 413 Payload Too Large",
					}),
				);
			},
			{ ...fast, maxAttempts: 5 },
		);

		expect(calls).toBe(1);
		expect(final.stopReason).toBe("error");
		expect(final.errorMessage).toContain("413");
	});

	it("does not retry a deterministic llama.cpp tool-call parse failure reported as 500", async () => {
		let calls = 0;
		const final = await retryTransientCompletion(
			() => {
				calls += 1;
				return Promise.resolve(
					message({
						stopReason: "error",
						errorStatus: 500,
						errorMessage: "failed to parse tool call arguments as JSON",
					}),
				);
			},
			{ ...fast, maxAttempts: 5 },
		);

		expect(calls).toBe(1);
		expect(final.stopReason).toBe("error");
	});

	it("retries a thrown transient error and rethrows the last one when exhausted", async () => {
		let calls = 0;
		const attempt = retryTransientCompletion(() => {
			calls += 1;
			const error = new Error("529 overloaded_error: Overloaded") as Error & { status?: number };
			error.status = 529;
			throw error;
		}, fast);

		await expect(attempt).rejects.toThrow(/overloaded_error/);
		expect(calls).toBe(3);
	});

	it("retries a thrown status-only 503 error", async () => {
		let calls = 0;
		const final = await retryTransientCompletion(() => {
			calls += 1;
			if (calls === 1) {
				const error = new Error("request failed") as Error & { status: number };
				error.status = 503;
				throw error;
			}
			return Promise.resolve(message());
		}, fast);

		expect(calls).toBe(2);
		expect(final.stopReason).toBe("stop");
	});

	it("does not retry a thrown non-transient error", async () => {
		let calls = 0;
		const attempt = retryTransientCompletion(() => {
			calls += 1;
			throw new Error("invalid_request_error: bad tool schema");
		}, fast);

		await expect(attempt).rejects.toThrow(/invalid_request_error/);
		expect(calls).toBe(1);
	});

	it("stops immediately when the caller aborts", async () => {
		const controller = new AbortController();
		let calls = 0;
		const final = await retryTransientCompletion(
			() => {
				calls += 1;
				controller.abort();
				return Promise.resolve(overloaded());
			},
			{ ...fast, signal: controller.signal },
		);

		expect(calls).toBe(1);
		expect(final.stopReason).toBe("error");
	});

	it("rejects with the abort reason when the caller cancels during backoff", async () => {
		// The cancel lands while we are waiting, not while an attempt is in flight:
		// it must stay a cancellation rather than being reported as the provider
		// failure we happened to be sleeping on.
		const controller = new AbortController();
		const reason = new Error("user pressed escape");
		let calls = 0;
		const attempt = retryTransientCompletion(
			() => {
				calls += 1;
				setTimeout(() => controller.abort(reason), 5);
				return Promise.resolve(overloaded());
			},
			{ maxAttempts: 3, baseDelayMs: 200, signal: controller.signal },
		);

		await expect(attempt).rejects.toThrow("user pressed escape");
		expect(calls).toBe(1);
	});

	it("reports each retry through onRetry so callers can log the wait", async () => {
		const seen: number[] = [];
		let calls = 0;
		await retryTransientCompletion(
			() => {
				calls += 1;
				return Promise.resolve(calls === 1 ? overloaded() : message());
			},
			{ ...fast, onRetry: info => seen.push(info.attempt) },
		);

		expect(seen).toEqual([1]);
	});

	it("surfaces the failure instead of parking when the provider asks for longer than maxDelayMs", async () => {
		let calls = 0;
		const final = await retryTransientCompletion(
			() => {
				calls += 1;
				return Promise.resolve(
					message({
						stopReason: "error",
						errorStatus: 429,
						errorMessage: "rate_limit_error: please retry in 600s",
					}),
				);
			},
			{ ...fast, maxDelayMs: 1_000 },
		);

		expect(calls).toBe(1);
		expect(final.stopReason).toBe("error");
	});

	it("honors a retry-after-ms response header over the backoff floor", async () => {
		// The header is the only place a real Anthropic 429 carries its wait: the
		// resolved AssistantMessage has no headers, so a helper that reads only the
		// error text would silently fall back to plain backoff.
		let calls = 0;
		let observedDelay = -1;
		await retryTransientCompletion(
			() => {
				calls += 1;
				return Promise.resolve(calls === 1 ? rateLimited() : message());
			},
			{
				maxAttempts: 2,
				baseDelayMs: 1,
				getResponseHeaders: () => ({ "retry-after-ms": "120" }),
				onRetry: info => {
					observedDelay = info.delayMs;
				},
			},
		);

		expect(calls).toBe(2);
		expect(observedDelay).toBe(120);
	});

	it("honors the canonical retry-after-ms error-message suffix", async () => {
		let calls = 0;
		let observedDelay = -1;
		await retryTransientCompletion(
			() => {
				calls += 1;
				return Promise.resolve(
					calls === 1
						? message({
								stopReason: "error",
								errorStatus: 429,
								errorMessage: "rate_limit_error: too many requests retry-after-ms=5",
							})
						: message(),
				);
			},
			{
				maxAttempts: 2,
				baseDelayMs: 1,
				onRetry: info => {
					observedDelay = info.delayMs;
				},
			},
		);

		expect(calls).toBe(2);
		expect(observedDelay).toBe(5);
	});

	it("surfaces a canonical retry-after-ms suffix above maxDelayMs", async () => {
		let calls = 0;
		const final = await retryTransientCompletion(
			() => {
				calls += 1;
				return Promise.resolve(
					message({
						stopReason: "error",
						errorStatus: 429,
						errorMessage: "rate_limit_error: too many requests retry-after-ms=12000",
					}),
				);
			},
			{ ...fast, maxDelayMs: 1_000 },
		);

		expect(calls).toBe(1);
		expect(final.stopReason).toBe("error");
	});

	it("surfaces the failure when a retry-after header exceeds maxDelayMs", async () => {
		let calls = 0;
		const final = await retryTransientCompletion(
			() => {
				calls += 1;
				return Promise.resolve(rateLimited());
			},
			{
				maxAttempts: 3,
				baseDelayMs: 1,
				maxDelayMs: 1_000,
				getResponseHeaders: () => ({ "retry-after": "300" }),
			},
		);

		expect(calls).toBe(1);
		expect(final.stopReason).toBe("error");
	});

	it("recovers retry-after from a thrown provider error's own headers", async () => {
		let calls = 0;
		let observedDelay = -1;
		const attempt = retryTransientCompletion(
			() => {
				calls += 1;
				const error = new Error("529 overloaded_error: Overloaded") as Error & {
					status?: number;
					headers?: Record<string, string>;
				};
				error.status = 529;
				error.headers = { "retry-after-ms": "90" };
				throw error;
			},
			{
				maxAttempts: 2,
				baseDelayMs: 1,
				onRetry: info => {
					observedDelay = info.delayMs;
				},
			},
		);

		await expect(attempt).rejects.toThrow(/overloaded_error/);
		expect(calls).toBe(2);
		expect(observedDelay).toBe(90);
	});
});
