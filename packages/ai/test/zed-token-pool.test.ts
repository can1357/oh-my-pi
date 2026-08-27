import { describe, expect, it, vi } from "bun:test";
import { ProviderHttpError } from "../src/error/classes";
import { getOrMintZedLlmToken, invalidateZedLlmToken } from "../src/registry/oauth/zed-token-pool";
import type { FetchImpl } from "../src/types";

describe("Zed Token Pool", () => {
	it("mints and caches an LLM token successfully", async () => {
		let callCount = 0;
		const mockFetcher: FetchImpl = async () => {
			callCount++;
			return new Response(JSON.stringify({ token: "llm_tok_test_mock_123" }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		};

		const token1 = await getOrMintZedLlmToken("user_101", "access_tok_xyz", undefined, mockFetcher);
		expect(token1).toBe("llm_tok_test_mock_123");
		expect(callCount).toBe(1);

		// Second call should return cached token without triggering fetch
		const token2 = await getOrMintZedLlmToken("user_101", "access_tok_xyz", undefined, mockFetcher);
		expect(token2).toBe("llm_tok_test_mock_123");
		expect(callCount).toBe(1);

		// Invalidation should force re-mint on next call
		invalidateZedLlmToken("user_101", "access_tok_xyz");
		const token3 = await getOrMintZedLlmToken("user_101", "access_tok_xyz", undefined, mockFetcher);
		expect(token3).toBe("llm_tok_test_mock_123");
		expect(callCount).toBe(2);
	});

	it("throws ProviderHttpError with status 402 on HTTP 402", async () => {
		const mockFetcher: FetchImpl = async () => {
			return new Response("Payment required", {
				status: 402,
				headers: { "Content-Type": "text/plain" },
			});
		};

		let error: unknown;
		try {
			await getOrMintZedLlmToken("user_402", "access_tok_402", undefined, mockFetcher);
		} catch (caught) {
			error = caught;
		} finally {
			invalidateZedLlmToken("user_402", "access_tok_402");
		}

		expect(error).toBeInstanceOf(ProviderHttpError);
		expect((error as ProviderHttpError).status).toBe(402);
	});
	it("does not cancel a shared mint when the first concurrent waiter aborts", async () => {
		const userId = "user_concurrent_abort_isolation";
		const masterAccessToken = "access-token-concurrent-abort-isolation";
		const caller = new AbortController();
		const fetchStarted = Promise.withResolvers<void>();
		const fetchResponse = Promise.withResolvers<Response>();
		let fetchCalls = 0;
		let sharedFetchAborted = false;

		invalidateZedLlmToken(userId, masterAccessToken);
		const mockFetcher: FetchImpl = async (_input, init) => {
			fetchCalls++;
			if (init?.signal) {
				const onAbort = () => {
					sharedFetchAborted = true;
					fetchResponse.reject(new Error("shared fetch aborted"));
				};
				if (init.signal.aborted) onAbort();
				else init.signal.addEventListener("abort", onAbort, { once: true });
			}
			fetchStarted.resolve();
			return fetchResponse.promise;
		};

		try {
			const firstWaiter = getOrMintZedLlmToken(userId, masterAccessToken, caller.signal, mockFetcher);
			await fetchStarted.promise;
			const secondWaiter = getOrMintZedLlmToken(userId, masterAccessToken, undefined, mockFetcher);
			const firstOutcome = firstWaiter.then(
				() => undefined,
				error => error,
			);

			caller.abort();
			fetchResponse.resolve(
				new Response(JSON.stringify({ token: "llm-token-shared" }), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
			);

			const firstError = await firstOutcome;
			expect(firstError).toMatchObject({
				name: "AbortError",
				message: "Zed LLM token request aborted",
			});
			await expect(secondWaiter).resolves.toBe("llm-token-shared");
			expect(fetchCalls).toBe(1);
			expect(sharedFetchAborted).toBe(false);
		} finally {
			invalidateZedLlmToken(userId, masterAccessToken);
		}
	});

	it("times out a detached token mint and retries with a fresh request", async () => {
		vi.useFakeTimers();
		const userId = "user_detached_mint_timeout";
		const accessToken = "access-token-detached-mint-timeout";
		let fetchCalls = 0;
		const firstResponse = Promise.withResolvers<Response>();

		const mockFetcher: FetchImpl = async (_input, init) => {
			fetchCalls++;
			if (fetchCalls === 1) {
				const signal = init?.signal;
				if (signal) {
					const rejectOnAbort = () => {
						const reason = signal.reason;
						firstResponse.reject(reason);
					};
					if (signal.aborted) rejectOnAbort();
					else signal.addEventListener("abort", rejectOnAbort, { once: true });
				}
				return firstResponse.promise;
			}
			return new Response(JSON.stringify({ token: "llm-token-after-timeout" }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		};

		invalidateZedLlmToken(userId, accessToken);
		try {
			const firstAttempt = getOrMintZedLlmToken(userId, accessToken, undefined, mockFetcher);
			expect(fetchCalls).toBe(1);

			vi.advanceTimersByTime(30_001);
			const firstError = await firstAttempt.catch(error => error);
			const firstErrorName = firstError instanceof Error ? firstError.name : "";
			const firstErrorMessage = firstError instanceof Error ? firstError.message : String(firstError);
			expect(firstErrorName === "TimeoutError" || /timeout|aborted/i.test(firstErrorMessage)).toBe(true);

			await expect(getOrMintZedLlmToken(userId, accessToken, undefined, mockFetcher)).resolves.toBe(
				"llm-token-after-timeout",
			);
			expect(fetchCalls).toBe(2);
		} finally {
			invalidateZedLlmToken(userId, accessToken);
			vi.useRealTimers();
		}
	});
});
