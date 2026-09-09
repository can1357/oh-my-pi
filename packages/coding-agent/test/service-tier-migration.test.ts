import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { getProjectAgentDir, TempDir } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "./helpers/settings-test-state";

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
