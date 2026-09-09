import { describe, expect, it } from "bun:test";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import {
	KIMI_K27_CODE_RECOMMENDED_MAX_TOKENS,
	veniceModelManagerOptions,
} from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { FetchImpl } from "@oh-my-pi/pi-catalog/types";

describe("Venice provider catalog", () => {
	it("bundles Kimi K2.7 Code with its recommended output cap", () => {
		const model = getBundledModel("venice", "kimi-k2-7-code");

		expect(model).toBeDefined();
		expect(model.maxTokens).toBe(KIMI_K27_CODE_RECOMMENDED_MAX_TOKENS);
	});

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
});
