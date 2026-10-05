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

	test("rejects a non-boolean statefulResponses override instead of silently storing responses", () => {
		const checked = ModelsConfigSchema(astraProxyConfig({ statefulResponses: "false" }));
		if (!(checked instanceof OmpErrors)) throw new Error("expected the schema to reject a string value");
		expect(checked.map(error => `${error.path.join(".")}: ${error.problem}`)).toEqual([
			expect.stringMatching(/^providers\.astra-proxy\.compat\.statefulResponses: must be boolean/),
		]);
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

describe("models.yml compat.extraBody applicability (#12087)", () => {
	const schema = getModelsConfigSchema();
	const providerConfig = (api: string, compat: unknown) => ({
		providers: {
			p: { baseUrl: "http://x/v1", apiKey: "K", api, compat },
		},
	});

	test("accepts extraBody for every API whose transport merges it", () => {
		for (const api of ["openai-completions", "openai-responses", "azure-openai-responses", "anthropic-messages"]) {
			const parsed = schema(providerConfig(api, { extraBody: { gateway: "m1-01" } }));
			expect(parsed instanceof OmpErrors).toBe(false);
		}
	});

	test("accepts extraBody on Azure Responses, which now merges it", () => {
		const parsed = schema(providerConfig("azure-openai-responses", { extraBody: { gateway: "m1-01" } }));
		expect(parsed instanceof OmpErrors).toBe(false);
	});

	test("rejects extraBody on the Codex transport, which strips caller parameters", () => {
		const parsed = schema(providerConfig("openai-codex-responses", { extraBody: { gateway: "m1-01" } }));
		expect(parsed instanceof OmpErrors).toBe(true);
		if (parsed instanceof OmpErrors) {
			expect(parsed.summary).toContain('compat.extraBody dropped for api "openai-codex-responses"');
		}
	});

	test("rejects extraBody for an API that would drop it, naming the api", () => {
		const parsed = schema(providerConfig("google-generative-ai", { extraBody: { gateway: "m1-01" } }));
		expect(parsed instanceof OmpErrors).toBe(true);
		if (parsed instanceof OmpErrors) {
			expect(parsed.summary).toContain('compat.extraBody dropped for api "google-generative-ai"');
		}
	});

	test("rejects extraBody on a Bedrock Converse route too", () => {
		const parsed = schema(providerConfig("bedrock-converse-stream", { extraBody: { gateway: "m1-01" } }));
		expect(parsed instanceof OmpErrors).toBe(true);
	});

	test("rejects extraBody declared on a model whose api does not merge it", () => {
		const parsed = schema({
			providers: {
				p: {
					baseUrl: "http://x/v1",
					apiKey: "K",
					models: [
						{
							id: "m",
							api: "google-generative-ai",
							input: ["text"],
							compat: { extraBody: { gateway: "m1-01" } },
						},
					],
				},
			},
		});
		expect(parsed instanceof OmpErrors).toBe(true);
		if (parsed instanceof OmpErrors) {
			expect(parsed.summary).toContain('compat.extraBody dropped for api "google-generative-ai"');
		}
	});

	test("leaves a provider without an explicit api alone (its models declare the api)", () => {
		const parsed = schema({
			providers: {
				p: { baseUrl: "http://x/v1", apiKey: "K", compat: { extraBody: { gateway: "m1-01" } } },
			},
		});
		expect(parsed instanceof OmpErrors).toBe(false);
	});
});
