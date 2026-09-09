import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { StatusLineComponent } from "@oh-my-pi/pi-coding-agent/modes/components/status-line";
import { initTheme, theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { getProjectDir, setProjectDir } from "@oh-my-pi/pi-utils";

const originalProjectDir = getProjectDir();

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	await initTheme();
});

afterAll(() => {
	resetSettingsForTest();
	setProjectDir(originalProjectDir);
});

function makeSession() {
	return {
		state: { messages: [], model: undefined },
		messages: [],
		model: undefined,
		systemPrompt: [],
		agent: { state: { tools: [] } },
		skills: [],
		isStreaming: false,
		isAutoThinking: false,
		autoResolvedThinkingLevel: () => undefined,
		isFastModeActive: () => false,
		isFastModeEnabled: () => false,
		getGoalModeState: () => null,
		getAsyncJobSnapshot: () => ({ running: [] }),
		modelRegistry: { isUsingOAuth: () => false },
		sessionManager: {
			getSessionName: () => "transparent test",
			getUsageStatistics: () => ({
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				orchestrationInput: 0,
				orchestrationOutput: 0,
				orchestrationCacheRead: 0,
				premiumRequests: 0,
				cost: 0,
			}),
		},
	} as unknown as ConstructorParameters<typeof StatusLineComponent>[0];
}

function buildComponent(transparent: boolean) {
	const component = new StatusLineComponent(makeSession());
	component.updateSettings({
		preset: "custom",
		leftSegments: ["pi"],
		rightSegments: ["session_name"],
		separator: "powerline-thin",
		sessionAccent: false,
		transparent,
	});
	return component;
}

describe("status line transparent background", () => {
	it("paints the theme's statusLineBg when disabled (default)", () => {
		const themeBg = theme.getBgAnsi("statusLineBg");
		// Sanity check the test fixture: the default `dark` theme paints a real bg color,
		// otherwise the negative case below would be vacuous.
		expect(themeBg).toMatch(/\x1b\[48;/);

		const border = buildComponent(false).getTopBorder(80).content;
		expect(border).toContain(themeBg);
	});

	it("drops the theme bg fill and powerline caps when enabled", () => {
		const border = buildComponent(true).getTopBorder(80).content;
		const themeBg = theme.getBgAnsi("statusLineBg");

		// No 48; (background) ANSI escape anywhere in the rendered bar — every bg is
		// the terminal default (`\x1b[49m`).
		expect(border).not.toContain(themeBg);
		expect(border).not.toMatch(/\x1b\[48;/);
		expect(border).toContain("\x1b[49m");

		// Powerline-thin endcap glyphs are sourced from theme.sep.powerlineLeft/Right and
		// rely on the bg color as fg to visually bridge the bar; skipped under transparency.
		const leftCap = theme.sep.powerlineRight; // cap on the left side of right group
		const rightCap = theme.sep.powerlineLeft; // cap on the right side of left group
		expect(border).not.toContain(leftCap);
		expect(border).not.toContain(rightCap);
	});
});
