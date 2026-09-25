import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ServiceTierByFamily } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import {
	resolveAgentServiceTierOverride,
	validateAgentServiceTierOverrides,
} from "@oh-my-pi/pi-coding-agent/config/service-tier";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { getProjectAgentDir, TempDir } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "./helpers/settings-test-state";

function requiredBundledModel(provider: "openai-codex" | "anthropic" | "google", id: string) {
	const model = getBundledModel(provider, id);
	if (!model) throw new Error(`Expected bundled model ${provider}/${id}`);
	return model;
}

const openAIModel = requiredBundledModel("openai-codex", "gpt-5.6-sol");
const anthropicModel = requiredBundledModel("anthropic", "claude-sonnet-4-5");
const googleModel = requiredBundledModel("google", "gemini-2.5-flash");

// Locks the back-compat migration of the legacy single `serviceTier` enum (with
// scoped `openai-only`/`claude-only` sentinels) plus `serviceTierSubagent`/
// `serviceTierAdvisor`/`fastModeScope` into the per-family `tier.*` settings.
describe("serviceTier → tier.* settings migration", () => {
	let settingsState: SettingsTestState | undefined;
	let tempDir: TempDir;
	let agentDir: string;
	let projectDir: string;

	beforeEach(() => {
		settingsState = beginSettingsTest();
		tempDir = TempDir.createSync("@test-service-tier-migration-");
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

	it("expands unscoped priority to every family", async () => {
		const settings = await loadWith({ serviceTier: "priority" });
		expect(settings.get("tier.openai")).toBe("priority");
		expect(settings.get("tier.anthropic")).toBe("priority");
		expect(settings.get("tier.google")).toBe("priority");
	});

	it("scopes openai-only/claude-only to a single family", async () => {
		const openai = await loadWith({ serviceTier: "openai-only" });
		expect(openai.get("tier.openai")).toBe("priority");
		expect(openai.get("tier.anthropic")).toBe("none");
		expect(openai.get("tier.google")).toBe("none");

		const claude = await loadWith({ serviceTier: "claude-only" });
		expect(claude.get("tier.anthropic")).toBe("priority");
		expect(claude.get("tier.openai")).toBe("none");
	});

	it("maps plain OpenAI tiers onto the OpenAI family", async () => {
		const settings = await loadWith({ serviceTier: "flex" });
		expect(settings.get("tier.openai")).toBe("flex");
		expect(settings.get("tier.anthropic")).toBe("none");
	});

	it("carries subagent/advisor over and drops scoped sentinels", async () => {
		const settings = await loadWith({
			serviceTierSubagent: "claude-only",
			serviceTierAdvisor: "flex",
		});
		expect(settings.get("tier.subagent")).toBe("priority"); // claude-only → priority
		expect(settings.get("tier.advisor")).toBe("flex");
	});

	it("leaves a fresh config on the per-family defaults", async () => {
		const settings = await loadWith({});
		expect(settings.get("tier.openai")).toBe("none");
		expect(settings.get("tier.subagent")).toBe("inherit");
		expect(settings.get("tier.advisor")).toBe("none");
	});
});

describe("task.agentServiceTierOverrides", () => {
	it("resolves every documented setting for the OpenAI family", () => {
		const parentTiers: ServiceTierByFamily = { openai: "priority", anthropic: "priority", google: "flex" };

		expect(resolveAgentServiceTierOverride("inherit", openAIModel, parentTiers)).toEqual(parentTiers);
		expect(resolveAgentServiceTierOverride("none", openAIModel, parentTiers)).toEqual({});
		expect(resolveAgentServiceTierOverride("auto", openAIModel, parentTiers)).toEqual({ openai: "auto" });
		expect(resolveAgentServiceTierOverride("default", openAIModel, parentTiers)).toEqual({ openai: "default" });
		expect(resolveAgentServiceTierOverride("flex", openAIModel, parentTiers)).toEqual({ openai: "flex" });
		expect(resolveAgentServiceTierOverride("scale", openAIModel, parentTiers)).toEqual({ openai: "scale" });
		expect(resolveAgentServiceTierOverride("priority", openAIModel, parentTiers)).toEqual({ openai: "priority" });
	});

	it("rejects values outside the documented service-tier set during settings load", async () => {
		await expect(
			Settings.loadIsolated({
				inMemory: true,
				overrides: { "task.agentServiceTierOverrides": { scout: "turbo" } },
			}),
		).rejects.toThrow(
			"Invalid service tier for task.agentServiceTierOverrides.scout: turbo. Expected one of: inherit, none, auto, default, flex, scale, priority.",
		);
	});

	it("rejects a scalar or array container during settings load instead of disabling every override", async () => {
		await expect(
			Settings.loadIsolated({
				inMemory: true,
				overrides: { "task.agentServiceTierOverrides": "priority" },
			}),
		).rejects.toThrow(
			"Invalid task.agentServiceTierOverrides: expected a map of agent name to service tier, got a string.",
		);
		expect(() => validateAgentServiceTierOverrides([{ scout: "priority" }])).toThrow(
			"Invalid task.agentServiceTierOverrides: expected a map of agent name to service tier, got an array.",
		);
		// An empty YAML mapping (`agentServiceTierOverrides:`) is `null`, not a typo.
		expect(validateAgentServiceTierOverrides(null)).toEqual({});
	});

	it("applies concrete values only when the effective model family supports them", () => {
		const inherited: ServiceTierByFamily = { openai: "priority", anthropic: "priority", google: "flex" };
		expect(resolveAgentServiceTierOverride("priority", anthropicModel, inherited)).toEqual({
			anthropic: "priority",
		});
		expect(resolveAgentServiceTierOverride("flex", googleModel, inherited)).toEqual({ google: "flex" });
		expect(resolveAgentServiceTierOverride("scale", anthropicModel, inherited)).toEqual({});
		expect(resolveAgentServiceTierOverride("default", googleModel, inherited)).toEqual({});
	});

	it("never broadcasts a concrete value across families when no model resolved", () => {
		const inherited: ServiceTierByFamily = { openai: "flex" };
		expect(resolveAgentServiceTierOverride("priority", undefined, inherited)).toEqual({});
		expect(resolveAgentServiceTierOverride("scale", undefined, inherited)).toEqual({});
		expect(resolveAgentServiceTierOverride("none", undefined, inherited)).toEqual({});
		expect(resolveAgentServiceTierOverride("inherit", undefined, inherited)).toEqual(inherited);
	});
});
