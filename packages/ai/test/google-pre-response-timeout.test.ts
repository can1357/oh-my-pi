import { afterEach, describe, expect, it, vi } from "bun:test";
import { streamGoogle } from "@oh-my-pi/pi-ai/providers/google";
import type { Context, FetchImpl, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

/**
 * Issue #16991: the native Google transport (`google-generative-ai`, shared with
 * `google-vertex`) called `fetch` without Bun's `timeout: false`, so Bun's
 * implicit ~300s ceiling killed slow-prefill requests with
 * `The operation timed out.` before the configured first-event watchdog.
 * The transport now disables that ceiling and owns a clearable pre-response
 * deadline instead. Fake timers advance the deadline from inside the fetch stub.
 */

const model: Model<"google-generative-ai"> = buildModel({
	id: "gemini-3-flash",
	name: "Gemini 3 Flash",
	api: "google-generative-ai",
	provider: "google",
	baseUrl: "https://generativelanguage.example/v1beta",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 32_000,
});

const context: Context = { messages: [{ role: "user", content: "hi", timestamp: 1 }] };

const okChunk = `data: ${JSON.stringify({
	candidates: [{ content: { role: "model", parts: [{ text: "OK" }] }, finishReason: "STOP" }],
	usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
})}\n\n`;

function fetchStub(handler: (init: RequestInit | undefined) => Promise<Response>): FetchImpl {
	return Object.assign((_input: string | URL | Request, init?: RequestInit) => handler(init), {
		preconnect: globalThis.fetch.preconnect,
	});
}

describe("native Google stream pre-response timeout", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("disables Bun's fetch ceiling and fails a header-less request at the configured first-event deadline", async () => {
		vi.useFakeTimers();
		let forwardedTimeout: unknown;
		let abortedBeforeDeadline: boolean | undefined;
		const fetch = fetchStub(init => {
			forwardedTimeout = init && "timeout" in init ? init.timeout : undefined;
			const { promise, reject } = Promise.withResolvers<Response>();
			init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
			vi.advanceTimersByTime(49);
			abortedBeforeDeadline = init?.signal?.aborted;
			vi.advanceTimersByTime(1);
			return promise;
		});

		const result = await streamGoogle(model, context, {
			apiKey: "test",
			fetch,
			streamFirstEventTimeoutMs: 50,
		}).result();

		expect(forwardedTimeout).toBe(false);
		expect(abortedBeforeDeadline).toBe(false);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("timed out");
	});

	it("does not abort a body that streams past the first-event deadline once headers arrived", async () => {
		vi.useFakeTimers();
		const fetch = fetchStub(async init => {
			// `highWaterMark: 0` defers `pull` until the provider reads the body,
			// i.e. after `fetch` resolved and the pre-response timer was cleared.
			const body = new ReadableStream<Uint8Array>(
				{
					pull(controller) {
						vi.advanceTimersByTime(10_000);
						if (init?.signal?.aborted) {
							controller.error(init.signal.reason);
							return;
						}
						controller.enqueue(new TextEncoder().encode(okChunk));
						controller.close();
					},
				},
				{ highWaterMark: 0 },
			);
			return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
		});

		const result = await streamGoogle(model, context, {
			apiKey: "test",
			fetch,
			streamFirstEventTimeoutMs: 50,
		}).result();

		expect(result.errorMessage).toBeUndefined();
		expect(result.stopReason).toBe("stop");
		expect(result.content).toEqual([{ type: "text", text: "OK" }]);
	});
});
