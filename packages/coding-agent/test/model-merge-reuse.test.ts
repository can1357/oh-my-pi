import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as path from "node:path";
import type { Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { readModelCache, writeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import { fingerprintStaticModels } from "@oh-my-pi/pi-catalog/model-manager";
import * as catalogModels from "@oh-my-pi/pi-catalog/models";
import { mergeDiscoveredModel } from "@oh-my-pi/pi-coding-agent/config/model-patch";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { TempDir } from "@oh-my-pi/pi-utils";

function fixtureModel(id = "merge-fixture"): Model<"openai-completions"> {
	return buildModel({
		id,
		name: "Merge fixture",
		api: "openai-completions",
		provider: "openai",
		baseUrl: "https://api.openai.com/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 1024,
	});
}

describe("model merge reuse", () => {
	const tempDirs: TempDir[] = [];
	const authStorages: AuthStorage[] = [];
	const spies: Array<{ mockRestore: () => void }> = [];

	afterEach(async () => {
		for (const spy of spies.splice(0)) spy.mockRestore();
		for (const authStorage of authStorages.splice(0)) authStorage.close();
		await Promise.all(tempDirs.splice(0).map(tempDir => tempDir.remove()));
	});

	test("shares the discovery snapshot when bundled fallbacks contribute no values", () => {
		const discovered = { ...fixtureModel(), supportsTools: false };
		const existing = {
			...fixtureModel(),
			baseUrl: "https://stale.example/v1",
			contextWindow: 4096,
			supportsTools: true,
		};

		const merged = mergeDiscoveredModel(discovered, existing);

		expect(merged.baseUrl).toBe("https://api.openai.com/v1");
		expect(merged.contextWindow).toBe(8192);
		expect(merged.supportsTools).toBe(false);
		expect(merged).toBe(discovered);
	});

	test("reapplies changed fallbacks when the same model objects are merged again", () => {
		const discovered = fixtureModel();
		const existing = fixtureModel();

		expect(mergeDiscoveredModel(discovered, existing)).toBe(discovered);
		existing.transport = "pi-native";

		expect(mergeDiscoveredModel(discovered, existing).transport).toBe("pi-native");
	});

	test("shares discovery with an out-of-scope endpoint override but applies matching overrides", () => {
		const discovered = fixtureModel();
		const override = { baseUrl: "https://proxy.example/v1" };

		const outOfScope = mergeDiscoveredModel(discovered, undefined, {
			...override,
			baseUrlApis: ["anthropic-messages"],
		});
		const matching = mergeDiscoveredModel(discovered, undefined, {
			...override,
			baseUrlApis: ["openai-completions"],
		});

		expect(outOfScope).toBe(discovered);
		expect(matching.baseUrl).toBe(override.baseUrl);
		expect(discovered.baseUrl).toBe("https://api.openai.com/v1");
	});

	test("normalizes stale resolved compatibility before deciding a discovery merge is unchanged", () => {
		const current = fixtureModel();
		const stale = {
			...current,
			compat: { ...current.compat, supportsDeveloperRole: !current.compat.supportsDeveloperRole },
		};

		const withExisting = mergeDiscoveredModel(stale, current);
		const withOverride = mergeDiscoveredModel(stale, undefined, {});

		expect(withExisting.compat.supportsDeveloperRole).toBe(current.compat.supportsDeveloperRole);
		expect(withOverride.compat.supportsDeveloperRole).toBe(current.compat.supportsDeveloperRole);
		expect(stale.compat.supportsDeveloperRole).toBe(!current.compat.supportsDeveloperRole);
	});

	test("cached replacements inherit missing limits and flags without overwriting explicit false values", async () => {
		const tempDir = TempDir.createSync("@model-merge-reuse-");
		tempDirs.push(tempDir);
		const authStorage = await AuthStorage.create(":memory:");
		authStorages.push(authStorage);
		authStorage.keys.setRuntime("openai", "fixture-key");
		const existing = ["fallback", "explicit"].map(id => ({
			...fixtureModel(id),
			omitMaxOutputTokens: true,
			supportsTools: true,
		}));
		spies.push(
			spyOn(catalogModels, "getBundledModels").mockImplementation(provider =>
				provider === "openai" ? existing : [],
			),
		);
		const cachePath = path.join(tempDir.path(), "models.db");
		writeModelCache(
			"openai",
			Date.now(),
			[
				{ ...fixtureModel("fallback"), contextWindow: null, maxTokens: null },
				{
					...fixtureModel("explicit"),
					contextWindow: 4096,
					maxTokens: 512,
					omitMaxOutputTokens: false,
					supportsTools: false,
				},
			],
			false,
			fingerprintStaticModels(existing, false),
			cachePath,
		);
		const cached = readModelCache("openai", 60_000, Date.now, cachePath);
		expect(cached?.models.map(model => model.id)).toEqual(["fallback", "explicit"]);
		const registry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));

		const available = registry.getAvailableForProviders(new Set(["openai"]));
		const all = registry.getAll().filter(model => model.provider === "openai");

		expect(available.map(model => model.id)).toEqual(["fallback", "explicit"]);
		expect(all).toEqual(available);
		expect(registry.find("openai", "fallback")).toMatchObject({
			contextWindow: 8192,
			maxTokens: 1024,
			omitMaxOutputTokens: true,
			supportsTools: true,
		});
		expect(registry.find("openai", "explicit")).toMatchObject({
			contextWindow: 4096,
			maxTokens: 512,
			omitMaxOutputTokens: false,
			supportsTools: false,
		});
		expect(registry.find("openai", "explicit")).toBe(cached?.models[1]);
		expect(cached?.models[0].contextWindow).toBeNull();
		expect(cached?.models[0].maxTokens).toBeNull();
	});
});
