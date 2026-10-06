import { describe, expect, it } from "bun:test";
import {
	KIMI_K27_CODE_RECOMMENDED_MAX_TOKENS,
	veniceModelManagerOptions,
} from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { FetchImpl } from "@oh-my-pi/pi-catalog/types";

describe("Venice provider catalog", () => {
	it("caps Kimi K2.7 Code during runtime discovery", async () => {
		const requestedUrls: string[] = [];
		const fetchImpl: FetchImpl = async input => {
			requestedUrls.push(input instanceof Request ? input.url : String(input));
			return new Response(
				JSON.stringify({
					data: [
						{
							id: "kimi-k2-7-code",
							name: "kimi-k2-7-code",
							context_length: 256_000,
							max_completion_tokens: 262_144,
						},
					],
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		};

		const options = veniceModelManagerOptions({ apiKey: "venice-test-key", fetch: fetchImpl });
		const models = await options.fetchDynamicModels?.();
		const model = models?.find(candidate => candidate.id === "kimi-k2-7-code");

		expect(requestedUrls).toEqual(["https://api.venice.ai/api/v1/models"]);
		expect(model).toBeDefined();
		expect(model?.maxTokens).toBe(KIMI_K27_CODE_RECOMMENDED_MAX_TOKENS);
	});

	it("flags the model carrying the `default` trait as the provider default", async () => {
		const fetchImpl: FetchImpl = async () =>
			new Response(
				JSON.stringify({
					data: [
						{ id: "zai-org-glm-5-2", name: "GLM 5.2", model_spec: { traits: ["default", "fast"] } },
						{ id: "kimi-k2-7-code", name: "Kimi K2.7 Code", model_spec: { traits: ["code"] } },
						{ id: "deepseek-v4-flash", name: "DeepSeek V4 Flash" },
					],
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);

		const options = veniceModelManagerOptions({ apiKey: "venice-test-key", fetch: fetchImpl });
		const models = await options.fetchDynamicModels?.();
		const byId = new Map(models?.map(model => [model.id, model]));

		expect(byId.get("zai-org-glm-5-2")?.isProviderDefault).toBe(true);
		expect(byId.get("kimi-k2-7-code")?.isProviderDefault).toBeUndefined();
		expect(byId.get("deepseek-v4-flash")?.isProviderDefault).toBeUndefined();
	});
});
