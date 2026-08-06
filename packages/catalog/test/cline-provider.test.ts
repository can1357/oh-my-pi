import { describe, expect, test } from "bun:test";
import { getBundledModels } from "@pk-nerdsaver-ai/pi-catalog/models";
import {
	DEFAULT_MODEL_PER_PROVIDER,
	PROVIDER_DESCRIPTORS,
} from "@pk-nerdsaver-ai/pi-catalog/provider-models/descriptors";
import {
	buildClinePassStaticSeed,
	buildClineStaticSeed,
	clineModelManagerOptions,
	clinePassModelManagerOptions,
} from "@pk-nerdsaver-ai/pi-catalog/provider-models/openai-compat";

describe("Cline catalog providers", () => {
	test("keeps Cline usage-billing and ClinePass as separate provider descriptors", () => {
		const cline = PROVIDER_DESCRIPTORS.find(descriptor => descriptor.providerId === "cline");
		const clinePass = PROVIDER_DESCRIPTORS.find(descriptor => descriptor.providerId === "cline-pass");

		const clineManager = cline?.createModelManagerOptions({ apiKey: "k" });
		expect(cline?.defaultModel).toBe("anthropic/claude-sonnet-4-6");
		expect(cline?.catalogDiscovery?.oauthProvider).toBe("cline");
		expect(clineManager?.providerId).toBe("cline");
		expect(clineManager?.cacheProviderId).toBe("cline-canonical-v2");
		expect(DEFAULT_MODEL_PER_PROVIDER.cline).toBe("anthropic/claude-sonnet-4-6");

		expect(clinePass?.defaultModel).toBe("cline-pass/deepseek-v4-flash");
		expect(clinePass?.catalogDiscovery).toMatchObject({
			label: "ClinePass",
			allowUnauthenticated: true,
		});
		expect(clinePass?.createModelManagerOptions({ apiKey: "k" }).providerId).toBe("cline-pass");
		expect(DEFAULT_MODEL_PER_PROVIDER["cline-pass"]).toBe("cline-pass/deepseek-v4-flash");
	});

	test("ships distinct static catalogs on the shared Cline API base URL", () => {
		const clineSeed = buildClineStaticSeed();
		const clinePassSeed = buildClinePassStaticSeed();
		const bundledClinePass = getBundledModels("cline-pass");

		expect(clineSeed.map(model => model.id)).toContain("anthropic/claude-sonnet-4-6");
		expect(clineSeed.some(model => model.id.startsWith("cline-pass/"))).toBe(false);
		expect(clinePassSeed.map(model => model.id)).toEqual(
			expect.arrayContaining([
				"cline-pass/deepseek-v4-flash",
				"cline-pass/qwen3.8-max",
				"cline-pass/glm-5.2",
				"cline-pass/kimi-k3",
			]),
		);
		expect(bundledClinePass.map(model => model.id)).toEqual(
			expect.arrayContaining(["cline-pass/deepseek-v4-flash", "cline-pass/qwen3.8-max"]),
		);
		expect(bundledClinePass).toHaveLength(12);
		for (const model of clineSeed) {
			expect(model.provider).toBe("cline");
			expect(model.baseUrl).toBe("https://api.cline.bot/api/v1");
			expect(model.api).toBe("openai-completions");
		}
		for (const model of clinePassSeed) {
			expect(model.provider).toBe("cline-pass");
			expect(model.baseUrl).toBe("https://api.cline.bot/api/v1");
			expect(model.api).toBe("openai-completions");
			expect(model.id.startsWith("cline-pass/")).toBe(true);
		}
	});

	test("filters subscription models out of canonical Cline discovery", async () => {
		const requests: string[] = [];
		const options = clineModelManagerOptions({
			apiKey: "cline-token",
			fetch: async input => {
				requests.push(input.toString());
				return Response.json({
					data: [
						{ id: "anthropic/claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
						{ id: "cline-pass/qwen3.8-max", name: "Qwen3.8 Max" },
					],
				});
			},
		});

		const models = await options.fetchDynamicModels?.();

		expect(options.dynamicModelsAuthoritative).toBe(true);
		expect(requests).toEqual(["https://api.cline.bot/api/v1/models"]);
		expect(models?.map(model => model.id)).toEqual(["anthropic/claude-sonnet-4-6"]);
		expect(models?.[0]?.provider).toBe("cline");
	});

	test("discovers only ClinePass models from Cline's public recommendation feed", async () => {
		const requests: string[] = [];
		const options = clinePassModelManagerOptions({
			fetch: async input => {
				requests.push(input.toString());
				return Response.json({
					recommended: [{ id: "anthropic/claude-sonnet-4-6", name: "Claude Sonnet 4.6" }],
					clinePass: [
						{ id: "cline-pass/qwen3.8-max", name: "Qwen3.8 Max (subscription)" },
						{ id: "anthropic/claude-sonnet-4-6", name: "Not a pass model" },
					],
				});
			},
		});

		const models = await options.fetchDynamicModels?.();

		expect(options.providerId).toBe("cline-pass");
		expect(options.dynamicModelsAuthoritative).toBe(true);
		expect(requests).toEqual(["https://api.cline.bot/api/v1/ai/cline/recommended-models"]);
		expect(models?.map(model => model.id)).toEqual(["cline-pass/qwen3.8-max"]);
		expect(models?.[0]).toMatchObject({
			name: "Qwen3.8 Max (subscription)",
			provider: "cline-pass",
			baseUrl: "https://api.cline.bot/api/v1",
			contextWindow: 1_000_000,
			maxTokens: 131_072,
		});
	});
});
