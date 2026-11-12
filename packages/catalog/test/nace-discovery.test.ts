import { describe, expect, test } from "bun:test";
import { naceModelManagerOptions } from "../src/provider-models/special";

describe("Nace model discovery", () => {
	test("manager keeps the 5 offline seeds, honors NACE_BASE_URL, and merges live discovery with extra card fields", async () => {
		const previousBaseUrl = Bun.env.NACE_BASE_URL;
		Bun.env.NACE_BASE_URL = "https://nace.internal/";
		try {
			const unauthenticated = naceModelManagerOptions();
			expect(unauthenticated.dynamicModelsAuthoritative).toBeUndefined();
			expect(unauthenticated.fetchDynamicModels).toBeUndefined();
			expect(unauthenticated.staticModels?.map(model => ({ id: model.id, baseUrl: model.baseUrl }))).toEqual([
				{ id: "drex-max-v1.1", baseUrl: "https://nace.internal" },
				{ id: "drex-max-finance", baseUrl: "https://nace.internal" },
				{ id: "drex-v2.0", baseUrl: "https://nace.internal" },
				{ id: "drex-latest", baseUrl: "https://nace.internal" },
				{ id: "drex-max", baseUrl: "https://nace.internal" },
			]);

			const options = naceModelManagerOptions({
				apiKey: "nace-key",
				fetch: async input => {
					expect(String(input)).toBe("https://nace.internal/v1/models");
					return Response.json({
						models: [
							{
								name: "drex-latest",
								description: "Drex Latest",
								release_date: "2026-10-01",
								alias_for: "drex-v2.0",
							},
							{
								name: "drex-enterprise",
								description: "Drex Enterprise",
								release_date: "2026-10-10",
								alias_for: null,
							},
							{
								name: "drex-custom",
								description: "Drex Custom",
								release_date: "2026-10-12",
								alias_for: 42,
							},
						],
					});
				},
			});
			expect(options.providerId).toBe("nace");
			expect(options.dynamicModelsAuthoritative).toBe(true);
			expect((await options.fetchDynamicModels?.())?.map(model => model.id)).toEqual([
				"drex-latest",
				"drex-enterprise",
				"drex-custom",
				"drex-max-v1.1",
				"drex-max-finance",
				"drex-v2.0",
				"drex-max",
			]);
		} finally {
			if (previousBaseUrl === undefined) {
				delete Bun.env.NACE_BASE_URL;
			} else {
				Bun.env.NACE_BASE_URL = previousBaseUrl;
			}
		}
	});
});
