import { describe, expect, it } from "bun:test";
import { Settings } from "../../src/config/settings";
import { handleTierSlashCommand } from "../../src/slash-commands/helpers/tier";
import type { SlashCommandRuntime } from "../../src/slash-commands/types";

describe("/tier slash command", () => {
	it("shows default tier status when set to auto", async () => {
		const outputs: string[] = [];
		const settings = Settings.isolated();
		const runtime = {
			cwd: process.cwd(),
			settings,
			output: async (text: string) => {
				outputs.push(text);
			},
		} as unknown as SlashCommandRuntime;

		await handleTierSlashCommand("", runtime);
		expect(outputs[0]).toContain("Default spawned-agent tier: AUTO");
		expect(outputs[0]).toContain("Effective default envelope: frontier");
	});

	it("updates tier setting to light, mid, frontier, and auto", async () => {
		const outputs: string[] = [];
		const settings = Settings.isolated();
		const runtime = {
			cwd: process.cwd(),
			settings,
			output: async (text: string) => {
				outputs.push(text);
			},
		} as unknown as SlashCommandRuntime;

		await handleTierSlashCommand("light", runtime);
		expect(settings.get("agent.tier")).toBe("light");
		expect(outputs[0]).toContain('Default spawned-agent tier set to "light"');

		outputs.length = 0;
		await handleTierSlashCommand("mid", runtime);
		expect(settings.get("agent.tier")).toBe("mid");
		expect(outputs[0]).toContain('Default spawned-agent tier set to "mid"');

		outputs.length = 0;
		await handleTierSlashCommand("frontier", runtime);
		expect(settings.get("agent.tier")).toBe("frontier");
		expect(outputs[0]).toContain('Default spawned-agent tier set to "frontier"');

		outputs.length = 0;
		await handleTierSlashCommand("auto", runtime);
		expect(settings.get("agent.tier")).toBe("auto");
		expect(outputs[0]).toContain('Default spawned-agent tier reset to "auto"');
	});

	it("keeps the interactive tier as a restrictive floor over a stronger agent policy", async () => {
		const outputs: string[] = [];
		const settings = Settings.isolated();
		settings.set("task.agentPolicies", { task: { tier: "frontier" } });
		const runtime = {
			cwd: process.cwd(),
			settings,
			output: async (text: string) => {
				outputs.push(text);
			},
		} as unknown as SlashCommandRuntime;

		await handleTierSlashCommand("light", runtime);
		expect(settings.resolveAgentPolicy("Reviewer", "task")?.tier).toBe("light");

		outputs.length = 0;
		await handleTierSlashCommand("status", runtime);
		expect(outputs[0]).toContain("Effective default envelope: light");
		expect(outputs[0]).toContain("Existing child sessions keep their immutable execution profile");
	});
});
