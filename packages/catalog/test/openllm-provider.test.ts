import { describe, expect, test } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { openllmModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { FetchImpl } from "@oh-my-pi/pi-catalog/types";

const OPENLLM_EFFORTS = [Effort.Low, Effort.Medium, Effort.High];

describe("OpenLLM provider discovery", () => {
	test("ships the fallback-chain aliases as static models", () => {
		const options = openllmModelManagerOptions();
		const ids = options.staticModels?.map(model => model.id);
		expect(ids).toEqual(["ultra", "plus", "lite"]);
		expect(options.staticModels?.map(model => model.priority)).toEqual([0, 1, 2]);
		const ultra = options.staticModels?.[0];
		expect(ultra).toMatchObject({
			provider: "openllm",
			api: "openai-responses",
			baseUrl: "http://127.0.0.1:8787/v1",
			contextWindow: 1_000_000,
			maxTokens: 128_000,
			reasoning: true,
			input: ["text", "image"],
		});
		// Chains can route to any model, so the aliases carry the full ladder.
		const built = buildModel(ultra!);
		expect(built.thinking).toMatchObject({ mode: "effort" });
		expect(built.thinking?.efforts).toEqual(OPENLLM_EFFORTS);
	});

	test("maps capabilities and limits from the daemon's /v1/models", async () => {
		let requestUrl: string | undefined;
		let authorization: string | null | undefined;
		const fetchMock: FetchImpl = async (input, init) => {
			requestUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
			authorization = new Headers(init?.headers).get("authorization");
			return new Response(
				JSON.stringify({
					object: "list",
					data: [
						{
							id: "plus",
							object: "model",
							display_name: "plus",
							capabilities: ["chat", "tools", "streaming", "reasoning"],
							context_window: 128000,
							max_output_tokens: 128000,
						},
						{
							id: "alibaba/qwen3.7-plus",
							object: "model",
							display_name: "Qwen 3.7 Plus",
							capabilities: ["chat", "tools", "vision", "streaming"],
							context_window: 1000000,
							max_output_tokens: 65536,
						},
					],
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		};

		const options = openllmModelManagerOptions({ baseUrl: "http://gateway.test/v1", fetch: fetchMock });
		const models = await options.fetchDynamicModels?.();

		expect(requestUrl).toBe("http://gateway.test/v1/models");
		// No apiKey configured: no Authorization header is sent. Placeholder-key
		// filtering is covered in coding-agent.
		expect(authorization).toBeNull();
		const plus = models?.find(model => model.id === "plus");
		expect(plus).toMatchObject({
			provider: "openllm",
			api: "openai-responses",
			baseUrl: "http://gateway.test/v1",
			reasoning: true,
			input: ["text"],
			contextWindow: 128000,
			maxTokens: 128000,
		});
		const builtPlus = buildModel(plus!);
		expect(builtPlus.thinking).toMatchObject({ mode: "effort" });
		expect(builtPlus.thinking?.efforts).toEqual(OPENLLM_EFFORTS);
		const qwen = models?.find(model => model.id === "alibaba/qwen3.7-plus");
		expect(qwen).toMatchObject({
			name: "Qwen 3.7 Plus",
			reasoning: false,
			input: ["text", "image"],
			contextWindow: 1000000,
			maxTokens: 65536,
		});
		expect(buildModel(qwen!).thinking).toBeUndefined();
	});
});
