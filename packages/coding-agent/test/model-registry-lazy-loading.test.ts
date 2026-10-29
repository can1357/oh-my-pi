import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as path from "node:path";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { writeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import { litellmModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models";
import { modelKind } from "@oh-my-pi/pi-catalog/types";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
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

describe("ModelRegistry lazy bundled composition", () => {
	const tempDirs: TempDir[] = [];
	const authStorages: AuthStorage[] = [];
	const spies: Array<{ mockRestore: () => void }> = [];

	afterEach(async () => {
		for (const spy of spies.splice(0)) spy.mockRestore();
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
	});

	test("loads the default LiteLLM namespaced cache", async () => {
		const tempDir = TempDir.createSync("@model-registry-lazy-litellm-cache-");
		tempDirs.push(tempDir);
		const authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorages.push(authStorage);
		const cacheProviderId = litellmModelManagerOptions().cacheProviderId;
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
});
