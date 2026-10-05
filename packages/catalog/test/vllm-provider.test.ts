import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { vllmModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { FetchImpl } from "@oh-my-pi/pi-catalog/types";

let originalBaseUrl: string | undefined;

beforeEach(() => {
	originalBaseUrl = Bun.env.VLLM_BASE_URL;
});

afterEach(() => {
	if (originalBaseUrl === undefined) delete Bun.env.VLLM_BASE_URL;
	else Bun.env.VLLM_BASE_URL = originalBaseUrl;
});

function recordingFetch(requestedUrls: string[]): FetchImpl {
	return async input => {
		requestedUrls.push(input instanceof Request ? input.url : input.toString());
		return new Response(JSON.stringify({ data: [{ id: "qwen3.8-27b", object: "model" }] }), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	};
}

describe("vLLM provider discovery", () => {
	test("lights up the reasoning dial for Qwen 3.8+ despite silent /v1/models metadata", async () => {
		// vLLM's /v1/models never advertises reasoning; without the id-based
		// upgrade a served Qwen3.8 loses its effort dial entirely and always
		// thinks at the template's xhigh default.
		const fetchMock: FetchImpl = async () =>
			new Response(
				JSON.stringify({
					data: [
						{ id: "qwen3.8-27b", object: "model", max_model_len: 262144 },
						{ id: "qwen2.5-coder-7b", object: "model", max_model_len: 131072 },
					],
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);

		const options = vllmModelManagerOptions({ fetch: fetchMock });
		const models = await options.fetchDynamicModels?.();

		expect(models?.find(model => model.id === "qwen3.8-27b")).toMatchObject({
			provider: "vllm",
			api: "openai-completions",
			reasoning: true,
			contextWindow: 262144,
		});
		// Non-thinking Qwen generations keep the wire-reported default.
		expect(models?.find(model => model.id === "qwen2.5-coder-7b")?.reasoning).toBe(false);
	});

	test("uses VLLM_BASE_URL when no explicit baseUrl is configured", async () => {
		Bun.env.VLLM_BASE_URL = "http://10.0.0.5:8003/v1";
		const requestedUrls: string[] = [];

		const options = vllmModelManagerOptions({ fetch: recordingFetch(requestedUrls) });
		const models = await options.fetchDynamicModels?.();

		expect(requestedUrls).toEqual(["http://10.0.0.5:8003/v1/models"]);
		expect(models?.[0]?.baseUrl).toBe("http://10.0.0.5:8003/v1");
	});

	test("falls back to the local default when VLLM_BASE_URL is blank", async () => {
		Bun.env.VLLM_BASE_URL = "  ";
		const requestedUrls: string[] = [];

		const options = vllmModelManagerOptions({ fetch: recordingFetch(requestedUrls) });
		await options.fetchDynamicModels?.();

		expect(requestedUrls).toEqual(["http://127.0.0.1:8000/v1/models"]);
	});

	test("keeps explicit baseUrl higher precedence than VLLM_BASE_URL", async () => {
		Bun.env.VLLM_BASE_URL = "http://vllm-env.example:8003/v1";
		const requestedUrls: string[] = [];

		const options = vllmModelManagerOptions({
			baseUrl: "http://vllm-config.example:9000/v1",
			fetch: recordingFetch(requestedUrls),
		});
		const models = await options.fetchDynamicModels?.();

		expect(requestedUrls).toEqual(["http://vllm-config.example:9000/v1/models"]);
		expect(models?.[0]?.baseUrl).toBe("http://vllm-config.example:9000/v1");
	});
});
