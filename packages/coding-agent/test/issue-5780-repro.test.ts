import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { clearCustomApis, type FetchImpl } from "@oh-my-pi/pi-ai";
import { unregisterOAuthProviders } from "@oh-my-pi/pi-ai/oauth";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { readModelCache, writeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import { ModelRegistry, type ProviderConfigInput } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { Snowflake } from "@oh-my-pi/pi-utils";

describe("issue #5780 post-auth runtime provider refresh", () => {
	let tempDir: string;
	let modelsJsonPath: string;
	let dbPath: string;
	let authStorage: AuthStorage;
	let registry: ModelRegistry;

	const sourceId = "ext://issue-5780";
	const providerName = "issue-5780-provider";
	const FAKE_HEADER = "issue-5780-fake-header-secret";
	const FAKE_KEY = "issue-5780-fake-credential-abc123";
	type RuntimeModelDefinition = NonNullable<ProviderConfigInput["models"]>[number];
	const offlineFetch: FetchImpl = () => Promise.reject(new Error("network disabled"));

	beforeEach(async () => {
		tempDir = path.join(os.tmpdir(), `pi-test-issue-5780-${Snowflake.next()}`);
		await fs.mkdir(tempDir, { recursive: true });
		modelsJsonPath = path.join(tempDir, "models.json");
		dbPath = path.join(tempDir, "models.db");
		authStorage = await AuthStorage.create(":memory:");
		registry = new ModelRegistry(authStorage, modelsJsonPath, { fetch: offlineFetch });
	});

	afterEach(async () => {
		vi.useRealTimers();
		clearCustomApis();
		unregisterOAuthProviders(sourceId);
		authStorage.close();
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	function registerAuthGatedProvider(): void {
		const config: ProviderConfigInput = {
			baseUrl: "https://issue-5780.example.com/v1",
			api: "openai-completions",
			authHeader: true,
			// Model appears only once the credential exists.
			fetchDynamicModels: async (apiKey?: string) => {
				if (!apiKey) return [];
				return [
					{
						id: "gated-model",
						name: "Gated Model",
						reasoning: false,
						input: ["text"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 128_000,
						maxTokens: 8_192,
					},
				];
			},
		};
		registry.registerProvider(providerName, config, sourceId);
	}

	function runtimeModel(id: string): RuntimeModelDefinition {
		return {
			id,
			name: id,
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128_000,
			maxTokens: 8_192,
		};
	}

	test("default post-login refresh re-runs dynamic discovery", async () => {
		registerAuthGatedProvider();

		// Refresh before login: dynamic discovery is empty without a credential.
		await registry.refreshRuntimeProviders();
		expect(registry.find(providerName, "gated-model")).toBeUndefined();

		// Login persists a credential.
		await authStorage.set(providerName, { type: "api_key", key: FAKE_KEY });

		// The default runtime refresh used after login must re-invoke discovery with
		// the newly persisted credential so the model becomes available in-session.
		await registry.refreshRuntimeProviders();
		expect(registry.find(providerName, "gated-model")).toBeDefined();
	});
	test("every live runtime discovery refreshes expired OAuth credentials", async () => {
		authStorage.close();
		const refreshCalls: string[] = [];
		authStorage = await AuthStorage.create(":memory:", {
			refreshOAuthCredential: async (provider, _credentialId, credential) => {
				refreshCalls.push(provider);
				return { ...credential, access: `fresh-${provider}`, expires: Date.now() + 3_600_000 };
			},
		});
		registry = new ModelRegistry(authStorage, modelsJsonPath, { fetch: offlineFetch });
		const expiredOAuth = {
			type: "oauth" as const,
			access: "expired-runtime-token",
			refresh: "runtime-refresh-token",
			expires: Date.now() - 60_000,
		};
		await authStorage.set(providerName, expiredOAuth);
		const receivedKeys: Array<string | undefined> = [];
		registry.registerProvider(
			providerName,
			{
				baseUrl: "https://issue-5780.example.com/v1",
				api: "openai-completions",
				fetchDynamicModels: async apiKey => {
					receivedKeys.push(apiKey);
					return [];
				},
			},
			sourceId,
		);

		await registry.refreshRuntimeProviders("online-if-uncached", [providerName]);
		expect(refreshCalls).toEqual([providerName]);
		expect(receivedKeys).toEqual([`fresh-${providerName}`]);

		await authStorage.set(providerName, [
			expiredOAuth,
			{ type: "api_key", key: "fallback-runtime-key", source: "login" },
		]);
		await registry.refreshRuntimeProviders("online-if-uncached", [providerName]);
		expect(refreshCalls).toEqual([providerName, providerName]);
		expect(receivedKeys).toEqual([`fresh-${providerName}`, `fresh-${providerName}`]);

		await registry.refreshRuntimeProviders("online", [providerName]);
		expect(refreshCalls).toEqual([providerName, providerName]);
		expect(receivedKeys).toEqual([`fresh-${providerName}`, `fresh-${providerName}`, `fresh-${providerName}`]);
	});
	test("replacement without discovery removes the prior runtime manager", async () => {
		registerAuthGatedProvider();
		await authStorage.set(providerName, { type: "api_key", key: FAKE_KEY });
		await registry.refreshRuntimeProviders("online");
		expect(registry.find(providerName, "gated-model")).toBeDefined();

		registry.registerProvider(
			providerName,
			{ baseUrl: "https://issue-5780.example.com/v1", api: "openai-completions" },
			sourceId,
		);
		await registry.refreshRuntimeProviders("online");
		expect(registry.find(providerName, "gated-model")).toBeUndefined();
	});

	test("same-source dynamic re-registration reruns direct provider refreshes", async () => {
		let generation = 0;
		let fetches = 0;
		const replacementFetchStarted = Promise.withResolvers<void>();
		const replacementModels = Promise.withResolvers<RuntimeModelDefinition[]>();
		const registerDynamicProvider = (): void => {
			registry.registerProvider(
				providerName,
				{
					baseUrl: "https://issue-5780.example.com/v1",
					api: "openai-completions",
					fetchDynamicModels: async () => {
						fetches += 1;
						if (generation > 0) {
							replacementFetchStarted.resolve();
							return replacementModels.promise;
						}
						return [runtimeModel("first-generation")];
					},
				},
				sourceId,
			);
		};

		registerDynamicProvider();
		await registry.refreshRuntimeProviders("online");
		expect(registry.find(providerName, "first-generation")).toBeDefined();

		generation += 1;
		registerDynamicProvider();
		expect(registry.find(providerName, "first-generation")).toBeDefined();
		await replacementFetchStarted.promise;
		replacementModels.resolve([runtimeModel("second-generation")]);
		const unscopedRefresh = registry.refresh("online-if-uncached");
		const providerRefresh = registry.refreshProvider(providerName, "online");
		await Promise.all([unscopedRefresh, providerRefresh]);
		expect(registry.find(providerName, "first-generation")).toBeUndefined();
		expect(registry.find(providerName, "second-generation")).toBeDefined();
		expect(fetches).toBe(3);
	});
	test("replacing mixed provider static models preserves its dynamic slice until refresh", async () => {
		let generation = 0;
		const replacementFetchStarted = Promise.withResolvers<void>();
		const replacementModels = Promise.withResolvers<RuntimeModelDefinition[]>();
		const registerMixedProvider = (staticModelId: string): void => {
			registry.registerProvider(
				providerName,
				{
					baseUrl: "https://issue-5780.example.com/v1",
					api: "openai-completions",
					apiKey: FAKE_KEY,
					models: [runtimeModel(staticModelId)],
					fetchDynamicModels: async () => {
						if (generation === 0) return [runtimeModel("first-dynamic")];
						replacementFetchStarted.resolve();
						return replacementModels.promise;
					},
				},
				sourceId,
			);
		};

		registerMixedProvider("first-static");
		await registry.refreshRuntimeProviders("online", [providerName]);
		expect(registry.find(providerName, "first-static")).toBeDefined();
		expect(registry.find(providerName, "first-dynamic")).toBeDefined();
		expect(registry.getAll().some(model => model.provider === providerName && model.id === "first-dynamic")).toBe(
			true,
		);

		generation += 1;
		registerMixedProvider("second-static");
		expect(registry.find(providerName, "first-static")).toBeUndefined();
		expect(registry.find(providerName, "second-static")).toBeDefined();
		expect(registry.find(providerName, "first-dynamic")).toBeDefined();

		await replacementFetchStarted.promise;
		replacementModels.resolve([runtimeModel("second-dynamic")]);
		await registry.refreshRuntimeProviders("online", [providerName]);
		expect(registry.find(providerName, "first-dynamic")).toBeUndefined();
		expect(registry.find(providerName, "second-dynamic")).toBeDefined();
	});

	test("late extension discovery registration preserves configured discovery ownership", async () => {
		let configuredFetches = 0;
		let extensionFetches = 0;
		await Bun.write(
			modelsJsonPath,
			JSON.stringify({
				providers: {
					[providerName]: {
						baseUrl: "https://issue-5780.example.com/v1",
						api: "openai-completions",
						auth: "none",
						discovery: { type: "openai-models-list" },
					},
				},
			}),
		);
		registry = new ModelRegistry(authStorage, modelsJsonPath, {
			fetch: async input => {
				const url = input instanceof Request ? input.url : String(input);
				if (url !== "https://issue-5780.example.com/v1/models") {
					throw new Error(`Unexpected fetch: ${url}`);
				}
				configuredFetches += 1;
				return new Response(JSON.stringify({ data: [{ id: "configured-model" }] }));
			},
		});
		await registry.refresh("online");
		expect(registry.find(providerName, "configured-model")).toBeDefined();

		registry.registerProvider(
			providerName,
			{
				baseUrl: "https://issue-5780.example.com/v1",
				api: "openai-completions",
				fetchDynamicModels: async () => {
					extensionFetches += 1;
					return [runtimeModel("extension-model")];
				},
			},
			sourceId,
		);

		expect(registry.find(providerName, "configured-model")).toBeDefined();
		await registry.refreshRuntimeProviders("online", [providerName]);
		expect(registry.find(providerName, "configured-model")).toBeDefined();
		expect(configuredFetches).toBe(2);
		expect(extensionFetches).toBe(0);
	});

	test("config discovery replaces an extension-owned runtime catalog on static reload", async () => {
		registry.registerProvider(
			providerName,
			{
				baseUrl: "https://issue-5780.example.com/v1",
				api: "openai-completions",
				fetchDynamicModels: async () => [runtimeModel("extension-model")],
			},
			sourceId,
		);
		await registry.refreshRuntimeProviders("online");
		expect(registry.find(providerName, "extension-model")).toBeDefined();

		await Bun.write(
			modelsJsonPath,
			JSON.stringify({
				providers: {
					[providerName]: {
						baseUrl: "https://issue-5780.example.com/v1",
						api: "openai-completions",
						auth: "none",
						discovery: { type: "openai-models-list" },
					},
				},
			}),
		);
		await registry.refresh("offline");

		expect(registry.find(providerName, "extension-model")).toBeUndefined();
	});

	test("config discovery discards an in-flight extension catalog on static reload", async () => {
		const fetchStarted = Promise.withResolvers<void>();
		const pendingModels = Promise.withResolvers<readonly RuntimeModelDefinition[]>();
		registry.registerProvider(
			providerName,
			{
				baseUrl: "https://issue-5780.example.com/v1",
				api: "openai-completions",
				fetchDynamicModels: () => {
					fetchStarted.resolve();
					return pendingModels.promise;
				},
			},
			sourceId,
		);
		const extensionRefresh = registry.refreshRuntimeProviders("online");
		await fetchStarted.promise;
		await Bun.write(
			modelsJsonPath,
			JSON.stringify({
				providers: {
					[providerName]: {
						baseUrl: "https://issue-5780.example.com/v1",
						api: "openai-completions",
						auth: "none",
						discovery: { type: "openai-models-list" },
					},
				},
			}),
		);
		await registry.refresh("offline");
		pendingModels.resolve([runtimeModel("stale-extension-model")]);
		await extensionRefresh;

		expect(registry.find(providerName, "stale-extension-model")).toBeUndefined();
	});

	test("static reload recomposes raw extension discovery against current overrides", async () => {
		await Bun.write(
			modelsJsonPath,
			JSON.stringify({
				providers: {
					[providerName]: {
						headers: { "X-Discovery-Override": "old" },
					},
				},
			}),
		);
		await registry.refresh("offline");
		registry.registerProvider(
			providerName,
			{
				baseUrl: "https://issue-5780.example.com/v1",
				api: "openai-completions",
				fetchDynamicModels: async () => [runtimeModel("extension-model")],
			},
			sourceId,
		);
		await registry.refreshRuntimeProviders("online");
		expect(registry.find(providerName, "extension-model")?.headers?.["X-Discovery-Override"]).toBe("old");

		await Bun.write(modelsJsonPath, JSON.stringify({ providers: { [providerName]: {} } }));
		await fs.utimes(modelsJsonPath, new Date("2100-01-01T00:00:00.000Z"), new Date("2100-01-01T00:00:00.000Z"));
		await registry.refresh("offline");

		expect(registry.find(providerName, "extension-model")?.headers?.["X-Discovery-Override"]).toBeUndefined();
	});

	test("offline runtime refresh does not supersede a pending online discovery", async () => {
		const fetchStarted = Promise.withResolvers<void>();
		const pendingModels = Promise.withResolvers<readonly RuntimeModelDefinition[]>();
		registry.registerProvider(
			providerName,
			{
				baseUrl: "https://issue-5780.example.com/v1",
				api: "openai-completions",
				fetchDynamicModels: () => {
					fetchStarted.resolve();
					return pendingModels.promise;
				},
			},
			sourceId,
		);

		const onlineRefresh = registry.refreshRuntimeProviders("online");
		await fetchStarted.promise;
		await registry.refreshRuntimeProviders("offline");
		pendingModels.resolve([runtimeModel("online-model")]);
		await onlineRefresh;

		expect(registry.find(providerName, "online-model")).toBeDefined();
	});

	test("failed online extension discovery clears the prior account catalog", async () => {
		let shouldFail = false;
		registry.registerProvider(
			providerName,
			{
				baseUrl: "https://issue-5780.example.com/v1",
				api: "openai-completions",
				fetchDynamicModels: async () => {
					if (shouldFail) throw new Error("current account discovery failed");
					return [runtimeModel("prior-account-model")];
				},
			},
			sourceId,
		);
		await registry.refreshProvider(providerName, "online");
		expect(
			registry.getAll().find(model => model.provider === providerName && model.id === "prior-account-model"),
		).toBeDefined();

		shouldFail = true;
		await registry.refreshProvider(providerName, "online");

		expect(registry.find(providerName, "prior-account-model")).toBeUndefined();
	});
	test("a newer runtime refresh supersedes an older result", async () => {
		const initialFetchStarted = Promise.withResolvers<void>();
		const initialModels = Promise.withResolvers<readonly RuntimeModelDefinition[]>();
		let fetches = 0;
		registry.registerProvider(
			providerName,
			{
				baseUrl: "https://issue-5780.example.com/v1",
				api: "openai-completions",
				fetchDynamicModels: async () => {
					if (fetches++ === 0) {
						initialFetchStarted.resolve();
						return initialModels.promise;
					}
					return [
						{
							id: "current-model",
							name: "Current Model",
							reasoning: false,
							input: ["text"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 128_000,
							maxTokens: 8_192,
						},
					];
				},
			},
			sourceId,
		);

		const olderRefresh = registry.refreshRuntimeProviders("online");
		await initialFetchStarted.promise;
		await registry.refreshProvider(providerName, "online");
		expect(registry.find(providerName, "current-model")).toBeDefined();
		initialModels.resolve([]);
		await olderRefresh;
		expect(registry.find(providerName, "current-model")).toBeDefined();
	});
	test("a delayed configured discovery cannot apply a superseded runtime result", async () => {
		const configuredFetchStarted = Promise.withResolvers<void>();
		const configuredResponse = Promise.withResolvers<Response>();
		const firstRuntimeFetchFinished = Promise.withResolvers<void>();
		let runtimeFetches = 0;
		await Bun.write(
			modelsJsonPath,
			JSON.stringify({
				providers: {
					"slow-configured": {
						baseUrl: "https://slow-configured.example.com/v1",
						api: "openai-completions",
						auth: "none",
						discovery: { type: "openai-models-list" },
					},
				},
			}),
		);
		const slowRegistry = new ModelRegistry(authStorage, modelsJsonPath, {
			fetch: async input => {
				const url = input instanceof Request ? input.url : String(input);
				if (url.startsWith("https://slow-configured.example.com/")) {
					configuredFetchStarted.resolve();
					return configuredResponse.promise;
				}
				throw new Error(`Unexpected fetch: ${url}`);
			},
		});
		slowRegistry.registerProvider(
			providerName,
			{
				baseUrl: "https://issue-5780.example.com/v1",
				api: "openai-completions",
				fetchDynamicModels: async () => {
					if (runtimeFetches++ === 0) {
						firstRuntimeFetchFinished.resolve();
						return [];
					}
					return [
						{
							id: "current-model",
							name: "Current Model",
							reasoning: false,
							input: ["text"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 128_000,
							maxTokens: 8_192,
						},
					];
				},
			},
			sourceId,
		);

		const olderRefresh = slowRegistry.refresh("online");
		await Promise.all([configuredFetchStarted.promise, firstRuntimeFetchFinished.promise]);
		await slowRegistry.refreshProvider(providerName, "online");
		expect(slowRegistry.find(providerName, "current-model")).toBeDefined();
		configuredResponse.resolve(new Response(JSON.stringify({ data: [] })));
		await olderRefresh;
		expect(slowRegistry.find(providerName, "current-model")).toBeDefined();
	});
	test("runtime registration survives inaccessible cache storage", async () => {
		const cacheParent = path.join(tempDir, "cache-parent");
		await Bun.write(cacheParent, "not a directory");
		const cacheDisabledRegistry = new ModelRegistry(authStorage, modelsJsonPath, {
			cacheDbPath: path.join(cacheParent, "models.db"),
			fetch: offlineFetch,
		});
		cacheDisabledRegistry.registerProvider(
			providerName,
			{
				baseUrl: "https://issue-5780.example.com/v1",
				api: "openai-completions",
				fetchDynamicModels: async () => [
					{
						id: "uncached-model",
						name: "Uncached Model",
						reasoning: false,
						input: ["text"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 128_000,
						maxTokens: 8_192,
					},
				],
			},
			sourceId,
		);
		await cacheDisabledRegistry.refreshRuntimeProviders("online");
		expect(cacheDisabledRegistry.find(providerName, "uncached-model")).toBeDefined();
	});

	test("provider-scoped refresh preserves unrelated runtime catalogs", async () => {
		const unrelatedProvider = "issue-5780-unrelated-provider";
		let unrelatedFetches = 0;
		registry.registerProvider(
			providerName,
			{
				baseUrl: "https://issue-5780.example.com/v1",
				api: "openai-completions",
				fetchDynamicModels: async () => [
					{
						id: "refreshed-model",
						name: "Refreshed Model",
						reasoning: false,
						input: ["text"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 128_000,
						maxTokens: 8_192,
					},
				],
			},
			sourceId,
		);
		registry.registerProvider(
			unrelatedProvider,
			{
				baseUrl: "https://issue-5780-unrelated.example.com/v1",
				api: "openai-completions",
				fetchDynamicModels: async () => {
					unrelatedFetches++;
					return [
						{
							id: "unrelated-model",
							name: "Unrelated Model",
							reasoning: false,
							input: ["text"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 128_000,
							maxTokens: 8_192,
						},
					];
				},
			},
			sourceId,
		);

		await registry.refreshRuntimeProviders("online");
		expect(registry.find(unrelatedProvider, "unrelated-model")).toBeDefined();
		await registry.refreshRuntimeProviders("online", [providerName]);
		expect(unrelatedFetches).toBe(1);
		expect(registry.find(unrelatedProvider, "unrelated-model")).toBeDefined();
		registry.unregisterProvider(unrelatedProvider);
		expect(registry.find(unrelatedProvider, "unrelated-model")).toBeUndefined();
	});

	test("discards a runtime discovery result after its provider is unregistered", async () => {
		const pendingModels = Promise.withResolvers<readonly RuntimeModelDefinition[]>();
		const fetchStarted = Promise.withResolvers<void>();
		registry.registerProvider(
			providerName,
			{
				baseUrl: "https://issue-5780.example.com/v1",
				api: "openai-completions",
				fetchDynamicModels: (_apiKey: string | undefined) => {
					fetchStarted.resolve();
					return pendingModels.promise;
				},
			},
			sourceId,
		);

		const refresh = registry.refreshRuntimeProviders("online");
		await fetchStarted.promise;
		registry.unregisterProvider(providerName);
		pendingModels.resolve([
			{
				id: "removed-model",
				name: "Removed Model",
				api: "openai-completions",
				baseUrl: "https://issue-5780.example.com/v1",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128_000,
				maxTokens: 8_192,
			},
		]);
		await refresh;
		expect(registry.find(providerName, "removed-model")).toBeUndefined();
	});
	test("runtime dynamic catalogs are unavailable offline and never persist", async () => {
		let fetches = 0;
		registry.registerProvider(
			providerName,
			{
				baseUrl: "https://issue-5780.example.com/v1",
				api: "openai-completions",
				fetchDynamicModels: async () => {
					fetches++;
					return [
						{
							id: "runtime-model",
							name: "Runtime Model",
							reasoning: false,
							input: ["text"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 128_000,
							maxTokens: 8_192,
						},
					];
				},
			},
			sourceId,
		);

		await registry.refreshRuntimeProviders("online");
		expect(registry.find(providerName, "runtime-model")).toBeDefined();
		expect(fetches).toBe(1);
		expect(readModelCache(providerName, Infinity, Date.now, dbPath)).toBeNull();

		// An in-process offline picker refresh retains the current live catalog;
		// the catalog is never read from disk after an application restart.
		await registry.refresh("offline");
		expect(registry.find(providerName, "runtime-model")).toBeDefined();
		expect(fetches).toBe(1);

		const replacementFetchStarted = Promise.withResolvers<void>();
		registry.registerProvider(
			providerName,
			{
				baseUrl: "https://issue-5780.example.com/v1",
				api: "openai-completions",
				fetchDynamicModels: async () => {
					replacementFetchStarted.resolve();
					return [];
				},
			},
			sourceId,
		);

		// Re-registration preserves the old catalog until its scheduled online
		// replacement completes, then removes it when the replacement is empty.
		expect(registry.find(providerName, "runtime-model")).toBeDefined();
		await replacementFetchStarted.promise;
		await registry.refreshRuntimeProviders("online", [providerName]);
		expect(registry.find(providerName, "runtime-model")).toBeUndefined();

		const restarted = new ModelRegistry(authStorage, modelsJsonPath, { fetch: offlineFetch });
		restarted.registerProvider(
			providerName,
			{
				baseUrl: "https://issue-5780.example.com/v1",
				api: "openai-completions",
				fetchDynamicModels: async () => {
					fetches++;
					return [];
				},
			},
			sourceId,
		);
		await restarted.refreshRuntimeProviders("offline");
		expect(restarted.find(providerName, "runtime-model")).toBeUndefined();
		expect(fetches).toBe(1);

		await restarted.refreshRuntimeProviders("online-if-uncached");
		expect(fetches).toBe(2);
	});
	test("runtime registration preserves an indistinguishable provider cache row", async () => {
		const cachedModel = registry.getAll().find(model => model.provider === "anthropic");
		if (!cachedModel) throw new Error("Expected an Anthropic built-in model");
		writeModelCache("anthropic", Date.now(), [cachedModel], true, "", dbPath);
		expect(readModelCache("anthropic", Infinity, Date.now, dbPath)).not.toBeNull();

		registry.registerProvider(
			"anthropic",
			{
				baseUrl: "https://issue-5780.example.com/v1",
				api: "openai-completions",
				fetchDynamicModels: async () => [],
			},
			sourceId,
		);

		expect(registry.find("anthropic", cachedModel.id)).toBeUndefined();
		await Bun.write(modelsJsonPath, "{}");
		await registry.refresh("offline");
		expect(registry.find("anthropic", cachedModel.id)).toBeUndefined();

		await Bun.write(
			modelsJsonPath,
			JSON.stringify({
				providers: {
					anthropic: {
						baseUrl: "https://issue-5780.example.com/v1",
						api: "openai-completions",
						auth: "none",
						discovery: { type: "openai-models-list" },
					},
				},
			}),
		);
		await registry.refresh("offline");
		await Bun.write(modelsJsonPath, "{}");
		await registry.refresh("offline");
		expect(registry.find("anthropic", cachedModel.id)).toBeUndefined();

		expect(readModelCache("anthropic", Infinity, Date.now, dbPath)).not.toBeNull();
	});
	test("runtime manager suppresses a colliding legacy v12 standard cache row", () => {
		const legacyCacheModel = buildModel({
			id: "legacy-v12-runtime-model",
			name: "Legacy v12 Runtime Model",
			provider: "anthropic",
			api: "openai-completions" as const,
			baseUrl: "https://legacy-cache.example.com/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128_000,
			maxTokens: 8_192,
		});
		writeModelCache("anthropic", Date.now(), [legacyCacheModel], true, "", dbPath);
		const seeded = new Database(dbPath);
		seeded.run("UPDATE model_cache SET version = 12 WHERE provider_id = ?", ["anthropic"]);
		seeded.close();

		registry.registerProvider(
			"anthropic",
			{
				baseUrl: "https://issue-5780.example.com/v1",
				api: "openai-completions",
				fetchDynamicModels: async () => [],
			},
			sourceId,
		);

		expect(registry.getAll().some(model => model.id === legacyCacheModel.id)).toBe(false);
		expect(readModelCache("anthropic", Infinity, Date.now, dbPath)?.models.map(model => model.id)).toEqual([
			legacyCacheModel.id,
		]);
	});
	test("runtime discovery failure keeps a colliding bundled provider unavailable", async () => {
		registry.registerProvider(
			"anthropic",
			{
				baseUrl: "https://issue-5780.example.com/v1",
				api: "openai-completions",
				fetchDynamicModels: async () => {
					throw new Error("runtime discovery failed");
				},
			},
			sourceId,
		);

		await registry.refreshRuntimeProviders("online");
		expect(registry.getAll().some(model => model.provider === "anthropic")).toBe(false);
	});
	test("runtime dynamic catalogs do not serialize provider credentials", async () => {
		// Provider config carries a literal credential + authHeader, mirroring an
		// extension gateway. The dynamic factory itself never returns a credential.
		const config: ProviderConfigInput = {
			baseUrl: "https://issue-5780.example.com/v1",
			api: "openai-completions",
			apiKey: FAKE_KEY,
			authHeader: true,
			headers: { "X-Runtime-Secret": FAKE_HEADER },
			fetchDynamicModels: async () => [
				{
					id: "gated-model",
					name: "Gated Model",
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 128_000,
					maxTokens: 8_192,
				},
			],
		};
		registry.registerProvider(providerName, config, sourceId);
		await registry.refreshProvider(providerName, "online");
		expect(registry.find(providerName, "gated-model")?.headers).toEqual({
			Authorization: `Bearer ${FAKE_KEY}`,
			"X-Runtime-Secret": FAKE_HEADER,
		});

		// Other registry paths may initialize SQLite, but this runtime provider
		// never receives a row and its secrets never reach the cache bytes.
		expect(readModelCache(providerName, Infinity, Date.now, dbPath)).toBeNull();
		const rawCache = await fs.readFile(dbPath);
		expect(rawCache.includes(FAKE_KEY)).toBe(false);
		expect(rawCache.includes(FAKE_HEADER)).toBe(false);
	});
});
