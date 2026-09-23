import { describe, expect, test } from "bun:test";
import { vllmModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { FetchImpl } from "@oh-my-pi/pi-catalog/types";

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
});
