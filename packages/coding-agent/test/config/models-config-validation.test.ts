import { describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { type Api, AuthStorage, type Model } from "@oh-my-pi/pi-ai";
import { unregisterOAuthProviders } from "@oh-my-pi/pi-ai/oauth";
import { extractProviderRetryHint } from "@oh-my-pi/pi-ai/utils/retry-after";
import { AXES } from "@oh-my-pi/pi-catalog/compat/axes";
import { getBundledModels } from "@oh-my-pi/pi-catalog/models";
import { OmpErrors } from "@oh-my-pi/omptype";
import { ModelsConfigFile } from "@oh-my-pi/pi-coding-agent/config/models-config";
import { ModelRegistry, type ProviderConfigInput } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { getModelsConfigSchema } from "@oh-my-pi/pi-coding-agent/config/models-config-schema-bundle";
import {
	type ProviderValidationConfig,
	validateProviderConfiguration,
} from "@oh-my-pi/pi-coding-agent/config/models-config";
import { type ModelsConfig, ModelsConfigSchema } from "@oh-my-pi/pi-coding-agent/config/models-config-schema";
import { TempDir } from "@oh-my-pi/pi-utils";

const models = [{ id: "grok-4", api: "openai-completions" as const }];
const baseUrl = "https://api.example.invalid/v1";

describe("retry reset timezone configuration", () => {
	test("rejects malformed provider offsets before they can change a retry deadline", () => {
		// Missing sign, non-canonical width, invalid minutes, out-of-range hours,
		// the 14-hour boundary, and named zones exercise distinct validation edges.
		for (const offset of ["08:00", "+8:00", "+08:60", "+15:00", "-14:01", "Asia/Shanghai"]) {
			const checked = ModelsConfigSchema({ providers: { proxy: { retryResetTimezoneOffset: offset } } });
			if (!(checked instanceof OmpErrors)) throw new Error(`accepted invalid offset ${offset}`);
			expect(checked.summary).toContain("retryResetTimezoneOffset");
		}
	});

	test("validates both model definitions and modelOverrides instead of accepting an invalid model offset", () => {
		for (const provider of [
			{ models: [{ id: "route", retryResetTimezoneOffset: "+14:30" }] },
			{ modelOverrides: { route: { retryResetTimezoneOffset: 8 } } },
		]) {
			const checked = ModelsConfigSchema({ providers: { proxy: provider } });
			if (!(checked instanceof OmpErrors)) throw new Error("accepted invalid model offset");
			expect(checked.summary).toContain("retryResetTimezoneOffset");
		}
	});

	test("runtime registrations reject invalid provider and model offsets", async () => {
		using dir = TempDir.createSync("@retry-timezone-validation-");
		const authStorage = await AuthStorage.create(":memory:");
		try {
			const registry = new ModelRegistry(authStorage, path.join(dir.path(), "models.yml"));
			expect(() => registry.registerProvider("proxy", { retryResetTimezoneOffset: "+14:01" })).toThrow(
				/retryResetTimezoneOffset/,
			);
			expect(() =>
				registry.registerProvider("proxy", {
					baseUrl,
					apiKey: "key",
					api: "openai-completions",
					models: [{ ...runtimeModel, retryResetTimezoneOffset: "UTC+8" }],
				}),
			).toThrow(/model route: retryResetTimezoneOffset/);
		} finally {
			authStorage.close();
		}
	});

	const runtimeModel: NonNullable<ProviderConfigInput["models"]>[number] = {
		id: "route",
		name: "Route",
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 4096,
	};

	function retryDelay(registry: ModelRegistry, provider: string, id: string): number | undefined {
		const model = registry.find(provider, id);
		if (!model) throw new Error(`missing ${provider}/${id}`);
		const clock = spyOn(Date, "now").mockReturnValue(Date.parse("2026-11-17T00:00:00Z"));
		try {
			return extractProviderRetryHint(provider, "Your limit will reset at 2026-11-18 00:00:00", model);
		} finally {
			clock.mockRestore();
		}
	}

	test("model settings override a localhost provider default and retain retry deadlines after refresh", async () => {
		using dir = TempDir.createSync("@retry-timezone-precedence-");
		const file = path.join(dir.path(), "models.yml");
		await Bun.write(
			file,
			Bun.YAML.stringify({
				providers: {
					proxy: {
						baseUrl: "http://localhost:8080/v1",
						api: "openai-completions",
						auth: "none",
						retryResetTimezoneOffset: "+08:00",
						models: [
							{ id: "inherited" },
							{ id: "model-zone", retryResetTimezoneOffset: "-03:30" },
							{ id: "override-zone", retryResetTimezoneOffset: "+14:00" },
						],
						modelOverrides: { "override-zone": { retryResetTimezoneOffset: "Z" } },
					},
				},
			}),
		);
		const authStorage = await AuthStorage.create(":memory:");
		try {
			const registry = new ModelRegistry(authStorage, file);
			expect(retryDelay(registry, "proxy", "inherited")).toBe(16 * 60 * 60 * 1000);
			expect(retryDelay(registry, "proxy", "model-zone")).toBe(27.5 * 60 * 60 * 1000);
			expect(retryDelay(registry, "proxy", "override-zone")).toBe(24 * 60 * 60 * 1000);
			await registry.refresh("offline", { refreshCommandCredentials: true });
			expect(retryDelay(registry, "proxy", "override-zone")).toBe(24 * 60 * 60 * 1000);
		} finally {
			authStorage.close();
		}
	});

	test("changing a runtime provider default updates inherited deadlines but preserves model and modelOverrides settings", async () => {
		using dir = TempDir.createSync("@retry-timezone-runtime-");
		const file = path.join(dir.path(), "models.yml");
		await Bun.write(
			file,
			Bun.YAML.stringify({
				providers: { proxy: { modelOverrides: { overridden: { retryResetTimezoneOffset: "-03:30" } } } },
			}),
		);
		const authStorage = await AuthStorage.create(":memory:");
		try {
			const registry = new ModelRegistry(authStorage, file);
			registry.registerProvider("proxy", {
				baseUrl,
				apiKey: "key",
				api: "openai-completions",
				retryResetTimezoneOffset: "+14:00",
				models: [
					runtimeModel,
					{ ...runtimeModel, id: "explicit", retryResetTimezoneOffset: "-14:00" },
					{ ...runtimeModel, id: "overridden", retryResetTimezoneOffset: "+14:00" },
				],
			});
			expect(retryDelay(registry, "proxy", "route")).toBe(10 * 60 * 60 * 1000);
			expect(retryDelay(registry, "proxy", "explicit")).toBe(38 * 60 * 60 * 1000);
			// Exercise both lazy provider lookups and an already materialized catalog.
			registry.registerProvider("proxy", { retryResetTimezoneOffset: "+08:00" });
			expect(retryDelay(registry, "proxy", "route")).toBe(16 * 60 * 60 * 1000);
			registry.getAll();
			registry.registerProvider("proxy", { retryResetTimezoneOffset: "Z" });
			expect(retryDelay(registry, "proxy", "route")).toBe(24 * 60 * 60 * 1000);
			expect(retryDelay(registry, "proxy", "explicit")).toBe(38 * 60 * 60 * 1000);
			expect(retryDelay(registry, "proxy", "overridden")).toBe(27.5 * 60 * 60 * 1000);
			await registry.refresh("offline");
			expect(retryDelay(registry, "proxy", "route")).toBe(24 * 60 * 60 * 1000);
			expect(retryDelay(registry, "proxy", "explicit")).toBe(38 * 60 * 60 * 1000);
			expect(retryDelay(registry, "proxy", "overridden")).toBe(27.5 * 60 * 60 * 1000);
			registry.registerProvider("proxy", {
				baseUrl,
				apiKey: "key",
				api: "openai-completions",
				models: [{ ...runtimeModel, id: "overridden", retryResetTimezoneOffset: "+14:00" }],
			});
			expect(retryDelay(registry, "proxy", "overridden")).toBe(27.5 * 60 * 60 * 1000);
		} finally {
			authStorage.close();
		}
	});

	test("an offset-only provider override replaces the bundled provider timezone", async () => {
		using dir = TempDir.createSync("@retry-timezone-bundled-");
		const file = path.join(dir.path(), "models.yml");
		await Bun.write(file, Bun.YAML.stringify({ providers: { zai: { retryResetTimezoneOffset: "Z" } } }));
		const authStorage = await AuthStorage.create(":memory:");
		try {
			const registry = new ModelRegistry(authStorage, file);
			const model = getBundledModels("zai")[0];
			if (!model) throw new Error("expected a bundled provider model");
			expect(retryDelay(registry, "zai", model.id)).toBe(24 * 60 * 60 * 1000);
			await Bun.write(file, Bun.YAML.stringify({ providers: { zai: { retryResetTimezoneOffset: "+08:00" } } }));
			await registry.refresh("offline", { refreshCommandCredentials: true });
			expect(retryDelay(registry, "zai", model.id)).toBe(16 * 60 * 60 * 1000);
		} finally {
			authStorage.close();
		}
	});

	test("a collapsed model retains its explicit offset while an inherited offset follows a live default change", async () => {
		using dir = TempDir.createSync("@retry-timezone-alias-");
		const authStorage = await AuthStorage.create(":memory:");
		try {
			const registry = new ModelRegistry(authStorage, path.join(dir.path(), "models.yml"));
			registry.registerProvider("google-antigravity", {
				baseUrl,
				apiKey: "key",
				api: "openai-completions",
				retryResetTimezoneOffset: "+08:00",
				// Future revisions exercise the reviewed collapse grammar without bundled rows.
				models: [
					{ ...runtimeModel, id: "gemini-99.0-flash-high" },
					{ ...runtimeModel, id: "gemini-99.1-flash-high", retryResetTimezoneOffset: "-03:30" },
				],
			});
			expect(retryDelay(registry, "google-antigravity", "gemini-99.0-flash")).toBe(16 * 60 * 60 * 1000);
			registry.registerProvider("google-antigravity", { retryResetTimezoneOffset: "Z" });
			expect(retryDelay(registry, "google-antigravity", "gemini-99.0-flash")).toBe(24 * 60 * 60 * 1000);
			expect(retryDelay(registry, "google-antigravity", "gemini-99.1-flash")).toBe(27.5 * 60 * 60 * 1000);
		} finally {
			authStorage.close();
		}
	});

	test("alias-only timezone overrides respect direct overrides and stop applying after removal", async () => {
		using dir = TempDir.createSync("@retry-timezone-alias-overrides-");
		const file = path.join(dir.path(), "models.yml");
		const provider = {
			baseUrl,
			api: "openai-completions",
			auth: "none",
			models: [
				{ id: "gemini-99.0-flash-high" },
				{ id: "gemini-99.1-flash-high", retryResetTimezoneOffset: "-03:30" },
			],
		};
		await Bun.write(
			file,
			Bun.YAML.stringify({
				providers: {
					"google-antigravity": {
						...provider,
						modelOverrides: {
							"gemini-99.0-flash-high": { retryResetTimezoneOffset: "+08:00" },
							"gemini-99.1-flash-high": { retryResetTimezoneOffset: "Z" },
							"gemini-99.1-flash": { contextWindow: 64000 },
						},
					},
				},
			}),
		);
		const authStorage = await AuthStorage.create(":memory:");
		try {
			const registry = new ModelRegistry(authStorage, file);
			expect(retryDelay(registry, "google-antigravity", "gemini-99.0-flash")).toBe(16 * 60 * 60 * 1000);
			expect(retryDelay(registry, "google-antigravity", "gemini-99.1-flash")).toBe(27.5 * 60 * 60 * 1000);
			registry.getAll();
			await Bun.write(file, Bun.YAML.stringify({ providers: { "google-antigravity": provider } }));
			await registry.refresh("offline");
			expect(retryDelay(registry, "google-antigravity", "gemini-99.0-flash")).toBe(24 * 60 * 60 * 1000);
			expect(retryDelay(registry, "google-antigravity", "gemini-99.1-flash")).toBe(27.5 * 60 * 60 * 1000);
		} finally {
			authStorage.close();
		}
	});

	test("dynamic offsets survive same-id static definitions while explicit static offsets and current provider defaults retain precedence", async () => {
		using dir = TempDir.createSync("@retry-timezone-discovery-");
		const authStorage = await AuthStorage.create(":memory:");
		try {
			const registry = new ModelRegistry(authStorage, path.join(dir.path(), "models.yml"), {
				fetch: () => Promise.reject(new Error("network disabled in timezone discovery test")),
			});
			registry.registerProvider("proxy", {
				baseUrl,
				apiKey: "key",
				api: "openai-completions",
				retryResetTimezoneOffset: "+08:00",
				models: [
					runtimeModel,
					{ ...runtimeModel, id: "explicit" },
					{ ...runtimeModel, id: "static-zone", retryResetTimezoneOffset: "-04:00" },
				],
				fetchDynamicModels: async () => [
					runtimeModel,
					{ ...runtimeModel, id: "explicit", retryResetTimezoneOffset: "-03:30" },
					{ ...runtimeModel, id: "static-zone", retryResetTimezoneOffset: "+03:00" },
				],
			});
			await registry.refreshRuntimeProviders("online");
			expect(retryDelay(registry, "proxy", "route")).toBe(16 * 60 * 60 * 1000);
			expect(retryDelay(registry, "proxy", "explicit")).toBe(27.5 * 60 * 60 * 1000);
			expect(retryDelay(registry, "proxy", "static-zone")).toBe(28 * 60 * 60 * 1000);
			registry.registerProvider("proxy", { retryResetTimezoneOffset: "Z" });
			expect(retryDelay(registry, "proxy", "route")).toBe(24 * 60 * 60 * 1000);
			await registry.refreshRuntimeProviders("online");
			expect(retryDelay(registry, "proxy", "route")).toBe(24 * 60 * 60 * 1000);
			expect(retryDelay(registry, "proxy", "explicit")).toBe(27.5 * 60 * 60 * 1000);
			expect(retryDelay(registry, "proxy", "static-zone")).toBe(28 * 60 * 60 * 1000);
		} finally {
			authStorage.close();
		}
	});

	test.each(["provider", "modelOverrides"] as const)(
		"OAuth-synthesized models apply %s offsets without losing explicit offsets",
		async offsetSource => {
			using dir = TempDir.createSync("@retry-timezone-oauth-");
			const authStorage = await AuthStorage.create(":memory:");
			const sourceId = "test://retry-timezone-oauth";
			try {
				const file = path.join(dir.path(), "models.yml");
				if (offsetSource === "modelOverrides") {
					await Bun.write(
						file,
						Bun.YAML.stringify({
							providers: {
								"timezone-oauth": { modelOverrides: { synthesized: { retryResetTimezoneOffset: "+08:00" } } },
							},
						}),
					);
				}
				const credentials = { access: "access", refresh: "refresh", expires: Date.now() + 60_000 };
				await authStorage.credentials.set("timezone-oauth", { type: "oauth", ...credentials });
				const registry = new ModelRegistry(authStorage, file);
				registry.registerProvider(
					"timezone-oauth",
					{
						baseUrl,
						api: "openai-completions",
						retryResetTimezoneOffset: offsetSource === "provider" ? "+08:00" : undefined,
						models: [runtimeModel],
						oauth: {
							name: "Timezone OAuth",
							login: async () => credentials,
							getApiKey: value => value.access,
							modifyModels: models => [
								...models.filter(model => model.provider !== "timezone-oauth"),
								...[{ id: "synthesized" }, { id: "explicit", retryResetTimezoneOffset: "-03:30" }].map(
									override =>
										({
											...runtimeModel,
											...override,
											provider: "timezone-oauth",
											api: "openai-completions",
											baseUrl,
										}) as unknown as Model<Api>,
								),
							],
						},
					},
					sourceId,
				);
				expect(retryDelay(registry, "timezone-oauth", "synthesized")).toBe(16 * 60 * 60 * 1000);
				expect(retryDelay(registry, "timezone-oauth", "explicit")).toBe(27.5 * 60 * 60 * 1000);
				registry.registerProvider("timezone-oauth", { retryResetTimezoneOffset: "Z" });
				const inheritedDelay = (offsetSource === "provider" ? 24 : 16) * 60 * 60 * 1000;
				expect(retryDelay(registry, "timezone-oauth", "synthesized")).toBe(inheritedDelay);
				await registry.refresh("offline");
				expect(retryDelay(registry, "timezone-oauth", "synthesized")).toBe(inheritedDelay);
				expect(retryDelay(registry, "timezone-oauth", "explicit")).toBe(27.5 * 60 * 60 * 1000);
				if (offsetSource === "modelOverrides") {
					await Bun.write(file, Bun.YAML.stringify({ providers: {} }));
					await registry.refresh("offline");
					expect(retryDelay(registry, "timezone-oauth", "synthesized")).toBe(24 * 60 * 60 * 1000);
				}
			} finally {
				unregisterOAuthProviders(sourceId);
				authStorage.close();
			}
		},
	);
});

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

describe("ModelsConfigSchema Bedrock compat overrides", () => {
	test("rejects a non-boolean supportsThinkingBindingControls override instead of passing the typo through", () => {
		// A truthy string would keep the binding controls on for a gateway the user meant to opt out.
		const checked = ModelsConfigSchema({
			providers: {
				"amazon-bedrock": {
					models: [
						{
							id: "us.anthropic.claude-fable-5-1",
							api: "bedrock-converse-stream",
							compat: { supportsThinkingBindingControls: "false" },
						},
					],
				},
			},
		});
		if (!(checked instanceof OmpErrors)) throw new Error("expected the schema to reject a string value");
		expect(checked.map(error => `${error.path.join(".")}: ${error.problem}`)).toEqual([
			expect.stringMatching(
				/^providers\.amazon-bedrock\.models\.0\.compat\.supportsThinkingBindingControls: must be boolean/,
			),
		]);
	});
});

describe("ModelsConfigSchema tokenizer", () => {
	test("accepts the cl100k tokenizer and rejects an unknown one", () => {
		const config = (tokenizer: string) => ({
			providers: {
				p: {
					baseUrl,
					apiKey: "K",
					models: [{ id: "legacy-gpt-4", api: "openai-completions" as const, tokenizer }],
				},
			},
		});
		expect(ModelsConfigSchema(config("cl100k"))).not.toBeInstanceOf(OmpErrors);
		expect(getModelsConfigSchema()(config("cl100k"))).not.toBeInstanceOf(OmpErrors);
		expect(ModelsConfigSchema(config("cl200k"))).toBeInstanceOf(OmpErrors);
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

describe("models.yml input modality the catalog cannot express (#16342)", () => {
	function catalogInputModalities(): string[] {
		const declared = AXES["input-modalities"].values ?? [];
		return declared.filter((value): value is string => typeof value === "string");
	}

	/** A models.yml with one provider whose models declare the given `input` lists. */
	function writeModelsFile(models: readonly { id: string; input: string }[]): string {
		const dir = TempDir.createSync("@models-config-input-");
		const file = path.join(dir.path(), "models.yml");
		fs.writeFileSync(file, modelsYaml(models));
		return file;
	}

	function modelsYaml(models: readonly { id: string; input: string }[]): string {
		return [
			"providers:",
			"  openrouter:",
			"    baseUrl: https://api.example.invalid/v1",
			"    apiKey: sk-test",
			"    api: openai-completions",
			"    models:",
			...models.flatMap(model => [`      - id: "${model.id}"`, `        input: [${model.input}]`]),
			"",
		].join("\n");
	}

	test("an unsupported input modality is dropped and the file still loads", () => {
		// A models.yml naming a modality the catalog does not know must not take
		// the whole config down: the file loads with the modality dropped, and
		// the warning names that modality plus the catalog's own vocabulary.
		const file = writeModelsFile([{ id: "some/video-capable-model", input: "text, image, video" }]);
		const config = ModelsConfigFile.relocate(file);
		const result = config.tryLoad();
		expect(result.status).toBe("ok");
		if (result.status !== "ok") throw new Error("expected the file to load");
		expect(result.value?.providers?.openrouter?.models?.[0]?.input).toEqual(catalogInputModalities());
		const [warning] = result.warnings;
		expect(warning).toContain('provider "openrouter"');
		expect(warning).toContain('model "some/video-capable-model"');
		expect(warning).toContain('modality "video"');
		for (const modality of catalogInputModalities()) {
			expect(warning).toContain(modality);
		}
	});

	test("a later read of the same load still carries the dropped modality", () => {
		// The default models.yml handle is one ConfigFile for the process, and
		// tryLoad returns its cached result. Findings live on that result, so a
		// second registry reports the same modality warning.
		const file = writeModelsFile([{ id: "some/video-capable-model", input: "text, image, video" }]);
		const config = ModelsConfigFile.relocate(file);
		const first = config.tryLoad();
		const second = config.tryLoad();
		expect(second).toBe(first);
		if (first.status !== "ok" || second.status !== "ok") throw new Error("expected the file to load");
		expect(first.warnings.some(warning => warning.includes('modality "video"'))).toBe(true);
		expect(second.warnings).toEqual(first.warnings);
	});

	test("a failed load does not keep the dropped-modality warning", () => {
		// `input: [video, 7]` reports `video` and then fails the schema. The
		// next successful load of the same file must not repeat that warning.
		const file = writeModelsFile([{ id: "m", input: "video, 7" }]);
		const config = ModelsConfigFile.relocate(file);
		const failed = config.tryLoad();
		expect(failed.status).toBe("error");
		expect("warnings" in failed).toBe(false);
		fs.writeFileSync(file, modelsYaml([{ id: "m", input: "text" }]));
		config.invalidate();
		const result = config.tryLoad();
		expect(result.status).toBe("ok");
		if (result.status !== "ok") throw new Error("expected the file to load");
		expect(result.value?.providers?.openrouter?.models?.[0]?.input).toEqual(["text"]);
		expect(result.warnings).toEqual([]);
	});

	test("a model whose only modality is unsupported keeps the catalog default", () => {
		// Dropping every modality must not leave the model with an empty input
		// list: the key goes away so the catalog's own default applies.
		const file = writeModelsFile([{ id: "only-video", input: "video" }]);
		const config = ModelsConfigFile.relocate(file);
		const result = config.tryLoad();
		expect(result.status).toBe("ok");
		expect(result.value?.providers?.openrouter?.models?.[0]?.input).toBeUndefined();
	});

	test("a malformed input entry stays a schema error", () => {
		// Only an unknown modality is forgiven; a list the schema cannot read at
		// all is still a configuration mistake worth reporting.
		const file = writeModelsFile([{ id: "bad-entry", input: "text, 7" }]);
		const result = ModelsConfigFile.relocate(file).tryLoad();
		expect(result.status).toBe("error");
		if (result.status !== "error") throw new Error("expected the file to fail validation");
		expect(result.error.message).toContain("7");
	});

	test("the registry loads the model and reports the dropped modality once", async () => {
		const file = writeModelsFile([{ id: "some/video-capable-model", input: "text, image, video" }]);
		const authStorage = await AuthStorage.create(":memory:");
		try {
			const registry = new ModelRegistry(authStorage, file);
			// `omp models refresh` force-reparses before draining. The warning
			// from the constructor load must not be joined by a second copy.
			await registry.refresh("offline", { refreshCommandCredentials: true });
			expect(registry.getError()).toBeUndefined();
			const model = registry.getAll().find(entry => entry.id === "some/video-capable-model");
			const input: readonly string[] = model?.input ?? [];
			expect(input).toEqual(catalogInputModalities());
			const warnings = registry.drainConfigWarnings().filter(warning => warning.includes('modality "video"'));
			expect(warnings).toHaveLength(1);
			expect(warnings[0]).toContain('model "some/video-capable-model"');
		} finally {
			authStorage.close();
		}
	});
});
