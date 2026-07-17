import { describe, expect, test } from "bun:test";
import { buildDevinFallbackModel } from "@pk-nerdsaver-ai/pi-catalog/provider-models/devin";
import { devinModelManagerOptions } from "@pk-nerdsaver-ai/pi-catalog/provider-models/special";

describe("Devin fallback model", () => {
	test("builds the deterministic offline SWE 1.6 seed", () => {
		const model = buildDevinFallbackModel();

		expect(model).toEqual({
			id: "swe-1-6",
			name: "SWE 1.6",
			api: "devin-agent",
			provider: "devin",
			baseUrl: "https://server.codeium.com",
			reasoning: false,
			input: ["text", "image"],
			supportsTools: true,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200_000,
			maxTokens: 64_000,
		});
	});

	test("exposes the fallback before credentialed authoritative discovery", () => {
		const offline = devinModelManagerOptions();
		expect(offline.staticModels).toEqual([buildDevinFallbackModel()]);
		expect(offline.dynamicModelsAuthoritative).toBeUndefined();
		expect(offline.fetchDynamicModels).toBeUndefined();

		const online = devinModelManagerOptions({ apiKey: "token", baseUrl: "https://devin.example" });
		expect(online.staticModels).toEqual([buildDevinFallbackModel("https://devin.example")]);
		expect(online.dynamicModelsAuthoritative).toBe(true);
		expect(typeof online.fetchDynamicModels).toBe("function");
	});
});
