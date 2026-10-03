import { describe, expect, test } from "bun:test";
import type { Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import {
	buildDefaultModelRolePreset,
	deleteModelRolePreset,
	getModelRolePreset,
	getModelRolePresetDefault,
	getModelRolePresetDefaultName,
	getModelRolePresetNames,
	isModelRolePresetName,
	resetModelRolePresetDefault,
	saveModelRolePreset,
	saveModelRolePresetDefault,
	renameModelRolePreset,
	setModelRolePresetDefault,
} from "../src/config/model-role-presets";

function model(provider: string, id: string, baseUrl: string = "https://api.example.test/v1"): Model {
	return buildModel({
		provider,
		id,
		name: id,
		baseUrl,
		api: "openai-completions",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 4096,
	});
}

const opus = model("anthropic", "claude-opus-5");
const cheapRoles = { smol: "anthropic/claude-haiku-4-5" };
const qualityRoles = { plan: "anthropic/claude-opus-5", task: "anthropic/claude-opus-5" };

describe("built-in model role presets", () => {
	test("uses resolved catalog priority within the selected provider", () => {
		const selected = opus;
		const haiku = model("anthropic", "claude-haiku-4-5");
		const preset = buildDefaultModelRolePreset(selected, [
			selected,
			model("google", "gemini-3.8-flash"),
			model("openai-codex", "gpt-5.6-sol"),
			model("anthropic", "claude-fable-5"),
			model("anthropic", "claude-fable-5-1"),
			haiku,
		]);
		expect(preset.roles).toEqual({
			smol: "anthropic/claude-haiku-4-5",
			tiny: "anthropic/claude-haiku-4-5",
			slow: "anthropic/claude-fable-5-1",
			task: "anthropic/claude-fable-5-1",
			commit: "anthropic/claude-fable-5-1",
			plan: "anthropic/claude-fable-5-1",
			advisor: "anthropic/claude-fable-5-1",
			vision: "anthropic/claude-opus-5",
		});
	});

	test("selects by resolved priority facts rather than recognized model names", () => {
		const selected = model("custom", "primary");
		const preferred: Model = { ...model("custom", "preferred"), rolePresetPriority: { smol: 0 } };
		const runnerUp: Model = { ...model("custom", "runner-up"), rolePresetPriority: { smol: 1 } };
		const foreign: Model = { ...model("other", "preferred"), rolePresetPriority: { smol: 0, slow: 0 } };
		const preset = buildDefaultModelRolePreset(selected, [
			runnerUp,
			model("custom", "claude-haiku-4-5"),
			foreign,
			preferred,
			selected,
		]);
		expect(preset.roles.smol).toBe("custom/preferred");
		expect(preset.roles.slow).toBe("custom/primary");
	});
	test("keeps equally ranked Bedrock candidates in the selected deployment namespace", () => {
		const selected = model("amazon-bedrock", "us.anthropic.claude-opus-5");
		const usHaiku: Model = {
			...model("amazon-bedrock", "us.anthropic.claude-haiku-4-5"),
			rolePresetPriority: { smol: 0 },
		};
		const auHaiku: Model = {
			...model("amazon-bedrock", "au.anthropic.claude-haiku-4-5"),
			rolePresetPriority: { smol: 0 },
		};
		const usFable: Model = {
			...model("amazon-bedrock", "us.anthropic.claude-fable-5"),
			rolePresetPriority: { slow: 0 },
		};
		const euFable: Model = {
			...model("amazon-bedrock", "eu.anthropic.claude-fable-5"),
			rolePresetPriority: { slow: 0 },
		};

		const preset = buildDefaultModelRolePreset(selected, [selected, auHaiku, euFable, usHaiku, usFable]);

		expect(preset.roles).toMatchObject({
			smol: "amazon-bedrock/us.anthropic.claude-haiku-4-5",
			tiny: "amazon-bedrock/us.anthropic.claude-haiku-4-5",
			slow: "amazon-bedrock/us.anthropic.claude-fable-5",
			task: "amazon-bedrock/us.anthropic.claude-fable-5",
		});
	});

	test("falls back to the selected model rather than fuzzy retired or foreign-provider matches", () => {
		const preset = buildDefaultModelRolePreset(opus, [
			opus,
			model("anthropic", "claude-3-haiku-20240307"),
			model("anthropic", "claude-haiku-4-5-custom"),
			model("other-provider", "claude-haiku-4-5"),
		]);
		expect(preset.roles.smol).toBe("anthropic/claude-opus-5");
		expect(preset.roles.tiny).toBe("anthropic/claude-opus-5");
	});

	test("preserves explicit upstream routing in selected-model fallback roles", () => {
		const base = model("openrouter", "z-ai/glm-4.7");
		const selected = {
			...base,
			compat: { ...base.compat, openRouterRouting: { only: ["fireworks"] } },
		} as Model;
		const preset = buildDefaultModelRolePreset(selected, [selected]);

		expect(preset.roles).toEqual({
			smol: "openrouter/z-ai/glm-4.7@fireworks",
			tiny: "openrouter/z-ai/glm-4.7@fireworks",
			slow: "openrouter/z-ai/glm-4.7@fireworks",
			task: "openrouter/z-ai/glm-4.7@fireworks",
			commit: "openrouter/z-ai/glm-4.7@fireworks",
			plan: "openrouter/z-ai/glm-4.7@fireworks",
			advisor: "openrouter/z-ai/glm-4.7@fireworks",
			vision: "openrouter/z-ai/glm-4.7@fireworks",
		});
	});

	test.each(["http://localhost:8000/v1", "http://127.0.0.2:8000/v1", "http://[::1]:8000/v1"])(
		"keeps all roles on a local model at %s even with same-provider curated alternatives",
		baseUrl => {
			const local = model("custom", "local-model", baseUrl);
			const preset = buildDefaultModelRolePreset(local, [
				local,
				model("custom", "claude-haiku-4-5"),
				model("custom", "claude-fable-5-1"),
			]);
			expect(preset.roles).toEqual({
				smol: "custom/local-model",
				tiny: "custom/local-model",
				slow: "custom/local-model",
				task: "custom/local-model",
				commit: "custom/local-model",
				plan: "custom/local-model",
				advisor: "custom/local-model",
				vision: "custom/local-model",
			});
		},
	);
});

describe("saved model role presets", () => {
	test("rejects reserved Default names in every case without hidden saves or lost defaults", () => {
		const original = saveModelRolePresetDefault({}, opus, qualityRoles);
		for (const name of ["default", "Default", "dEfAuLt"]) {
			expect(isModelRolePresetName(name)).toBe(false);
			expect(saveModelRolePreset(original, opus, name, cheapRoles)).toEqual(original);
			expect(setModelRolePresetDefault(original, opus, name)).toEqual(original);
			expect(deleteModelRolePreset(original, opus, name)).toEqual(original);
			expect(getModelRolePreset(original, opus, name)).toBeUndefined();
		}
		expect(getModelRolePresetNames(original, opus)).toEqual([]);
		expect(getModelRolePresetDefault(original, opus)).toEqual({ roles: qualityRoles });
	});

	test("accepts valid names and filters malformed names and stored role values", () => {
		const name = "Cheap roles_2-fast";
		// Route and effort suffixes survive capture verbatim.
		expect(
			getModelRolePreset(
				saveModelRolePreset({}, opus, name, { default: "anthropic/claude-opus-5:high@fireworks" }),
				opus,
				name,
			)?.roles.default,
		).toBe("anthropic/claude-opus-5:high@fireworks");
		expect(isModelRolePresetName(name)).toBe(true);
		const saved = saveModelRolePreset({}, opus, name, { ...cheapRoles, default: "other/model", slow: undefined });
		expect(getModelRolePreset(saved, opus, name)).toEqual({ roles: { ...cheapRoles, default: "other/model" } });
		const malformed = {
			"anthropic/claude-opus-5": {
				presets: {
					[name]: { roles: { ...cheapRoles, plan: 4, default: "other/model" } },
					"bad/name": cheapRoles,
					Default: cheapRoles,
					broken: [],
					flat: { smol: "anthropic/claude-haiku-4-5" },
				},
			},
		};
		expect(getModelRolePresetNames(malformed, opus)).toEqual([name]);
		expect(getModelRolePreset(malformed, opus, name)).toEqual({
			roles: { ...cheapRoles, default: "other/model" },
		});
		expect(getModelRolePreset(malformed, opus, "flat")).toBeUndefined();
		expect(saveModelRolePreset(saved, opus, "bad/name", qualityRoles)).toEqual(saved);
	});
	test("round-trips a user-defined role alongside the built-in roles", () => {
		// dropping it made auto-save clear the unsaved marker while the assignment
		// could never be restored by reapplying the preset.
		const roles = { ...cheapRoles, reviewer: "anthropic/claude-opus-5", default: "anthropic/claude-opus-5" };
		const named = saveModelRolePreset({}, opus, "cheap", roles);
		expect(getModelRolePreset(named, opus, "cheap")).toEqual({
			roles: {
				smol: "anthropic/claude-haiku-4-5",
				reviewer: "anthropic/claude-opus-5",
				default: "anthropic/claude-opus-5",
			},
		});
		const asDefault = saveModelRolePresetDefault(named, opus, roles);
		expect(getModelRolePresetDefault(asDefault, opus)?.roles.reviewer).toBe("anthropic/claude-opus-5");
	});

	test("updates and deletes names without mutating inputs or other models and options", () => {
		const other = model("other-provider", opus.id);
		const original = saveModelRolePreset({ autoLoad: false, applyOnSelect: true }, other, "cheap", qualityRoles);
		const cheap = saveModelRolePreset(original, opus, "cheap", cheapRoles);
		const saved = saveModelRolePreset(cheap, opus, "quality", qualityRoles);
		const updated = saveModelRolePreset(saved, opus, "cheap", { tiny: "custom/model" });
		expect(getModelRolePresetNames(original, opus)).toEqual([]);
		expect(getModelRolePresetNames(updated, opus)).toEqual(["cheap", "quality"]);
		expect(getModelRolePreset(saved, opus, "cheap")).toEqual({ roles: cheapRoles });
		expect(getModelRolePreset(updated, opus, "cheap")).toEqual({ roles: { tiny: "custom/model" } });
		const deleted = deleteModelRolePreset(updated, opus, "quality");
		expect(getModelRolePresetNames(deleted, opus)).toEqual(["cheap"]);
		expect(getModelRolePresetNames(updated, opus)).toEqual(["cheap", "quality"]);
		expect(getModelRolePreset(deleted, other, "cheap")).toEqual({ roles: qualityRoles });
		expect(deleted.autoLoad).toBe(false);
		expect(deleted.applyOnSelect).toBe(true);
	});

	test("ignores obsolete flat presets while retaining direct and named defaults in current storage", () => {
		const flat = { "anthropic/claude-opus-5": { cheap: cheapRoles, default: "cheap" } };
		expect(getModelRolePresetNames(flat, opus)).toEqual([]);
		expect(getModelRolePreset(flat, opus, "cheap")).toBeUndefined();
		expect(getModelRolePresetDefault(flat, opus)).toBeUndefined();
		expect(getModelRolePresetDefaultName(flat, opus)).toBeUndefined();
		const named = { "anthropic/claude-opus-5": { presets: { cheap: { roles: cheapRoles } }, default: "cheap" } };
		expect(getModelRolePresetDefault(named, opus)).toEqual({ roles: cheapRoles });
		expect(getModelRolePresetDefaultName(named, opus)).toBe("cheap");
		const direct = { "anthropic/claude-opus-5": { default: { roles: qualityRoles } } };
		expect(getModelRolePresetDefault(direct, opus)).toEqual({ roles: qualityRoles });
	});

	test("transitions between built-in, direct and named defaults without losing named presets or options", () => {
		const original = saveModelRolePreset({ autoLoad: false }, opus, "cheap", cheapRoles);
		expect(getModelRolePresetDefault(original, opus)).toBeUndefined();
		const direct = saveModelRolePresetDefault(original, opus, qualityRoles);
		expect(getModelRolePresetDefault(direct, opus)).toEqual({ roles: qualityRoles });
		expect(getModelRolePresetDefaultName(direct, opus)).toBeUndefined();
		const named = setModelRolePresetDefault(direct, opus, "cheap");
		expect(getModelRolePresetDefault(named, opus)).toEqual({ roles: cheapRoles });
		expect(getModelRolePresetDefaultName(named, opus)).toBe("cheap");
		expect(setModelRolePresetDefault(named, opus, "missing")).toEqual(named);
		const edited = saveModelRolePreset(named, opus, "cheap", { tiny: "custom/model" });
		expect(getModelRolePresetDefault(edited, opus)).toEqual({ roles: { tiny: "custom/model" } });
		expect(getModelRolePresetDefault(named, opus)).toEqual({ roles: cheapRoles });
		const restored = setModelRolePresetDefault(edited, opus, undefined);
		expect(getModelRolePresetDefault(restored, opus)).toBeUndefined();
		expect(getModelRolePresetDefaultName(restored, opus)).toBeUndefined();
		expect(getModelRolePresetNames(restored, opus)).toEqual(["cheap"]);
		expect(restored.autoLoad).toBe(false);
		const overwritten = saveModelRolePresetDefault(named, opus, qualityRoles);
		expect(getModelRolePresetDefaultName(overwritten, opus)).toBeUndefined();
		expect(getModelRolePresetDefault(overwritten, opus)).toEqual({ roles: qualityRoles });
		expect(resetModelRolePresetDefault(overwritten, opus)).toEqual(original);
		const empty = saveModelRolePresetDefault(named, opus, {});
		expect(getModelRolePresetDefault(empty, opus)).toEqual({ roles: {} });
		expect(getModelRolePresetDefaultName(empty, opus)).toBeUndefined();
	});

	test("deleting a named default restores built-in while unrelated deletion preserves direct defaults", () => {
		const saved = saveModelRolePreset({}, opus, "cheap", cheapRoles);
		const named = setModelRolePresetDefault(saved, opus, "cheap");
		const deleted = deleteModelRolePreset(named, opus, "cheap");
		expect(getModelRolePresetDefault(deleted, opus)).toBeUndefined();
		expect(getModelRolePresetDefaultName(deleted, opus)).toBeUndefined();
		expect(getModelRolePresetDefault(named, opus)).toEqual({ roles: cheapRoles });
		const direct = saveModelRolePresetDefault(saved, opus, qualityRoles);
		expect(getModelRolePresetDefault(deleteModelRolePreset(direct, opus, "cheap"), opus)).toEqual({
			roles: qualityRoles,
		});
		expect(deleteModelRolePreset(direct, opus, "missing")).toEqual(direct);
		expect(deleted).toEqual({});
		expect(deleteModelRolePreset(direct, opus, "cheap")).toEqual({
			"anthropic/claude-opus-5": { default: { roles: qualityRoles } },
		});
	});
});

test("resetting the last Default removes its model entry without removing other settings", () => {
	const original = {
		applyOnSelect: false,
		"anthropic/claude-opus-5": { presets: {}, default: { roles: {} } },
		"other/model": { default: { roles: cheapRoles } },
	};
	expect(resetModelRolePresetDefault(original, opus)).toEqual({
		applyOnSelect: false,
		"other/model": { default: { roles: cheapRoles } },
	});
	expect(original["anthropic/claude-opus-5"]).toEqual({ presets: {}, default: { roles: {} } });
});

describe("preset rename and fallback-chain snapshots", () => {
	const chains = {
		default: ["smoke/fa-alt:low"],
		task: ["smoke/fa-alt"],
		"smoke/*": ["smoke/fa-main:medium"],
		"smoke/fa-main": ["smoke/fa-alt:high"],
	};

	test("rename carries the payload verbatim and follows the Default pointer atomically", () => {
		const saved = saveModelRolePreset({}, opus, "cheap", cheapRoles, chains);
		const named = setModelRolePresetDefault(saved, opus, "cheap");
		const renamed = renameModelRolePreset(named, opus, "cheap", "budget");
		expect(getModelRolePresetNames(renamed, opus)).toEqual(["budget"]);
		expect(getModelRolePreset(renamed, opus, "budget")).toEqual({ roles: cheapRoles, fallbackChains: chains });
		expect(getModelRolePreset(renamed, opus, "cheap")).toBeUndefined();
		expect(getModelRolePresetDefault(renamed, opus)).toEqual({ roles: cheapRoles, fallbackChains: chains });
		expect(getModelRolePresetDefaultName(renamed, opus)).toBe("budget");
		// Invalid targets leave the input untouched: reserved, colliding, missing source.
		expect(renameModelRolePreset(renamed, opus, "budget", "default")).toEqual(renamed);
		expect(renameModelRolePreset(renamed, opus, "budget", "bad/name")).toEqual(renamed);
		expect(renameModelRolePreset(renamed, opus, "missing", "other")).toEqual(renamed);
		const colliding = saveModelRolePreset(renamed, opus, "quality", qualityRoles);
		expect(renameModelRolePreset(colliding, opus, "budget", "quality")).toEqual(colliding);
		expect(getModelRolePresetDefaultName(colliding, opus)).toBe("budget");
	});

	test("fallback-chain snapshots round-trip verbatim, including wildcards and effort suffixes", () => {
		const saved = saveModelRolePreset({}, opus, "cheap", cheapRoles, chains);
		expect(getModelRolePreset(saved, opus, "cheap")?.fallbackChains).toEqual(chains);
		const defaulted = saveModelRolePresetDefault(saved, opus, qualityRoles, chains);
		expect(getModelRolePresetDefault(defaulted, opus)?.fallbackChains).toEqual(chains);
		// Malformed chains are dropped at read time; the roles map survives.
		const malformed = {
			"anthropic/claude-opus-5": {
				presets: {
					cheap: { roles: cheapRoles, fallbackChains: { default: "not-an-array", bad: [1, "smoke/fa-alt"] } },
				},
			},
		};
		expect(getModelRolePreset(malformed, opus, "cheap")?.fallbackChains).toEqual({ bad: ["smoke/fa-alt"] });
		// Re-saving without chains replaces the snapshot with an empty explicit one.
		const cleared = saveModelRolePreset(saved, opus, "cheap", cheapRoles, {});
		expect(getModelRolePreset(cleared, opus, "cheap")?.fallbackChains).toEqual({});
	});
});
