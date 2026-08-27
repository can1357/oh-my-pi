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
});
