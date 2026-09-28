import { describe, expect, it } from "bun:test";
import { stream } from "@oh-my-pi/pi-ai/stream";
import type { Context, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { COPILOT_API_HEADERS } from "@oh-my-pi/pi-catalog/wire/github-copilot";

function makeCopilotResponsesModel(baseUrl: string): Model<"openai-responses"> {
	return buildModel({
		id: "gpt-5-mini",
		name: "GPT-5 Mini",
		api: "openai-responses",
		provider: "github-copilot",
		baseUrl,
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 64000,
		headers: { ...COPILOT_API_HEADERS },
	});
}

function makeContext(): Context {
	return {
		systemPrompt: ["You are a helpful assistant."],
		messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
	};
}

/**
 * Issue #912: github-copilot provider hangs the UI on `Working...` and ESC
 * does not unstick it. The user-facing symptom is "spinner spins forever".
 *
 * Root cause exposed by this test: when the upstream Copilot SSE stream is
 * stuck (server holds the response open without sending events) and the
 * underlying body reader does not surface the AbortSignal, the provider's
 * stream-consumption loop only races the SDK iterator against the idle/first
 * -event watchdog (default 100s). It does NOT race against the caller's abort
 * signal, so ESC has no observable effect for ~100 seconds — exactly the
 * "infinite Working..." UX the user reports.
 *
 * The mock here returns a 200 + text/event-stream response whose body is a
 * ReadableStream that intentionally ignores the upstream signal — emulating
 * the broken Copilot path / a misbehaving HTTP/2 reverse proxy. The provider
 * MUST still settle within a tight bound after the caller aborts. We allow
 * up to 3 seconds to absorb scheduling jitter while still being orders of
 * magnitude tighter than the 100s watchdog.
 */
describe("issue #912 — github-copilot abort propagation", () => {
	it("settles within bounded time when the caller aborts a hung Copilot response that ignores fetch abort", async () => {
		const fetchInvoked = Promise.withResolvers<void>();

		// A body that never enqueues data and never reacts to the upstream
		// signal — this is the regression vector. Real Bun fetch normally
		// propagates abort to the body reader, but we cannot rely on it for
		// every transport (HTTP/2, intermediaries, native sockets).
		const fetchMock = (async (input: string | URL | Request, _init?: RequestInit): Promise<Response> => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			if (!url.endsWith("/responses")) {
				throw new Error(`Unexpected fetch to ${url}`);
			}

			const body = new ReadableStream<Uint8Array>({
				start(_controller) {
					// Intentionally do nothing. No enqueue, no close, no error.
					// The body parser will hang on the first read until something
					// closes it from outside (which here only ESC/abort can do).
				},
			});

			fetchInvoked.resolve();

			return new Response(body, {
				status: 200,
				headers: {
					"Content-Type": "text/event-stream",
					"Cache-Control": "no-cache",
				},
			});
		}) as typeof fetch;

		const model = makeCopilotResponsesModel("https://api.githubcopilot.example/test");
		const controller = new AbortController();
		const providerStream = stream(model, makeContext(), {
			apiKey: JSON.stringify({ token: "ghu_test_token", enterpriseUrl: undefined }),
			signal: controller.signal,
			fetch: fetchMock,
		});

		await fetchInvoked.promise;
		await Bun.sleep(50);
		controller.abort();

		// Bound: 3 seconds. The first-event watchdog default is 100s, so any
		// pass within 3s implies the provider observed the abort signal
		// directly rather than waiting for the watchdog.
		const result = await Promise.race([
			providerStream.result(),
			Bun.sleep(3_000).then(() => {
				throw new Error("providerStream.result() did not settle within 3s after abort");
			}),
		]);

		expect(result.stopReason).toBe("aborted");
	}, 10_000);
});
