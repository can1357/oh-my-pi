import { describe, expect, test } from "bun:test";
import { OmpErrors } from "@oh-my-pi/omptype";
import { getModelsConfigSchema } from "@oh-my-pi/pi-coding-agent/config/models-config-schema-bundle";
import { validateProviderConfiguration } from "@oh-my-pi/pi-coding-agent/config/models-config";
import { type ModelsConfig, ModelsConfigSchema } from "@oh-my-pi/pi-coding-agent/config/models-config-schema";

const models = [{ id: "grok-4", api: "openai-completions" as const }];
const baseUrl = "https://api.example.invalid/v1";

describe("validateProviderConfiguration (models-config auth)", () => {
	test("auth: oauth allows custom models without apiKey", () => {
		expect(() =>
			validateProviderConfiguration("xai-oauth", { baseUrl, auth: "oauth", models }, "models-config"),
		).not.toThrow();
	});

	test("auth: none allows custom models without apiKey", () => {
		expect(() =>
			validateProviderConfiguration("local", { baseUrl, auth: "none", models }, "models-config"),
		).not.toThrow();
	});

	test("default auth (apiKey) still requires apiKey for custom models", () => {
		expect(() => validateProviderConfiguration("custom", { baseUrl, models }, "models-config")).toThrow(
			'Provider custom: "apiKey" is required when defining custom models unless auth is "none" or "oauth".',
		);
	});

	test("explicit auth: apiKey with apiKey set passes", () => {
		expect(() =>
			validateProviderConfiguration(
				"custom",
				{ baseUrl, auth: "apiKey", apiKey: "sk-test", models },
				"models-config",
			),
		).not.toThrow();
	});
});

describe("ModelsConfigSchema Responses compat overrides", () => {
	/** A custom Responses-compatible proxy serving gpt-6-astra, as a user writes it in models.yml. */
	function astraProxyConfig(compat: Record<string, unknown>): unknown {
		return {
			providers: {
				"astra-proxy": {
					baseUrl,
					apiKey: "sk-test",
					api: "openai-responses",
					compat,
					models: [{ id: "gpt-6-astra", reasoning: true }],
				},
			},
		};
	}

	test("accepts a boolean supportsConfigurationUpdate override and keeps its value", () => {
		for (const value of [false, true]) {
			const checked = ModelsConfigSchema(astraProxyConfig({ supportsConfigurationUpdate: value }));
			if (checked instanceof OmpErrors) throw new Error(checked.summary);
			const config: ModelsConfig = checked;
			expect(config.providers?.["astra-proxy"]?.compat?.supportsConfigurationUpdate).toBe(value);
		}
	});

	test("rejects a non-boolean supportsConfigurationUpdate override instead of passing the typo through", () => {
		// A truthy string would reach the driver as "enabled"; the schema must
		// name the key and the expected type like it does for its declared siblings.
		const checked = ModelsConfigSchema(astraProxyConfig({ supportsConfigurationUpdate: "no" }));
		if (!(checked instanceof OmpErrors)) throw new Error("expected the schema to reject a string value");
		expect(checked.map(error => `${error.path.join(".")}: ${error.problem}`)).toEqual([
			expect.stringMatching(/^providers\.astra-proxy\.compat\.supportsConfigurationUpdate: must be boolean/),
		]);
	});
});

describe("models.yml compat.stripImageInput (#11697)", () => {
	const schema = getModelsConfigSchema();
	const configWithModelCompat = (compat: unknown) => ({
		providers: {
			p: {
				baseUrl: "http://x/v1",
				apiKey: "K",
				api: "openai-completions" as const,
				models: [{ id: "m", input: ["text", "image"] as ("text" | "image")[], compat }],
			},
		},
	});

	test("accepts a boolean opt-out and preserves it", () => {
		const parsed = schema(configWithModelCompat({ stripImageInput: false }));
		expect(parsed instanceof OmpErrors).toBe(false);
		if (!(parsed instanceof OmpErrors)) {
			expect(parsed.providers?.p?.models?.[0]?.compat).toMatchObject({ stripImageInput: false });
		}
	});

	test("rejects a wrong-typed opt-out instead of silently ignoring it", () => {
		const parsed = schema(configWithModelCompat({ stripImageInput: "no" }));
		expect(parsed instanceof OmpErrors).toBe(true);
		if (parsed instanceof OmpErrors) {
			expect(parsed.summary).toContain("stripImageInput");
		}
	});
});
