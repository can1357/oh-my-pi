import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { YAML } from "bun";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { resolveModelServiceTierOverride } from "@oh-my-pi/pi-coding-agent/config/model-service-tier";
import { validateServiceTierOverrides } from "@oh-my-pi/pi-coding-agent/config/service-tier";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { getProjectAgentDir, logger, TempDir } from "@oh-my-pi/pi-utils";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "./helpers/settings-test-state";

function makeModel(provider: string, id: string, api: Api = "openai-completions"): Model {
	return buildModel({
		id,
		name: id,
		api,
		provider,
		baseUrl: "https://example.test",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 4096,
	});
}

describe("resolveModelServiceTierOverride", () => {
	const gpt = makeModel("openai", "gpt-5.6");
	const gptLiteralMax = makeModel("openai", "gpt-5.6:max");
	const claude = makeModel("anthropic", "claude-opus-4-6", "anthropic-messages");
	const gemini = makeModel("google", "gemini-3-pro");
	const fireworks = makeModel("fireworks", "kimi-k3");

	it("resolves the model+effort entry over the model-only entry at that effort", () => {
		const overrides = { "openai/gpt-5.6": "flex", "openai/gpt-5.6:high": "priority" };
		expect(resolveModelServiceTierOverride(overrides, gpt, ThinkingLevel.High)).toEqual({
			matched: true,
			tier: "priority",
		});
		expect(resolveModelServiceTierOverride(overrides, gpt, ThinkingLevel.Low)).toEqual({
			matched: true,
			tier: "flex",
		});
	});

	it("binds effort-qualified keys only to the exact concrete effort", () => {
		const overrides = { "openai/gpt-5.6:high": "priority" };
		expect(resolveModelServiceTierOverride(overrides, gpt, ThinkingLevel.High)).toEqual({
			matched: true,
			tier: "priority",
		});
		expect(resolveModelServiceTierOverride(overrides, gpt, undefined)).toEqual({ matched: false });
		expect(resolveModelServiceTierOverride(overrides, gpt, "inherit")).toEqual({ matched: false });
		expect(resolveModelServiceTierOverride(overrides, gpt, "off")).toEqual({ matched: false });
		expect(resolveModelServiceTierOverride(overrides, gpt, ThinkingLevel.Low)).toEqual({ matched: false });
	});

	it("keeps literal `:max` model ids exact-first across the model/effort collision", () => {
		const overrides = { "openai/gpt-5.6:max": "flex" };
		// The literal id matches as a bare identity — the key is not split into model+effort.
		expect(resolveModelServiceTierOverride(overrides, gptLiteralMax, undefined)).toEqual({
			matched: true,
			tier: "flex",
		});
		// The bare model without a concrete max effort gets nothing from that key.
		expect(resolveModelServiceTierOverride(overrides, gpt, undefined)).toEqual({ matched: false });
		// The same string serves the effort reading when the actual identity says so.
		expect(resolveModelServiceTierOverride(overrides, gpt, ThinkingLevel.Max)).toEqual({
			matched: true,
			tier: "flex",
		});
	});

	it("matched none shadows the family tier as an explicit off", () => {
		expect(resolveModelServiceTierOverride({ "openai/gpt-5.6": "none" }, gpt, ThinkingLevel.High)).toEqual({
			matched: true,
			tier: undefined,
		});
	});

	it("gates entries on what the resolved model's family realizes", () => {
		const overrides = { "anthropic/claude-opus-4-6": "flex", "google/gemini-3-pro": "priority" };
		// Anthropic realizes only priority, so the flex entry is inert — not an explicit off.
		expect(resolveModelServiceTierOverride(overrides, claude, ThinkingLevel.High)).toEqual({ matched: false });
		expect(
			resolveModelServiceTierOverride({ "anthropic/claude-opus-4-6": "priority" }, claude, ThinkingLevel.High),
		).toEqual({
			matched: true,
			tier: "priority",
		});
		expect(resolveModelServiceTierOverride(overrides, gemini, ThinkingLevel.High)).toEqual({
			matched: true,
			tier: "priority",
		});
	});

	it("falls through a capability-invalid effort entry to a valid base entry", () => {
		const overrides = { "anthropic/claude-opus-4-6": "none", "anthropic/claude-opus-4-6:high": "flex" };
		expect(resolveModelServiceTierOverride(overrides, claude, ThinkingLevel.High)).toEqual({
			matched: true,
			tier: undefined,
		});
	});

	it("never matches models outside every tier family, preserving Fireworks' dedicated control", () => {
		expect(
			resolveModelServiceTierOverride({ "fireworks/kimi-k3": "priority" }, fireworks, ThinkingLevel.High),
		).toEqual({
			matched: false,
		});
	});
});

describe("tier.modelOverrides validation", () => {
	it("accepts exact keys and returns entries unchanged", () => {
		const overrides = {
			"openai/gpt-5.6": "priority",
			"openrouter/deepseek/deepseek-v3:free": "none",
		};
		expect(validateServiceTierOverrides(overrides)).toEqual(overrides);
	});

	it("ignores non-record input gracefully", () => {
		for (const value of [undefined, null, "openai/gpt-5.6", 42, ["openai/gpt-5.6"]]) {
			expect(validateServiceTierOverrides(value)).toEqual({});
		}
	});
});

describe("tier.modelOverrides settings surface", () => {
	let settingsState: SettingsTestState | undefined;
	let tempDir: TempDir;
	let agentDir: string;
	let projectDir: string;

	beforeEach(() => {
		settingsState = beginSettingsTest();
		tempDir = TempDir.createSync("@test-model-service-tier-");
		agentDir = path.join(tempDir.path(), "agent");
		projectDir = path.join(tempDir.path(), "project");
		fs.mkdirSync(agentDir, { recursive: true });
		fs.mkdirSync(getProjectAgentDir(projectDir), { recursive: true });
	});

	afterEach(async () => {
		AgentStorage.close();
		restoreSettingsTestState(settingsState);
		settingsState = undefined;
		try {
			await tempDir.remove();
		} catch {}
	});

	async function loadWith(raw: Record<string, unknown>): Promise<Settings> {
		await Bun.write(path.join(agentDir, "config.yml"), YAML.stringify(raw, null, 2));
		resetSettingsForTest();
		return Settings.init({ cwd: projectDir, agentDir });
	}

	it("loads a well-formed map and serves it to consumers", async () => {
		const overrides = { "openai/gpt-5.6": "priority", "openai/gpt-5.6:high": "flex" };
		const settings = await loadWith({ tier: { modelOverrides: overrides } });
		expect(settings.get("tier.modelOverrides")).toEqual(overrides);
	});

	it("normalizes null model overrides at load, set, and persisted boundaries", async () => {
		const settings = await loadWith({ tier: { modelOverrides: null } });
		expect(settings.get("tier.modelOverrides")).toEqual({});

		settings.set("tier.modelOverrides", null as unknown as Record<string, string>);
		expect(settings.get("tier.modelOverrides")).toEqual({});
		await settings.flush();

		const persisted = YAML.parse(await Bun.file(path.join(agentDir, "config.yml")).text()) as {
			tier?: { modelOverrides?: unknown };
		};
		expect(persisted.tier?.modelOverrides).toEqual({});

		const isolated = Settings.isolated({ "tier.modelOverrides": null });
		expect(isolated.get("tier.modelOverrides")).toEqual({});
	});

	it("loads valid entries, drops malformed entries, and preserves the source file", async () => {
		const raw = {
			tier: {
				modelOverrides: {
					"openai/gpt-5.6": "priority",
					"openrouter/deepseek/deepseek-v3:free": "none",
					"openai/gpt-5.6:high": "banana",
					"openai/*": "flex",
				},
			},
		};
		const source = YAML.stringify(raw, null, 2);
		await Bun.write(path.join(agentDir, "config.yml"), source);
		const warning = vi.spyOn(logger, "warn").mockImplementation(() => {});
		resetSettingsForTest();
		const settings = await Settings.init({ cwd: projectDir, agentDir });

		expect(settings.get("tier.modelOverrides")).toEqual({
			"openai/gpt-5.6": "priority",
			"openrouter/deepseek/deepseek-v3:free": "none",
		});
		const warningCall = warning.mock.calls.find(
			([message]) => message === "Settings: ignoring invalid tier.modelOverrides entries",
		);
		expect(warningCall).toBeDefined();
		expect(warningCall?.[1]).toEqual({
			entries: expect.arrayContaining([
				"openai/gpt-5.6:high (value must be one of: none, auto, default, flex, scale, priority)",
				'openai/* (key must be an exact "provider/model" or "provider/model:effort")',
			]),
		});
		expect(await Bun.file(path.join(agentDir, "config.yml")).text()).toBe(source);
	});

	it("normalizes a valid dotted model-overrides root", async () => {
		const settings = await loadWith({ "tier.modelOverrides": { "openai/gpt-5.6": "priority" } });
		expect(settings.get("tier.modelOverrides")).toEqual({ "openai/gpt-5.6": "priority" });
	});

	it("rejects invalid sets without corrupting the current or persisted map", async () => {
		const valid = { "openai/gpt-5.6": "priority" };
		const settings = await loadWith({ tier: { modelOverrides: valid } });

		expect(settings.get("tier.modelOverrides")).toEqual(valid);
		expect(() => settings.set("tier.modelOverrides", { ...valid, "openai/gpt-5.6:high": "banana" })).toThrow(
			/tier\.modelOverrides/,
		);
		expect(settings.get("tier.modelOverrides")).toEqual(valid);
		expect(() => settings.set("tier.modelOverrides", { ...valid, "openai/*": "priority" })).toThrow(
			/tier\.modelOverrides/,
		);
		expect(settings.get("tier.modelOverrides")).toEqual(valid);
		expect(() => settings.override("tier.modelOverrides", { ...valid, "openai/*": "priority" })).toThrow(
			/tier\.modelOverrides/,
		);
		expect(settings.get("tier.modelOverrides")).toEqual(valid);

		await settings.flush();
		resetSettingsForTest();
		const reloaded = await Settings.init({ cwd: projectDir, agentDir });
		expect(reloaded.get("tier.modelOverrides")).toEqual(valid);
	});
});
