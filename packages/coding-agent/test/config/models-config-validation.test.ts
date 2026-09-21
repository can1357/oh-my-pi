import { describe, expect, test } from "bun:test";
import { OmpErrors } from "@oh-my-pi/omptype";
import { getModelsConfigSchema } from "@oh-my-pi/pi-coding-agent/config/models-config-schema-bundle";
import {
	type ProviderValidationModel,
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

describe("models.yml image runner models", () => {
	const workflow = {
		path: "./workflows/flux.json",
		prompt: [{ nodeId: "6", input: "text" }],
		outputNode: "9",
	};
	/** Validate one custom model against a keyless provider, as a models.yml entry declares it. */
	const validate = (model: Omit<ProviderValidationModel, "id">, providerApi?: ProviderValidationModel["api"]) =>
		validateProviderConfiguration(
			"comfy-local",
			{
				baseUrl,
				auth: "none",
				...(providerApi ? { api: providerApi } : {}),
				models: [{ id: "flux-dev", ...model }],
			},
			"models-config",
		);

	test("accepts the keyless image runner pairings the image role admits", () => {
		expect(() => validate({ kind: "image", api: "comfyui", comfyui: { generation: workflow } })).not.toThrow();
		expect(() => validate({ kind: "image", api: "openai-images" })).not.toThrow();
	});

	test("rejects an image runner api without kind image, which would hide the model from the image role", () => {
		expect(() => validate({ api: "comfyui", comfyui: { generation: workflow } })).toThrow(
			'api "comfyui" requires kind: "image"',
		);
	});

	test("rejects kind image on a chat api, including a provider-level api the model-level schema cannot see", () => {
		expect(() => validate({ kind: "image" }, "openai-completions")).toThrow(
			'kind "image" requires an image api (openai-images, openrouter-images, comfyui)',
		);
	});

	test("requires a comfyui workflow config for api comfyui and rejects one anywhere else", () => {
		expect(() => validate({ kind: "image", api: "comfyui" })).toThrow(
			'api "comfyui" requires a "comfyui" workflow config',
		);
		expect(() => validate({ kind: "image", api: "openai-images", comfyui: { generation: workflow } })).toThrow(
			'"comfyui" config requires api "comfyui"',
		);
	});
});

describe("models.yml comfyui workflow schema", () => {
	const schema = getModelsConfigSchema();
	const generation = {
		path: "./workflows/flux.json",
		prompt: [{ nodeId: "6", input: "text" }],
		outputNode: "9",
	};
	const parseComfyui = (comfyui: Record<string, unknown>) =>
		schema({
			providers: {
				"comfy-local": {
					baseUrl: "http://127.0.0.1:8188",
					auth: "none" as const,
					models: [{ id: "flux-dev", kind: "image" as const, api: "comfyui" as const, comfyui }],
				},
			},
		});

	test("accepts a provider-level comfyui api inherited by its models", () => {
		// `api` may live at the provider or the model level, so the schema must not
		// reject the documented inherited form before the per-model pairing check.
		const provider = {
			baseUrl: "http://127.0.0.1:8188",
			api: "comfyui" as const,
			auth: "none" as const,
			models: [{ id: "flux-dev", kind: "image" as const, comfyui: { generation } }],
		};
		expect(schema({ providers: { "local-comfy": provider } }) instanceof OmpErrors).toBe(false);
		expect(() => validateProviderConfiguration("local-comfy", provider, "models-config")).not.toThrow();
	});

	test("rejects a workflow that accepts only one render dimension", () => {
		// A render supplies both dimensions together, so `width` without `height`
		// would silently keep the graph's preconfigured height.
		const parsed = parseComfyui({ generation: { ...generation, width: [{ nodeId: "5", input: "width" }] } });
		expect(parsed instanceof OmpErrors).toBe(true);
		if (parsed instanceof OmpErrors) expect(parsed.summary).toContain("width and height bindings together");
	});

	test("rejects a workflow that binds no prompt", () => {
		// The requested prompt reaches the graph only through a declared binding.
		const parsed = parseComfyui({ generation: { ...generation, prompt: [] } });
		expect(parsed instanceof OmpErrors).toBe(true);
		if (parsed instanceof OmpErrors) expect(parsed.summary).toContain("prompt with at least one binding");
	});

	test("rejects a timeout no 32-bit timer can honor", () => {
		const parsed = parseComfyui({ generation, timeoutMs: Number.MAX_SAFE_INTEGER });
		expect(parsed instanceof OmpErrors).toBe(true);
		if (parsed instanceof OmpErrors) expect(parsed.summary).toContain("comfyui.timeoutMs at most 2147483647");
	});
});
