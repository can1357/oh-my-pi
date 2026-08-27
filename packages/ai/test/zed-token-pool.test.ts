import { describe, expect, it } from "bun:test";
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

	it("throws QuotaExceededError on HTTP 402", async () => {
		const mockFetcher: FetchImpl = async () => {
			return new Response("Payment required", {
				status: 402,
				headers: { "Content-Type": "text/plain" },
			});
		};

		invalidateZedLlmToken("user_402", "access_tok_402");
		expect(getOrMintZedLlmToken("user_402", "access_tok_402", undefined, mockFetcher)).rejects.toThrow();
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
});
