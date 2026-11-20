import { describe, expect, test } from "bun:test";
import { crusoeModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { FetchImpl } from "@oh-my-pi/pi-catalog/types";

const BASE_URL = "https://api.inference.crusoecloud.com/v1";

describe("Crusoe provider discovery", () => {
	test("authenticates discovery, restores reviewed metadata, and excludes speech-only models", async () => {
		const calls: Array<{ url: string; authorization: string | null }> = [];
		const fetch: FetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
			calls.push({
				url: String(input),
				authorization: new Headers(init?.headers).get("authorization"),
			});
			return Response.json({
				object: "list",
				data: [
					{ id: "deepseek-ai/DeepSeek-V4.1-Flash", object: "model" },
					{ id: "nvidia/Nemotron-3-VoiceChat", object: "model" },
				],
			});
		};

		const options = crusoeModelManagerOptions({ apiKey: "crusoe-test-key", fetch });
		const models = (await options.fetchDynamicModels?.()) ?? [];

		expect(calls).toEqual([{ url: `${BASE_URL}/models`, authorization: "Bearer crusoe-test-key" }]);
		expect(options.dynamicModelsAuthoritative).toBe(true);
		expect(models).toHaveLength(1);
		expect(models[0]).toMatchObject({
			id: "deepseek-ai/DeepSeek-V4.1-Flash",
			provider: "crusoe",
			api: "openai-completions",
			baseUrl: BASE_URL,
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 0.29, output: 1.2, cacheRead: 0.007, cacheWrite: 0 },
			contextWindow: 1_048_576,
		});
	});

	test("does not probe the credential-protected roster without a key", () => {
		expect(crusoeModelManagerOptions().fetchDynamicModels).toBeUndefined();
	});
});
