import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as path from "node:path";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { writeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import { litellmModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models";
import { modelKind } from "@oh-my-pi/pi-catalog/types";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
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

	test("cached availability follows credential removal and provider replacement", async () => {
		const auth = await AuthStorage.create(":memory:");
		authStorages.push(auth);
		const registry = new ModelRegistry(auth, undefined, { ignoreLocalModelConfig: true });
		const provider = "availability-fixture";
		const config = {
			baseUrl: "https://fixture.invalid/v1",
			apiKey: "fixture-key",
			api: "openai-completions" as const,
			models: [
				{
					id: "first",
					name: "First",
					reasoning: false,
					input: ["text" as const],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 8192,
					maxTokens: 1024,
				},
			],
		};
		registry.registerProvider(provider, config, "ext://availability-fixture");
		const source = auth.keys.source.bind(auth.keys);
		let enabled = true;
		spies.push(
			spyOn(auth.keys, "source").mockImplementation((id, options) =>
				id === provider && !enabled ? undefined : source(id, options),
			),
		);
		const available = () => registry.getAvailableForProviders(new Set([provider])).map(model => model.id);
		expect(available()).toEqual(["first"]);
		enabled = false;
		expect(available()).toEqual([]);
		enabled = true;
		expect(available()).toEqual(["first"]);
		registry.registerProvider(
			provider,
			{ ...config, models: [{ ...config.models[0], id: "second" }] },
			"ext://availability-fixture",
		);
		expect(available()).toEqual(["second"]);
		registry.clearSourceRegistrations("ext://availability-fixture");
		expect(available()).toEqual([]);
	});

	test("availability keeps implicit providers last across the full-snapshot transition", async () => {
		const auth = await AuthStorage.create(":memory:");
		authStorages.push(auth);
		const registry = new ModelRegistry(auth, undefined, { ignoreLocalModelConfig: true });
		const model = {
			id: "same-name",
			name: "Same Name",
			reasoning: false,
			input: ["text" as const],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 8192,
			maxTokens: 1024,
		};
		const config = {
			baseUrl: "https://fixture.invalid/v1",
			apiKey: "fixture-key",
			api: "openai-completions" as const,
		};
		registry.registerProvider("ollama", { ...config, models: [model] }, "ext://order-fixture");
		registry.registerProvider("zz-review-fixture", { ...config, models: [model] }, "ext://order-fixture");
		const providers = () =>
			registry
				.getAvailableForProviders(new Set(["ollama", "zz-review-fixture"]))
				.map(candidate => candidate.provider);
		const lazy = providers();
		expect(lazy).toEqual(["zz-review-fixture", "ollama"]);
		registry.getAll();
		expect(providers()).toEqual(lazy);
	});

	test("availability cache is invalidated for mixed-case provider ids", async () => {
		const auth = await AuthStorage.create(":memory:");
		authStorages.push(auth);
		const registry = new ModelRegistry(auth, undefined, { ignoreLocalModelConfig: true });
		const config = {
			baseUrl: "https://fixture.invalid/v1",
			apiKey: "fixture-key",
			api: "openai-completions" as const,
		};
		const withModel = (id: string) => ({
			...config,
			models: [
				{
					id,
					name: id,
					reasoning: false,
					input: ["text" as const],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 8192,
					maxTokens: 1024,
				},
			],
		});
		registry.registerProvider("Acme", withModel("first"), "ext://case-fixture");
		const available = () => registry.getAvailableForProviders(new Set(["acme"])).map(model => model.id);
		expect(available()).toEqual(["first"]);
		registry.registerProvider("Acme", withModel("second"), "ext://case-fixture");
		expect(available()).toEqual(["second"]);
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
