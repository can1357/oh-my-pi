import { Database } from "bun:sqlite";
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as path from "node:path";
import { type Api, getCustomApi, type Model, streamSimple } from "@oh-my-pi/pi-ai";
import { getOAuthProviders } from "@oh-my-pi/pi-ai/oauth";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { writeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import { getBundledModels } from "@oh-my-pi/pi-catalog/models";
import {
	litellmModelManagerOptions,
	resolveModelCacheProviderId,
	resolveOllamaModelCacheProviderId,
} from "@oh-my-pi/pi-catalog/provider-models";
import { modelKind } from "@oh-my-pi/pi-catalog/types";
import { ModelRegistry, type ProviderConfigInput } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resolveCliModel } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { cfgDisabledProviders } from "@oh-my-pi/pi-coding-agent/config/model-settings";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { TempDir } from "@oh-my-pi/pi-utils";

const probePath = path.join(import.meta.dir, "fixtures", "model-registry-construction-build-probe.ts");

function modelKeys(models: readonly Model<Api>[]): string[] {
	return models.map(model => `${model.provider}\0${model.id}`);
}

function expectSameModelObjects(models: readonly Model<Api>[], allModels: readonly Model<Api>[]): void {
	const allByKey = new Map(allModels.map(model => [`${model.provider}\0${model.id}`, model]));
	for (const model of models) {
		expect(allByKey.get(`${model.provider}\0${model.id}`)).toBe(model);
	}
}

function writeCachedModel(dbPath: string, cacheProviderId: string, provider: string, id: string): void {
	writeModelCache(
		cacheProviderId,
		Date.now(),
		[
			buildModel({
				id,
				name: id,
				api: "openai-completions",
				provider,
				baseUrl: `https://${provider}.example.invalid/v1`,
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 8192,
				maxTokens: 1024,
			}),
		],
		true,
		"",
		dbPath,
	);
}

/**
 * Corrupt `models` JSON in a current-policy `model_cache` row. `readModelCache`
 * deletes malformed rows on first read, making an untouched row count === 1
 * concrete proof that the provider's cached payload was never read or parsed.
 */
function poisonCachedProviderPayload(dbPath: string, cacheProviderId: string, provider: string): void {
	writeCachedModel(dbPath, cacheProviderId, provider, "poison-seed");
	const db = new Database(dbPath);
	try {
		db.run("UPDATE model_cache SET models = '{corrupt-json' WHERE provider_id = ?", [cacheProviderId]);
	} finally {
		db.close();
	}
}

function hasCachedProviderRow(dbPath: string, cacheProviderId: string): boolean {
	const db = new Database(dbPath, { readonly: true });
	try {
		return (
			db
				.query<{ found: number }, [string]>("SELECT 1 AS found FROM model_cache WHERE provider_id = ?")
				.get(cacheProviderId) !== null
		);
	} finally {
		db.close();
	}
}

describe("ModelRegistry lazy bundled composition", () => {
	const tempDirs: TempDir[] = [];
	const authStorages: AuthStorage[] = [];
	const spies: Array<{ mockRestore: () => void }> = [];
	const registeredSources: Array<{ registry: ModelRegistry; sourceId: string }> = [];

	function registerProvider(
		registry: ModelRegistry,
		provider: string,
		config: ProviderConfigInput,
		sourceId: string,
	): void {
		registeredSources.push({ registry, sourceId });
		registry.registerProvider(provider, config, sourceId);
	}

	afterEach(async () => {
		for (const spy of spies.splice(0)) spy.mockRestore();
		for (const { registry, sourceId } of registeredSources.splice(0)) {
			registry.clearSourceRegistrations(sourceId);
		}
		for (const authStorage of authStorages.splice(0)) authStorage.close();
		await Promise.all(tempDirs.splice(0).map(tempDir => tempDir.remove().catch(() => {})));
	});

	test("construction does not materialize bundled or cached models", async () => {
		const proc = Bun.spawn([process.execPath, probePath], {
			cwd: path.join(import.meta.dir, "../../.."),
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		expect(exitCode, stderr).toBe(0);
		expect(JSON.parse(stdout)).toEqual({ buildCalls: 0 });
	}, 15_000);

	test("hydrates only the current LiteLLM credential's cached roster", async () => {
		const tempDir = TempDir.createSync("@model-registry-lazy-litellm-cache-");
		tempDirs.push(tempDir);
		const authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorages.push(authStorage);
		authStorage.keys.setRuntime("litellm", "sk-team-a");
		const cacheProviderId = litellmModelManagerOptions({ apiKey: "sk-team-a" }).cacheProviderId;
		if (!cacheProviderId) throw new Error("LiteLLM must define a cache namespace");
		writeModelCache(
			cacheProviderId,
			Date.now(),
			[
				buildModel({
					id: "cached-fixture",
					name: "Cached Fixture",
					api: "openai-completions",
					provider: "litellm",
					baseUrl: "http://localhost:4000/v1",
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 8192,
					maxTokens: 1024,
				}),
			],
			true,
			"",
			path.join(tempDir.path(), "models.db"),
		);

		const registry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
		expect(registry.find("litellm", "cached-fixture")).toBeUndefined();
		await registry.hydrateCredentialScopedModelCaches();
		expect(registry.find("litellm", "cached-fixture")?.name).toBe("Cached Fixture");
	});

	test("scoped snapshots retain live availability and cannot be mutated through returned arrays", async () => {
		const tempDir = TempDir.createSync("@model-registry-scoped-snapshot-");
		tempDirs.push(tempDir);
		const authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorages.push(authStorage);
		const settings = Settings.isolated();
		const registry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"), { settings });
		const provider = "snapshot-fixture";
		const providers = new Set([provider]);
		const definition = {
			id: "first",
			name: "First",
			reasoning: false,
			input: ["text"] as ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 8192,
			maxTokens: 1024,
		};
		registry.registerProvider(provider, {
			api: "openai-completions",
			baseUrl: "https://example.invalid/v1",
			apiKey: "test-key",
			models: [definition],
		});
		const first = registry.getAvailableForProviders(providers, "all");
		expect(first.map(model => model.id)).toEqual(["first"]);
		expect(registry.find(provider, "first")).toBe(first[0]);
		first.length = 0;
		expect(registry.getAvailableForProviders(providers, "all").map(model => model.id)).toEqual(["first"]);
		cfgDisabledProviders.set(settings, [provider]);
		expect(registry.getAvailableForProviders(providers)).toEqual([]);
		cfgDisabledProviders.set(settings, []);
		expect(registry.getAvailableForProviders(providers).map(model => model.id)).toEqual(["first"]);

		registry.registerProvider(provider, {
			api: "openai-completions",
			baseUrl: "https://example.invalid/v2",
			apiKey: "test-key",
			models: [{ ...definition, id: "second", contextWindow: 16384 }],
		});
		expect(registry.find(provider, "first")).toBeUndefined();
		const second = registry.getAvailableForProviders(providers);
		expect(second.map(model => model.id)).toEqual(["second"]);
		expect(second[0].contextWindow).toBe(16384);
		expect(second[0].baseUrl).toBe("https://example.invalid/v2");
		expect(registry.find(provider, "second")).toBe(second[0]);
	});

	test("policy refresh invalidates scoped catalogs after models config edits", async () => {
		const tempDir = TempDir.createSync("@model-registry-scoped-refresh-");
		tempDirs.push(tempDir);
		const authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorages.push(authStorage);
		const configPath = path.join(tempDir.path(), "models.json");
		const config = {
			providers: {
				"refresh-fixture": {
					api: "openai-completions",
					baseUrl: "https://example.invalid/v1",
					apiKey: "test-key",
					models: [{ id: "fixture", name: "Before", contextWindow: 8192, maxTokens: 1024 }],
				},
			},
		};
		await Bun.write(configPath, JSON.stringify(config));
		const registry = new ModelRegistry(authStorage, configPath);
		const providers = new Set(["refresh-fixture"]);
		const before = registry.getAvailableForProviders(providers)[0];
		expect(before.name).toBe("Before");
		config.providers["refresh-fixture"].models[0].name = "After";
		config.providers["refresh-fixture"].models[0].contextWindow = 16384;
		await Bun.write(configPath, JSON.stringify(config));
		await registry.reapplyModelPolicies();
		const after = registry.getAvailableForProviders(providers)[0];
		expect(after.name).toBe("After");
		expect(after.contextWindow).toBe(16384);
		expect(after).not.toBe(before);
		expect(registry.find("refresh-fixture", "fixture")).toBe(after);
	});

	test("query order preserves ordering, snapshots, and model identity", async () => {
		const createRegistry = async (name: string, maskTypeSafeEnvAuth = false): Promise<ModelRegistry> => {
			const tempDir = TempDir.createSync(`@model-registry-lazy-${name}-`);
			tempDirs.push(tempDir);
			const authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
			authStorages.push(authStorage);
			authStorage.keys.setRuntime("anthropic", "test-key");
			if (maskTypeSafeEnvAuth) {
				const source = authStorage.keys.source.bind(authStorage.keys);
				spies.push(
					spyOn(authStorage.keys, "source").mockImplementation((provider, options) =>
						provider === "typesafe" ? undefined : source(provider, options),
					),
				);
			}
			return new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
		};

		const findFirstRegistry = await createRegistry("find-first");
		const scopedRegistry = await createRegistry("scoped-first", true);
		const scopedProviders = new Set(["anthropic", "local", "web", "typesafe"]);
		const startupPool = scopedRegistry.getAvailableForProviders(scopedProviders);
		expect(startupPool.some(model => model.provider === "anthropic")).toBe(true);
		expect(startupPool.every(model => modelKind(model) === "chat")).toBe(true);
		expect(startupPool.some(model => ["local", "web", "typesafe"].includes(model.provider))).toBe(false);
		const scopedAllKinds = scopedRegistry.getAvailableForProviders(scopedProviders, "all");
		expect(scopedAllKinds).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ provider: "local", kind: "tiny" }),
				expect.objectContaining({ provider: "web", kind: "search" }),
			]),
		);
		expect(scopedAllKinds.some(model => model.provider === "typesafe")).toBe(false);

		const foundBeforeAll = findFirstRegistry.find("anthropic", "claude-sonnet-4-5");
		expect(foundBeforeAll).toBeDefined();
		const availableBeforeAll = findFirstRegistry.getAvailable();
		const availableAgain = findFirstRegistry.getAvailable();
		expect(availableAgain).not.toBe(availableBeforeAll);
		expect(availableAgain).toEqual(availableBeforeAll);
		for (let index = 0; index < availableBeforeAll.length; index += 1) {
			expect(availableAgain[index]).toBe(availableBeforeAll[index]);
		}
		const allAfterSelectiveQueries = findFirstRegistry.getAll();
		expect(findFirstRegistry.getAll()).toBe(allAfterSelectiveQueries);
		expect(foundBeforeAll).toBe(
			allAfterSelectiveQueries.find(model => model.provider === "anthropic" && model.id === "claude-sonnet-4-5"),
		);
		expect(foundBeforeAll).toBe(
			availableBeforeAll.find(model => model.provider === "anthropic" && model.id === "claude-sonnet-4-5"),
		);
		expectSameModelObjects(availableBeforeAll, allAfterSelectiveQueries);

		const allFirstRegistry = await createRegistry("all-first");
		const allBeforeSelectiveQueries = allFirstRegistry.getAll();
		const availableAfterAll = allFirstRegistry.getAvailable();
		const foundAfterAll = allFirstRegistry.find("anthropic", "claude-sonnet-4-5");
		expect(allFirstRegistry.getAll()).toBe(allBeforeSelectiveQueries);
		expect(foundAfterAll).toBe(
			allBeforeSelectiveQueries.find(model => model.provider === "anthropic" && model.id === "claude-sonnet-4-5"),
		);
		expectSameModelObjects(availableAfterAll, allBeforeSelectiveQueries);
		expect(modelKeys(allBeforeSelectiveQueries)).toEqual(modelKeys(allAfterSelectiveQueries));
		expect(modelKeys(availableAfterAll)).toEqual(modelKeys(availableBeforeAll));
	});

	test("registering oauth.modifyModels without stored OAuth credentials keeps unrelated cached providers unparsed until login", async () => {
		const tempDir = TempDir.createSync("@model-registry-lazy-modifier-");
		tempDirs.push(tempDir);
		const authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorages.push(authStorage);
		authStorage.keys.setRuntime("anthropic", "sk-anthropic-test");

		const dbPath = path.join(tempDir.path(), "models.db");
		const nanogptCacheId = resolveModelCacheProviderId("nanogpt");
		const openrouterCacheId = resolveModelCacheProviderId("openrouter");
		poisonCachedProviderPayload(dbPath, nanogptCacheId, "nanogpt");
		writeCachedModel(dbPath, openrouterCacheId, "openrouter", "cached-openrouter-probe");

		const registry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"), {
			cacheDbPath: dbPath,
		});
		let modifierCalls = 0;
		let sawOpenRouterInProjection = false;

		registerProvider(
			registry,
			"corp-oauth",
			{
				api: "custom-corp-oauth-api",
				baseUrl: "https://corp.example.invalid/v1",
				streamSimple,
				models: [
					{
						id: "bootstrap-model",
						name: "Bootstrap Model",
						reasoning: false,
						input: ["text"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 8192,
						maxTokens: 1024,
					},
				],
				oauth: {
					name: "Corp OAuth",
					login: async () => ({ access: "tok", refresh: "ref", expires: Date.now() + 60_000 }),
					refreshToken: async credentials => credentials,
					getApiKey: credentials => credentials.access,
					modifyModels: models => {
						modifierCalls += 1;
						sawOpenRouterInProjection = models.some(
							model => model.provider === "openrouter" && model.id === "cached-openrouter-probe",
						);
						return [
							...models.filter(model => model.provider !== "corp-oauth"),
							{
								...(models.find(model => model.provider === "corp-oauth") as Model<Api>),
								id: "projected-model",
								name: "Projected Model",
							},
						];
					},
				},
			},
			"ext://corp-oauth",
		);
		expect(getOAuthProviders().some(provider => provider.id === "corp-oauth")).toBe(true);
		expect(getCustomApi("custom-corp-oauth-api")).toBeDefined();

		expect(modifierCalls).toBe(0);
		expect(hasCachedProviderRow(dbPath, nanogptCacheId)).toBe(true);
		expect(registry.find("anthropic", "claude-sonnet-4-5")).toBeDefined();
		expect(registry.find("corp-oauth", "bootstrap-model")?.name).toBe("Bootstrap Model");
		expect(registry.getAvailable().some(model => model.provider === "anthropic")).toBe(true);
		expect(registry.getAllEnabled("chat", ["nanogpt"]).some(model => model.id === "cached-openrouter-probe")).toBe(
			true,
		);
		expect(modifierCalls).toBe(0);
		expect(hasCachedProviderRow(dbPath, nanogptCacheId)).toBe(true);

		await authStorage.credentials.set("corp-oauth", {
			type: "oauth",
			access: "corp-access-token",
			refresh: "corp-refresh-token",
			expires: Date.now() + 60_000,
		});

		expect(registry.find("corp-oauth", "bootstrap-model")).toBeUndefined();
		expect(registry.find("corp-oauth", "projected-model")?.name).toBe("Projected Model");
		expect(modifierCalls).toBeGreaterThan(0);
		expect(sawOpenRouterInProjection).toBe(true);
		expect(hasCachedProviderRow(dbPath, nanogptCacheId)).toBe(false);
	});

	test("lazy provider override with restricted models and oauth.modifyModels replaces bundled and cached models under API-key auth", async () => {
		expect(getOAuthProviders().some(provider => provider.id === "corp-oauth")).toBe(false);
		expect(getCustomApi("custom-corp-oauth-api")).toBeUndefined();

		const tempDir = TempDir.createSync("@model-registry-lazy-restricted-override-");
		tempDirs.push(tempDir);
		const authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorages.push(authStorage);
		authStorage.keys.setRuntime("openrouter", "sk-corp-openrouter-key");

		const bundledOpenRouterId = getBundledModels("openrouter")[0]?.id;
		if (!bundledOpenRouterId) throw new Error("Expected bundled OpenRouter models");

		const configPath = path.join(tempDir.path(), "models.json");
		await Bun.write(
			configPath,
			JSON.stringify({
				providers: {
					openrouter: {
						api: "openai-completions",
						baseUrl: "https://openrouter.ai/api/v1",
						models: [
							{
								id: "yaml-openrouter-unlisted",
								name: "YAML Unlisted",
								contextWindow: 8192,
								maxTokens: 1024,
							},
						],
					},
				},
			}),
		);

		const dbPath = path.join(tempDir.path(), "models.db");
		const nanogptCacheId = resolveModelCacheProviderId("nanogpt");
		const openrouterCacheId = resolveModelCacheProviderId("openrouter");
		poisonCachedProviderPayload(dbPath, nanogptCacheId, "nanogpt");
		writeCachedModel(dbPath, openrouterCacheId, "openrouter", "cached-openrouter-unlisted");

		const registry = new ModelRegistry(authStorage, configPath, {
			cacheDbPath: dbPath,
			fetch: async () => {
				throw new Error("network disabled in lazy provider replacement test");
			},
		});
		let modifierCalls = 0;
		let projectedOpenRouterIds: string[] = [];

		registerProvider(
			registry,
			"openrouter",
			{
				api: "openai-completions",
				baseUrl: "https://corp-gateway.example.invalid/v1",
				models: [
					{
						id: "corp-approved-model",
						name: "Corp Approved Model",
						reasoning: false,
						input: ["text"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 16384,
						maxTokens: 2048,
					},
				],
				oauth: {
					name: "Corp OpenRouter OAuth",
					login: async () => ({ access: "tok", refresh: "ref", expires: Date.now() + 60_000 }),
					refreshToken: async credentials => credentials,
					getApiKey: credentials => credentials.access,
					modifyModels: models => {
						modifierCalls += 1;
						projectedOpenRouterIds = models
							.filter(model => model.provider === "openrouter")
							.map(model => model.id);
						return models.map(model =>
							model.provider === "openrouter" ? { ...model, name: "OAuth Projected Model" } : model,
						);
					},
				},
			},
			"ext://restricted-openrouter",
		);

		expect(modifierCalls).toBe(0);
		expect(hasCachedProviderRow(dbPath, nanogptCacheId)).toBe(true);
		expect(registry.getProviderModels("openrouter").map(model => model.id)).toEqual(["corp-approved-model"]);
		expect(
			registry
				.getAvailable()
				.filter(model => model.provider === "openrouter")
				.map(model => model.id),
		).toEqual(["corp-approved-model"]);
		expect(registry.find("openrouter", bundledOpenRouterId)).toBeUndefined();
		expect(registry.find("openrouter", "cached-openrouter-unlisted")).toBeUndefined();
		expect(registry.find("openrouter", "yaml-openrouter-unlisted")).toBeUndefined();
		expect(hasCachedProviderRow(dbPath, nanogptCacheId)).toBe(true);

		expect(
			registry
				.getAll()
				.filter(model => model.provider === "openrouter")
				.map(model => model.id),
		).toEqual(["corp-approved-model"]);
		await registry.refresh("offline");
		expect(registry.getProviderModels("openrouter").map(model => model.id)).toEqual(["corp-approved-model"]);
		expect(
			registry
				.getAvailable()
				.filter(model => model.provider === "openrouter")
				.map(model => model.id),
		).toEqual(["corp-approved-model"]);

		await authStorage.credentials.set("openrouter", {
			type: "oauth",
			access: "corp-oauth-token",
			refresh: "corp-oauth-refresh",
			expires: Date.now() + 60_000,
		});
		expect(registry.find("openrouter", "corp-approved-model")?.name).toBe("OAuth Projected Model");
		expect(modifierCalls).toBeGreaterThan(0);
		expect(projectedOpenRouterIds).toEqual(["corp-approved-model"]);
	});

	test("re-registering the last active oauth.modifyModels owner without the hook immediately restores other providers' interned models", async () => {
		const tempDir = TempDir.createSync("@model-registry-eager-modifier-removal-");
		tempDirs.push(tempDir);
		const authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorages.push(authStorage);
		authStorage.keys.setRuntime("anthropic", "sk-anthropic-test");
		await authStorage.credentials.set("corp-modifier", {
			type: "oauth",
			access: "corp-access-token",
			refresh: "corp-refresh-token",
			expires: Date.now() + 60_000,
		});

		const bundledSonnetName = getBundledModels("anthropic").find(model => model.id === "claude-sonnet-4-5")?.name;
		if (!bundledSonnetName) throw new Error("Expected bundled anthropic/claude-sonnet-4-5");

		const registry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
		registerProvider(
			registry,
			"corp-modifier",
			{
				api: "custom-corp-modifier-api",
				baseUrl: "https://corp.example.invalid/v1",
				streamSimple,
				models: [
					{
						id: "corp-v1",
						name: "Corp V1",
						reasoning: false,
						input: ["text"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 8192,
						maxTokens: 1024,
					},
				],
				oauth: {
					name: "Corp Modifier OAuth",
					login: async () => ({ access: "tok", refresh: "ref", expires: Date.now() + 60_000 }),
					refreshToken: async credentials => credentials,
					getApiKey: credentials => credentials.access,
					modifyModels: models =>
						models.map(model =>
							model.provider === "anthropic" && model.id === "claude-sonnet-4-5"
								? { ...model, name: "Projected By Corp Modifier" }
								: model,
						),
				},
			},
			"ext://corp-modifier",
		);

		expect(registry.find("anthropic", "claude-sonnet-4-5")?.name).toBe("Projected By Corp Modifier");
		expect(
			registry.getAll().find(model => model.provider === "anthropic" && model.id === "claude-sonnet-4-5")?.name,
		).toBe("Projected By Corp Modifier");
		expect(
			registry.getAvailable().find(model => model.provider === "anthropic" && model.id === "claude-sonnet-4-5")
				?.name,
		).toBe("Projected By Corp Modifier");

		registerProvider(
			registry,
			"corp-modifier",
			{
				api: "custom-corp-modifier-api",
				baseUrl: "https://corp.example.invalid/v1",
				streamSimple,
				models: [
					{
						id: "corp-v2",
						name: "Corp V2",
						reasoning: false,
						input: ["text"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 8192,
						maxTokens: 1024,
					},
				],
				oauth: {
					name: "Corp Modifier OAuth",
					login: async () => ({ access: "tok", refresh: "ref", expires: Date.now() + 60_000 }),
					refreshToken: async credentials => credentials,
					getApiKey: credentials => credentials.access,
				},
			},
			"ext://corp-modifier",
		);

		expect(registry.find("corp-modifier", "corp-v1")).toBeUndefined();
		expect(registry.find("corp-modifier", "corp-v2")?.name).toBe("Corp V2");
		expect(registry.find("anthropic", "claude-sonnet-4-5")?.name).toBe(bundledSonnetName);
		expect(
			registry.getAll().find(model => model.provider === "anthropic" && model.id === "claude-sonnet-4-5")?.name,
		).toBe(bundledSonnetName);
		expect(
			registry.getAvailable().find(model => model.provider === "anthropic" && model.id === "claude-sonnet-4-5")
				?.name,
		).toBe(bundledSonnetName);
	});

	test("getAllEnabled and resolveCliModel skip disabled providers' cached rows while getAll materializes them on demand", async () => {
		const tempDir = TempDir.createSync("@model-registry-lazy-disabled-");
		tempDirs.push(tempDir);
		const authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorages.push(authStorage);
		authStorage.keys.setRuntime("anthropic", "sk-anthropic-test");

		const configPath = path.join(tempDir.path(), "models.json");
		const dbPath = path.join(tempDir.path(), "models.db");
		const nanogptCacheId = resolveModelCacheProviderId("nanogpt");
		const openrouterCacheId = resolveModelCacheProviderId("openrouter");
		const disabledOllamaCacheId = resolveOllamaModelCacheProviderId(
			"disabled-ollama",
			"http://disabled-ollama.example:11434/v1",
		);
		const enabledOllamaCacheId = resolveOllamaModelCacheProviderId(
			"enabled-ollama",
			"http://enabled-ollama.example:11434/v1",
		);
		await Bun.write(
			configPath,
			JSON.stringify({
				providers: {
					"disabled-ollama": {
						api: "openai-completions",
						baseUrl: "http://disabled-ollama.example:11434/v1",
						auth: "none",
						discovery: { type: "ollama" },
					},
					"enabled-ollama": {
						api: "openai-completions",
						baseUrl: "http://enabled-ollama.example:11434/v1",
						auth: "none",
						discovery: { type: "ollama" },
					},
				},
			}),
		);
		poisonCachedProviderPayload(dbPath, nanogptCacheId, "nanogpt");
		writeCachedModel(dbPath, openrouterCacheId, "openrouter", "disabled-openrouter-model");
		poisonCachedProviderPayload(dbPath, disabledOllamaCacheId, "disabled-ollama");
		writeCachedModel(dbPath, enabledOllamaCacheId, "enabled-ollama", "live-local-model");

		const settings = Settings.isolated({
			disabledProviders: ["nanogpt", "openrouter", "disabled-ollama"],
		});
		const registry = new ModelRegistry(authStorage, configPath, { settings, cacheDbPath: dbPath });

		// Construction leaves both standard and discoverable cache rows unread.
		expect(hasCachedProviderRow(dbPath, nanogptCacheId)).toBe(true);
		expect(hasCachedProviderRow(dbPath, disabledOllamaCacheId)).toBe(true);

		const enabledModels = registry.getAllEnabled();
		expect(enabledModels.some(model => model.provider === "enabled-ollama" && model.id === "live-local-model")).toBe(
			true,
		);
		expect(enabledModels.some(model => model.provider === "openrouter")).toBe(false);
		expect(hasCachedProviderRow(dbPath, nanogptCacheId)).toBe(true);
		expect(hasCachedProviderRow(dbPath, disabledOllamaCacheId)).toBe(true);

		const cliResolved = resolveCliModel({
			cliModel: "enabled-ollama/live-local-model",
			modelRegistry: registry,
			settings,
		});
		expect(cliResolved.error).toBeUndefined();
		expect(cliResolved.model?.id).toBe("live-local-model");
		expect(hasCachedProviderRow(dbPath, nanogptCacheId)).toBe(true);
		expect(hasCachedProviderRow(dbPath, disabledOllamaCacheId)).toBe(true);

		// Explicit full-catalog inspection (`/models all`) still loads disabled providers on demand.
		const allModels = registry.getAll();
		expect(allModels.some(model => model.provider === "openrouter" && model.id === "disabled-openrouter-model")).toBe(
			true,
		);
		expect(hasCachedProviderRow(dbPath, nanogptCacheId)).toBe(false);
		expect(hasCachedProviderRow(dbPath, disabledOllamaCacheId)).toBe(false);
	});

	test("refreshSelectedModelMetadata probed limits survive later registerProvider overrides on other providers", async () => {
		const tempDir = TempDir.createSync("@model-registry-probed-metadata-interning-");
		tempDirs.push(tempDir);
		const authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorages.push(authStorage);
		authStorage.keys.setRuntime("openai", "sk-openai-test");

		const configPath = path.join(tempDir.path(), "models.json");
		const dbPath = path.join(tempDir.path(), "models.db");
		await Bun.write(
			configPath,
			JSON.stringify({
				providers: {
					"lm-studio": {
						api: "openai-completions",
						baseUrl: "http://127.0.0.1:1234/v1",
						auth: "none",
						discovery: { type: "lm-studio" },
					},
				},
			}),
		);

		let state: "not-loaded" | "loaded" = "not-loaded";
		const fetchMock: FetchImpl = async input => {
			const url = String(input);
			if (url === "http://127.0.0.1:1234/api/v0/models") {
				return new Response(
					JSON.stringify({
						data: [
							{
								id: "local-qwen",
								type: "llm",
								state,
								max_context_length: 32768,
								loaded_context_length: state === "loaded" ? 4096 : null,
							},
						],
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			if (url === "http://127.0.0.1:1234/v1/models") {
				return new Response(JSON.stringify({ data: [{ id: "local-qwen", object: "model" }] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			return new Response(null, { status: 404 });
		};

		const registry = new ModelRegistry(authStorage, configPath, {
			cacheDbPath: dbPath,
			fetch: fetchMock,
		});
		await registry.refreshDiscoverableProviders(["lm-studio"], "online");

		const initial = registry.find("lm-studio", "local-qwen");
		if (!initial) throw new Error("Expected discovered lm-studio/local-qwen");
		expect(initial.contextWindow).toBe(32768);
		expect(
			registry.getAll().find(model => model.provider === "lm-studio" && model.id === "local-qwen")?.contextWindow,
		).toBe(32768);
		expect(
			registry.getAvailable().find(model => model.provider === "lm-studio" && model.id === "local-qwen")
				?.contextWindow,
		).toBe(32768);

		state = "loaded";
		const probed = await registry.refreshSelectedModelMetadata(initial);
		expect(probed.contextWindow).toBe(4096);
		expect(registry.find("lm-studio", "local-qwen")?.contextWindow).toBe(4096);
		expect(
			registry.getAll().find(model => model.provider === "lm-studio" && model.id === "local-qwen")?.contextWindow,
		).toBe(4096);
		expect(
			registry.getAvailable().find(model => model.provider === "lm-studio" && model.id === "local-qwen")
				?.contextWindow,
		).toBe(4096);

		registerProvider(
			registry,
			"openai",
			{
				baseUrl: "https://proxy.example.invalid/v1",
			},
			"ext://openai-transport-override",
		);
		expect(registry.find("lm-studio", "local-qwen")?.contextWindow).toBe(4096);
		expect(
			registry.getAll().find(model => model.provider === "lm-studio" && model.id === "local-qwen")?.contextWindow,
		).toBe(4096);
		expect(
			registry.getAvailable().find(model => model.provider === "lm-studio" && model.id === "local-qwen")
				?.contextWindow,
		).toBe(4096);

		registerProvider(
			registry,
			"corp-static",
			{
				api: "openai-completions",
				baseUrl: "https://corp.example.invalid/v1",
				apiKey: "CORP_API_KEY",
				models: [
					{
						id: "corp-model",
						name: "Corp Model",
						reasoning: false,
						input: ["text"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 16384,
						maxTokens: 2048,
					},
				],
			},
			"ext://corp-static-override",
		);
		expect(registry.find("lm-studio", "local-qwen")?.contextWindow).toBe(4096);
		expect(
			registry.getAll().find(model => model.provider === "lm-studio" && model.id === "local-qwen")?.contextWindow,
		).toBe(4096);
		expect(
			registry.getAvailable().find(model => model.provider === "lm-studio" && model.id === "local-qwen")
				?.contextWindow,
		).toBe(4096);
	});
});
