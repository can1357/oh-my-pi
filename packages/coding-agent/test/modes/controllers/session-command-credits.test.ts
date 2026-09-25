import { beforeAll, describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { CommandController } from "@oh-my-pi/pi-coding-agent/modes/controllers/command-controller";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import type { SessionStats } from "@oh-my-pi/pi-coding-agent/session/agent-session-types";
import { getThemeByName, setThemeInstance } from "@oh-my-pi/pi-tui/theme";

const baseStats: SessionStats = {
	sessionFile: undefined,
	sessionId: "test",
	userMessages: 0,
	assistantMessages: 1,
	toolCalls: 0,
	toolResults: 0,
	totalMessages: 1,
	tokens: { input: 1, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 2 },
	premiumRequests: 0,
	cost: 0,
	aiu: 0,
};

async function renderSessionCredits(stats: SessionStats): Promise<string> {
	let output = "";
	const ctx = {
		session: { getSessionStats: () => stats, model: undefined },
		settings: Settings.isolated(),
		showSessionInfo: (text: string) => {
			output = text;
		},
	} as unknown as InteractiveModeContext;
	await new CommandController(ctx).handleSessionCommand();
	return stripVTControlCharacters(output);
}

describe("/session credit display", () => {
	beforeAll(async () => {
		const dark = await getThemeByName("dark");
		if (!dark) throw new Error("Expected dark theme");
		setThemeInstance(dark);
	});

	it("shows Copilot AIU and premium requests without zeroed credit-cost meters", async () => {
		const output = await renderSessionCredits({
			...baseStats,
			premiumRequests: 2,
			aiu: 1.7114,
		});
		expect(output).toContain("Premium Requests: 2");
		expect(output).toContain("\nAIU\nTotal: 1.7114");
		expect(output).not.toContain("Credits:");
		expect(output).not.toContain("Committed ACU:");
	});

	it("shows AIU independently when there is no dollar or credit cost", async () => {
		const output = await renderSessionCredits({ ...baseStats, aiu: 0.44 });
		expect(output).toContain("\nAIU\nTotal: 0.44");
		expect(output).not.toContain("\nCost\n");
	});
});
