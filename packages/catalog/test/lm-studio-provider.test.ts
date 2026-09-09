import { describe, expect, test, vi } from "bun:test";
import { lmStudioModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { FetchImpl } from "@oh-my-pi/pi-catalog/types";

describe("lm studio local provider discovery", () => {
	test("marks native VLM models as image-capable", async () => {
		const requestedUrls: string[] = [];
		const fetchMock: FetchImpl = vi.fn(async input => {
			const url = String(input);
			requestedUrls.push(url);
			if (url === "http://127.0.0.1:1234/api/v0/models") {
				return new Response(
					JSON.stringify({
						data: [
							{
								id: "qwen/qwen3.6-27b",
								type: "vlm",
								capabilities: ["tool_use"],
								max_context_length: 262144,
							},
							{ id: "plain-llm", type: "llm" },
						],
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			if (url === "http://127.0.0.1:1234/v1/models") {
				return new Response(
					JSON.stringify({
						data: [
							{ id: "qwen/qwen3.6-27b", object: "model" },
							{ id: "plain-llm", object: "model" },
						],
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			throw new Error(`Unexpected URL: ${url}`);
		});

		const models = await lmStudioModelManagerOptions({ fetch: fetchMock }).fetchDynamicModels?.();
		const vision = models?.find(model => model.id === "qwen/qwen3.6-27b");
		const text = models?.find(model => model.id === "plain-llm");

		expect(requestedUrls).toContain("http://127.0.0.1:1234/api/v0/models");
		expect(vision?.input).toEqual(["text", "image"]);
		expect(vision?.contextWindow).toBe(262144);
		expect(text?.input).toEqual(["text"]);
	});

	test("prefers the loaded context window over the architectural maximum", async () => {
		const fetchMock: FetchImpl = vi.fn(async input => {
			const url = String(input);
			if (url === "http://127.0.0.1:1234/api/v0/models") {
				return new Response(
					JSON.stringify({
						data: [
							{
								id: "loaded-small",
								type: "llm",
								state: "loaded",
								max_context_length: 262144,
								loaded_context_length: 81920,
							},
							{
								id: "unloaded",
								type: "llm",
								state: "not-loaded",
								max_context_length: 262144,
								loaded_context_length: null,
							},
						],
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			if (url === "http://127.0.0.1:1234/v1/models") {
				return new Response(
					JSON.stringify({
						data: [
							{ id: "loaded-small", object: "model" },
							{ id: "unloaded", object: "model" },
						],
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			throw new Error(`Unexpected URL: ${url}`);
		});

		const models = await lmStudioModelManagerOptions({ fetch: fetchMock }).fetchDynamicModels?.();
		const loaded = models?.find(model => model.id === "loaded-small");
		const unloaded = models?.find(model => model.id === "unloaded");

		expect(loaded?.contextWindow).toBe(81920);
		expect(unloaded?.contextWindow).toBe(262144);
	});

	test("falls back to the OpenAI-compatible catalog when native metadata hangs", async () => {
		let nativeAborted = false;
		let openAiCatalogStartedBeforeAbort = false;
		const fetchMock: FetchImpl = vi.fn(async (input, init) => {
			const url = String(input);
			if (url === "http://127.0.0.1:11434/api/v0/models") {
				const pending = Promise.withResolvers<Response>();
				const abort = () => {
					nativeAborted = true;
					pending.reject(new DOMException("Aborted", "AbortError"));
				};
				if (init?.signal?.aborted) {
					abort();
				} else {
					init?.signal?.addEventListener("abort", abort, { once: true });
				}
				return pending.promise;
			}
			if (url === "http://127.0.0.1:11434/v1/models") {
				openAiCatalogStartedBeforeAbort = !nativeAborted;
				return new Response(JSON.stringify({ data: [{ id: "omlx-model", object: "model" }] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			throw new Error(`Unexpected URL: ${url}`);
		});

		const models = await lmStudioModelManagerOptions({
			baseUrl: "http://127.0.0.1:11434/v1",
			fetch: fetchMock,
		}).fetchDynamicModels?.();

		expect(openAiCatalogStartedBeforeAbort).toBe(true);
		expect(nativeAborted).toBe(true);
		expect(models?.find(model => model.id === "omlx-model")?.input).toEqual(["text"]);
	});
});
