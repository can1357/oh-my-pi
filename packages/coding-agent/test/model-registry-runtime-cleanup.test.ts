import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import { type AssistantMessageEventStream, clearCustomApis, getCustomApi } from "@oh-my-pi/pi-ai";
import { getOAuthProvider } from "@oh-my-pi/pi-ai/oauth";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { writeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import { resolveModelCacheProviderId, resolveOllamaModelCacheProviderId } from "@oh-my-pi/pi-catalog/provider-models";
import { ModelRegistry, type ProviderConfigInput } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { TempDir } from "@oh-my-pi/pi-utils";

describe("ModelRegistry runtime source cleanup", () => {
	let authStorage: AuthStorage;

	const sourceId = "ext://runtime-cleanup";
	const baseModel: NonNullable<ProviderConfigInput["models"]>[number] = {
		id: "runtime-model",
		name: "Runtime Model",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 8192,
	};

	const streamSimple: NonNullable<ProviderConfigInput["streamSimple"]> = () =>
		({}) as unknown as AssistantMessageEventStream;

	beforeEach(async () => {
		authStorage = await AuthStorage.create(":memory:");
	});

	afterEach(() => {
		clearCustomApis();
		authStorage.close();
	});

	test("clearSourceRegistrations removes runtime overlays and fallback auth for that source", () => {
		const registry = new ModelRegistry(authStorage, undefined, { ignoreLocalModelConfig: true });
		const config: ProviderConfigInput = {
			baseUrl: "https://runtime.example.com/v1",
			apiKey: "RUNTIME_KEY",
			api: "custom-runtime-cleanup-api",
			streamSimple,
			models: [baseModel],
		};

		registry.registerProvider("runtime-provider", config, sourceId);

		expect(registry.find("runtime-provider", "runtime-model")).toBeDefined();
		expect(registry.authStorage.hasAuth("runtime-provider")).toBe(true);
		expect(getCustomApi("custom-runtime-cleanup-api")).toBeDefined();

		registry.clearSourceRegistrations(sourceId);

		expect(registry.find("runtime-provider", "runtime-model")).toBeUndefined();
		expect(registry.authStorage.hasAuth("runtime-provider")).toBe(false);
		expect(getCustomApi("custom-runtime-cleanup-api")).toBeUndefined();
	});

	test("extension rebinding preserves unrelated credential-scoped cached models", async () => {
		using tempDir = TempDir.createSync("@omp-model-registry-rebind-");
		const provider = "opencode-go";
		const apiKey = "opencode-go-test-key";
		const cachedModel = buildModel({
			id: "cached-credential-model",
			name: "Cached Credential Model",
			api: "openai-responses",
			provider,
			baseUrl: "https://opencode.ai/zen/go/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128_000,
			maxTokens: 16_384,
		});
		authStorage.setRuntimeApiKey(provider, apiKey);
		writeModelCache(
			resolveModelCacheProviderId(provider, { apiKey }),
			Date.now(),
			[cachedModel],
			true,
			"",
			tempDir.join("models.db"),
		);
		const registry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
		await registry.hydrateCredentialScopedModelCaches();
		expect(registry.getAvailable().some(model => model.provider === provider && model.id === cachedModel.id)).toBe(
			true,
		);

		for (let cycle = 0; cycle < 2; cycle += 1) {
			registry.registerProvider(
				"runtime-provider",
				{
					baseUrl: "https://runtime.example.com/v1",
					apiKey: "RUNTIME_KEY",
					api: "openai-completions",
					models: [baseModel],
				},
				sourceId,
			);
			registry.clearSourceRegistrations(sourceId);

			expect(registry.getAvailable().some(model => model.provider === provider && model.id === cachedModel.id)).toBe(
				true,
			);
		}
	});

	test("extension rebinding discards discoveries removed from the model config", async () => {
		using tempDir = TempDir.createSync("@omp-model-registry-config-rebind-");
		const modelsPath = tempDir.join("models.json");
		const cacheDbPath = tempDir.join("models.db");
		const provider = "configured-ollama";
		const baseUrl = "http://127.0.0.1:11435";
		const discoveredModel = buildModel({
			id: "removed-config-model",
			name: "Removed Config Model",
			api: "openai-completions",
			provider,
			baseUrl,
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128_000,
			maxTokens: 16_384,
		});
		await Bun.write(
			modelsPath,
			JSON.stringify({
				providers: {
					[provider]: {
						baseUrl,
						api: "openai-completions",
						auth: "none",
						discovery: { type: "ollama" },
					},
				},
			}),
		);
		const oldMtime = new Date("2020-01-01T00:00:00Z");
		await fs.utimes(modelsPath, oldMtime, oldMtime);
		writeModelCache(
			resolveOllamaModelCacheProviderId(provider, baseUrl),
			Date.now(),
			[discoveredModel],
			true,
			"",
			cacheDbPath,
		);
		const registry = new ModelRegistry(authStorage, modelsPath);
		await registry.refresh("offline");
		expect(registry.find(provider, discoveredModel.id)).toBeDefined();
		registry.registerProvider(
			"runtime-provider",
			{
				baseUrl: "https://runtime.example.com/v1",
				apiKey: "RUNTIME_KEY",
				api: "openai-completions",
				models: [baseModel],
			},
			sourceId,
		);

		await Bun.write(modelsPath, JSON.stringify({ providers: {} }));
		registry.clearSourceRegistrations(sourceId);

		expect(registry.find(provider, discoveredModel.id)).toBeUndefined();
	});

	test("extension rebinding discards discoveries whose model overrides changed", async () => {
		using tempDir = TempDir.createSync("@omp-model-registry-override-rebind-");
		const modelsPath = tempDir.join("models.json");
		const cacheDbPath = tempDir.join("models.db");
		const provider = "configured-ollama";
		const baseUrl = "http://127.0.0.1:11436";
		const modelId = "override-config-model";
		const discoveredModel = buildModel({
			id: modelId,
			name: "Override Config Model",
			api: "openai-completions",
			provider,
			baseUrl,
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128_000,
			maxTokens: 16_384,
		});
		const writeConfig = (modelOverrides: Record<string, unknown> | undefined) =>
			Bun.write(
				modelsPath,
				JSON.stringify({
					providers: {
						[provider]: {
							baseUrl,
							api: "openai-completions",
							auth: "none",
							discovery: { type: "ollama" },
							...(modelOverrides ? { modelOverrides } : {}),
						},
					},
				}),
			);
		await writeConfig({ [modelId]: { headers: { "X-Override": "stale" } } });
		const oldMtime = new Date("2020-01-01T00:00:00Z");
		await fs.utimes(modelsPath, oldMtime, oldMtime);
		writeModelCache(
			resolveOllamaModelCacheProviderId(provider, baseUrl),
			Date.now(),
			[discoveredModel],
			true,
			"",
			cacheDbPath,
		);
		const registry = new ModelRegistry(authStorage, modelsPath);
		await registry.refresh("offline");
		expect(registry.find(provider, modelId)?.headers?.["X-Override"]).toBe("stale");
		registry.registerProvider(
			"runtime-provider",
			{
				baseUrl: "https://runtime.example.com/v1",
				apiKey: "RUNTIME_KEY",
				api: "openai-completions",
				models: [baseModel],
			},
			sourceId,
		);

		// Remove the per-model override, keeping the discovery config identical.
		await writeConfig(undefined);
		registry.clearSourceRegistrations(sourceId);

		expect(registry.find(provider, modelId)?.headers?.["X-Override"]).toBeUndefined();
	});

	test("unregisterProvider removes only the named provider and its login entry", () => {
		const registry = new ModelRegistry(authStorage, undefined, { ignoreLocalModelConfig: true });
		registry.registerProvider(
			"runtime-provider",
			{
				baseUrl: "https://runtime.example.com/v1",
				apiKey: "RUNTIME_KEY",
				api: "custom-runtime-cleanup-api",
				streamSimple,
				models: [baseModel],
				oauth: {
					name: "Runtime Provider",
					login: async () => "runtime-token",
				},
			},
			sourceId,
		);
		registry.registerProvider(
			"peer-provider",
			{
				baseUrl: "https://peer.example.com/v1",
				apiKey: "PEER_KEY",
				api: "openai-completions",
				models: [{ ...baseModel, id: "peer-model" }],
			},
			sourceId,
		);

		expect(getOAuthProvider("runtime-provider")).toBeDefined();
		registry.unregisterProvider("runtime-provider");

		expect(registry.find("runtime-provider", "runtime-model")).toBeUndefined();
		expect(registry.authStorage.hasAuth("runtime-provider")).toBe(false);
		expect(getOAuthProvider("runtime-provider")).toBeUndefined();
		expect(registry.find("peer-provider", "peer-model")).toBeDefined();
	});
});
