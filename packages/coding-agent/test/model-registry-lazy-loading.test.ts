import { afterEach, describe, expect, test } from "bun:test";
import * as path from "node:path";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { writeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import { litellmModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models";
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

	afterEach(async () => {
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

	test("query order preserves ordering, snapshots, and model identity", async () => {
		const createRegistry = async (name: string): Promise<ModelRegistry> => {
			const tempDir = TempDir.createSync(`@model-registry-lazy-${name}-`);
			tempDirs.push(tempDir);
			const authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
			authStorages.push(authStorage);
			authStorage.setRuntimeApiKey("anthropic", "test-key");
			return new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
		};

		const findFirstRegistry = await createRegistry("find-first");
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
