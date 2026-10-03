import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import type { Model } from "@oh-my-pi/pi-catalog/types";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { statusLineHost } from "@oh-my-pi/pi-coding-agent/modes/status-line-host";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { setMotionEffects } from "@oh-my-pi/pi-tui/motion-effects";
import { StatusLineComponent } from "@oh-my-pi/pi-tui/status-line";
import { initTheme } from "@oh-my-pi/pi-tui/theme";

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	await initTheme();
});

afterAll(() => resetSettingsForTest());
afterEach(() => {
	setMotionEffects(true);
	vi.useRealTimers();
	vi.restoreAllMocks();
});

function fixture(): { component: StatusLineComponent; render: () => string } {
	const model: Model = getBundledModel("deepseek", "deepseek-v4-flash");
	const session = {
		state: { model, messages: [] },
		model,
		messages: [],
		systemPrompt: [],
		agent: { state: { tools: [] } },
		skills: [],
		modelRegistry: { isUsingOAuth: () => false },
		sessionManager: {
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
			getSessionName: () => undefined,
		},
		getAsyncJobSnapshot: () => ({ running: [] }),
		isFastModeActive: () => false,
		getContextUsage: () => undefined,
		contextUsageRevision: 0,
	} as unknown as AgentSession;
	const component = new StatusLineComponent(session, statusLineHost);
	component.updateSettings({ preset: "custom", leftSegments: ["pi"], rightSegments: [], sessionAccent: false });
	return { component, render: () => component.renderBottomBar(80, "full") };
}

/** The brand glyph's truecolor foreground (the fade's only output); undefined when none is set. */
function brandColor(row: string): string | undefined {
	return /\x1b\[(?:0;)?38;2;\d+;\d+;\d+m/.exec(row)?.[0];
}

describe("status line decorative motion", () => {
	it("eases the brand color over a fade timer by default, and snaps without one when motion effects are off", () => {
		vi.useFakeTimers();
		const setIntervalSpy = vi.spyOn(globalThis, "setInterval");

		// Default: the idle→working transition arms the 40 ms fade timer, and the brand color right
		// after the transition is a blend that differs from where it settles.
		const animated = fixture();
		animated.render();
		animated.component.markActivityStart();
		const midFade = brandColor(animated.render());
		expect(setIntervalSpy.mock.calls.filter(([, ms]) => ms === 40)).toHaveLength(1);
		vi.advanceTimersByTime(1000);
		animated.component.invalidate();
		const settled = brandColor(animated.render());
		expect(midFade).toBeDefined();
		expect(midFade).not.toBe(settled);
		animated.component.markActivityEnd();
		animated.component.dispose();
		setIntervalSpy.mockClear();

		// Motion effects off: the same transition arms no fade timer and the color is settled at once.
		setMotionEffects(false);
		const still = fixture();
		still.render();
		still.component.markActivityStart();
		const first = brandColor(still.render());
		expect(setIntervalSpy.mock.calls.filter(([, ms]) => ms === 40)).toHaveLength(0);
		expect(first).toBe(settled);
		still.component.dispose();
	});

	it("stops an in-flight brand fade the instant motion effects are switched off", () => {
		vi.useFakeTimers();
		const { component, render } = fixture();
		render();
		component.markActivityStart();
		const midFade = brandColor(render());
		expect(vi.getTimerCount()).toBeGreaterThan(0);

		setMotionEffects(false);
		expect(vi.getTimerCount()).toBe(0);
		const snapped = brandColor(render());
		expect(snapped).not.toBe(midFade);
		vi.advanceTimersByTime(1000);
		component.invalidate();
		expect(brandColor(render())).toBe(snapped);
		component.dispose();
	});
});
