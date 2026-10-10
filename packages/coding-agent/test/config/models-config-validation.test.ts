import { describe, expect, test } from "bun:test";
import { OmpErrors } from "@oh-my-pi/omptype";
import { getModelsConfigSchema } from "@oh-my-pi/pi-coding-agent/config/models-config-schema-bundle";
import {
	type ProviderValidationConfig,
	validateProviderConfiguration,
} from "@oh-my-pi/pi-coding-agent/config/models-config";
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

describe("model kind must match its api", () => {
	const validate = (config: Omit<ProviderValidationConfig, "baseUrl">) => () =>
		validateProviderConfiguration("gateway", { baseUrl, apiKey: "key", ...config }, "models-config");

	test("rejects a model kind its api cannot serve", () => {
		expect(validate({ models: [{ id: "img", api: "openai-completions", kind: "image" }] })).toThrow(
			/model img: kind "image" does not match api "openai-completions", which serves kind "chat"/,
		);
		expect(validate({ models: [{ id: "img", api: "openai-images", kind: "chat" }] })).toThrow(
			/model img: kind "chat" does not match api "openai-images", which serves kind "image"/,
		);
		expect(validate({ models: [{ id: "img", api: "openai-images", kind: "image" }] })).not.toThrow();
	});

	test("chat transports serve chat and tiny, plus image where generate_image runs them", () => {
		expect(validate({ models: [{ id: "gpt-image-2", api: "openai-responses", kind: "image" }] })).not.toThrow();
		expect(
			validate({ models: [{ id: "gemini-3-pro-image", api: "google-generative-ai", kind: "image" }] }),
		).not.toThrow();
		expect(validate({ models: [{ id: "qwen-small", api: "openai-completions", kind: "tiny" }] })).not.toThrow();
		expect(validate({ models: [{ id: "voice", api: "openai-responses", kind: "tts" }] })).toThrow(
			/model voice: kind "tts" does not match api "openai-responses"/,
		);
	});

	test("the schema rejects kind search, which no models.yml api serves", () => {
		const checked = ModelsConfigSchema({
			providers: {
				gateway: { baseUrl, apiKey: "key", api: "openai-completions", models: [{ id: "s", kind: "search" }] },
			},
		});
		if (!(checked instanceof OmpErrors)) throw new Error("expected the schema to reject kind search");
		expect(checked.summary).toContain("providers.gateway.models[0].kind");
		expect(checked.summary).toContain('(was "search")');
	});

	test("accepts every judgment API at provider level and rejects a chat kind on it", () => {
		for (const api of ["typesafe", "openrouter-decisions", "cloudflare-systemone"] as const) {
			const checked = ModelsConfigSchema({
				providers: { judges: { baseUrl, apiKey: "key", api, models: [{ id: "@cf/cloudflare/clef-flash" }] } },
			});
			if (checked instanceof OmpErrors) throw new Error(checked.summary);
			expect(checked.providers?.judges?.api).toBe(api);
		}
		expect(
			validate({ api: "cloudflare-systemone", models: [{ id: "@cf/cloudflare/clef-flash", kind: "judge" }] }),
		).not.toThrow();
		expect(validate({ api: "cloudflare-systemone", models: [{ id: "x", kind: "chat" }] })).toThrow(
			/model x: kind "chat" does not match api "cloudflare-systemone", which serves kind "judge"/,
		);
	});

	test("checks an override kind against an api the file names", () => {
		const provider = { api: "openai-responses" as const, models: [{ id: "gpt-image-2" }] };
		expect(validate({ ...provider, modelOverrides: { "gpt-image-2": { kind: "tts" } } })).toThrow(
			/modelOverrides\.gpt-image-2: kind "tts" does not match api "openai-responses"/,
		);
		expect(validate({ models: [], modelOverrides: { x: { kind: "tts", api: "openai-images" } } })).toThrow(
			/modelOverrides\.x: kind "tts" does not match api "openai-images"/,
		);
		expect(
			validate({ ...provider, modelOverrides: { "gpt-image-2": { kind: "image", api: "openai-images" } } }),
		).not.toThrow();
	});

	test("leaves an undeclared model's override kind to the api the model resolves to", () => {
		// A built-in provider names no api in the file.
		expect(() =>
			validateProviderConfiguration(
				"openrouter",
				{ models: [], modelOverrides: { "black-forest-labs/flux.2-flex": { kind: "image" } } },
				"models-config",
			),
		).not.toThrow();
		// A discovered row can get a runner api (here `openai-embeddings`), not the provider's chat api.
		expect(
			validate({
				api: "openai-completions",
				discovery: { type: "openai-models-list" },
				models: [],
				modelOverrides: { "embed-x": { kind: "embedding" } },
			}),
		).not.toThrow();
	});

	test("multi-kind local-inference accepts any kind", () => {
		expect(() =>
			validateProviderConfiguration(
				"local-rt",
				{ baseUrl, apiKey: "key", models: [{ id: "whisper", api: "local-inference", kind: "stt" }] },
				"runtime-register",
			),
		).not.toThrow();
	});
});
