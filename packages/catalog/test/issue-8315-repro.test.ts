import { describe, expect, it } from "bun:test";
import { fetchOpenAICompatibleModels } from "../src/discovery/openai-compatible";
import type { FetchImpl } from "../src/types";

// Issue #8315: `omp` hung at startup in `resolveModelDiscoveryFallback`.
// Built-in OpenAI-compatible provider managers (openrouter, xAI, DeepSeek, …)
// call `fetchOpenAICompatibleModels` with neither a `signal` nor a `timeoutMs`,
// and the no-timeout branch issued the request with `signal: undefined` — so a
// stalled `/models` endpoint left the fetch pending forever and blocked the
// awaited discovery pass indefinitely.
describe("issue #8315: OpenAI-compatible discovery must be bounded by default", () => {
	it("arms an abort deadline when the caller supplies neither signal nor timeoutMs", async () => {
		let received: AbortSignal | null | undefined = null;
		const capturingFetch: FetchImpl = async (_url, init) => {
			received = init?.signal;
			return new Response(JSON.stringify({ data: [{ id: "m1" }] }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		};

		const models = await fetchOpenAICompatibleModels({
			api: "openai-completions",
			provider: "custom",
			baseUrl: "https://stall.example/v1",
			fetch: capturingFetch,
		});

		// Regression guard: previously the transport received `signal: undefined`
		// (unbounded). It must now carry a default deadline.
		expect(received).toBeInstanceOf(AbortSignal);
		expect(models).not.toBeNull();
		expect(models?.map(model => model.id)).toEqual(["m1"]);
	});

	it("resolves to null instead of hanging when the endpoint never responds", async () => {
		// Honors the deadline signal by rejecting on abort; never resolves otherwise.
		const stallingFetch: FetchImpl = (_url, init) => {
			const { promise, reject } = Promise.withResolvers<Response>();
			const signal = init?.signal;
			signal?.addEventListener("abort", () => reject(signal.reason ?? new Error("aborted")));
			return promise;
		};

		const models = await fetchOpenAICompatibleModels({
			api: "openai-completions",
			provider: "custom",
			baseUrl: "https://stall.example/v1",
			fetch: stallingFetch,
			timeoutMs: 50,
		});

		expect(models).toBeNull();
	});
});
