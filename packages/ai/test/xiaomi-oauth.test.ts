import { describe, expect, it, vi } from "bun:test";
import { loginXiaomi } from "@oh-my-pi/pi-ai/registry/oauth/xiaomi";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";

describe("xiaomi oauth validation", () => {
	it("uses a fresh AbortSignal per endpoint so SGP timeout doesn't abort AMS fallback", async () => {
		const capturedSignals: (AbortSignal | undefined)[] = [];
		const fetchMock: FetchImpl = vi.fn(async (_input, init) => {
			capturedSignals.push(init?.signal ?? undefined);
			if (capturedSignals.length === 1) {
				// Simulate SGP timing out: throw an AbortError as AbortSignal.timeout would.
				throw new DOMException("The operation was aborted due to timeout.", "AbortError");
			}
			return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
		});

		await loginXiaomi({
			onPrompt: async () => "tp-test-key",
			onAuth: () => {},
			fetch: fetchMock,
		});

		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(capturedSignals[0]).toBeInstanceOf(AbortSignal);
		expect(capturedSignals[1]).toBeInstanceOf(AbortSignal);
		// Two distinct signals — proves a fresh timeout was created for AMS.
		expect(capturedSignals[0]).not.toBe(capturedSignals[1]);
		// And the AMS signal is not aborted (would be if the timeout signal were shared).
		expect(capturedSignals[1]?.aborted).toBe(false);
	});

	it("sends Authorization: Bearer header (not Anthropic-style x-api-key) for tp- keys", async () => {
		// Regression: commit 92e8ac06b moved validation from /anthropic/v1/messages to
		// /v1/chat/completions but kept the Anthropic-style `x-api-key` header. Xiaomi's
		// OpenAI-compatible endpoint requires Bearer auth and rejects x-api-key as 401
		// "Invalid API Key" — see issue #1580.
		const capturedHeaders: Record<string, string>[] = [];
		const fetchMock: FetchImpl = vi.fn(async (_input, init) => {
			capturedHeaders.push((init?.headers ?? {}) as Record<string, string>);
			return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
		});

		await loginXiaomi({
			onPrompt: async () => "tp-test-key",
			onAuth: () => {},
			fetch: fetchMock,
		});

		expect(fetchMock).toHaveBeenCalledTimes(1);
		const headers = capturedHeaders[0];
		expect(headers.Authorization).toBe("Bearer tp-test-key");
		expect(headers["x-api-key"]).toBeUndefined();
	});

	it("sends Authorization: Bearer for standard sk- keys as well", async () => {
		const capturedHeaders: Record<string, string>[] = [];
		const capturedUrls: string[] = [];
		const capturedBodies: string[] = [];
		const fetchMock: FetchImpl = vi.fn(async (input, init) => {
			capturedUrls.push(typeof input === "string" ? input : input.toString());
			capturedHeaders.push((init?.headers ?? {}) as Record<string, string>);
			capturedBodies.push(String(init?.body));
			return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
		});

		await loginXiaomi({
			onPrompt: async () => "sk-test-key",
			onAuth: () => {},
			fetch: fetchMock,
		});

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(capturedUrls[0]).toBe("https://api.xiaomimimo.com/v1/chat/completions");
		expect(JSON.parse(capturedBodies[0]).model).toBe("mimo-v2.5");
		const headers = capturedHeaders[0];
		expect(headers.Authorization).toBe("Bearer sk-test-key");
		expect(headers["x-api-key"]).toBeUndefined();
	});
});
