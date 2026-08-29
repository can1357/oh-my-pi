/**
 * Contract for the `pi` brand segment's working transition (port of rust
 * omp's status-band brand fade): idle renders the omp icon in the dim color;
 * a turn start swaps the glyph to a spinner + turn timer whose foreground
 * fades dim → accent over 450ms (never an instant color swap), and a turn end
 * fades back from the color currently on screen. Regression: the first cut of
 * the working brand swapped colors instantly with no tween.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { StatusLineComponent } from "@oh-my-pi/pi-coding-agent/modes/components/status-line";
import { initTheme, theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { getSessionAccentAnsi } from "@oh-my-pi/pi-coding-agent/utils/session-color";

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	await initTheme();
});

afterAll(() => {
	resetSettingsForTest();
});

afterEach(() => {
	vi.restoreAllMocks();
});

/** Minimal session double satisfying every query the bottom-bar render makes. */
function fakeSession(): AgentSession {
	const model = { id: "test-model", contextWindow: 200_000 };
	const messages = [{ role: "user", content: "hi" }];
	return {
		messages,
		systemPrompt: [],
		agent: { state: { tools: [] } },
		skills: [],
		model,
		modelRegistry: { isUsingOAuth: () => false },
		state: { messages, model },
		settings: undefined,
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
		getContextUsage: () => ({ tokens: 1_000, contextWindow: 200_000, percent: 0.5 }),
		contextUsageRevision: 0,
	} as unknown as AgentSession;
}

/** Brand-only bottom bar through the real segment pipeline. */
function makeComponent(): StatusLineComponent {
	const component = new StatusLineComponent(fakeSession());
	component.updateSettings({
		preset: "custom",
		leftSegments: ["pi"],
		rightSegments: [],
		separator: "powerline-thin",
		sessionAccent: false,
	});
	return component;
}

describe("status line brand fade", () => {
	it("fades the brand from dim into the accent when a turn starts", () => {
		let now = 1_000_000;
		vi.spyOn(Date, "now").mockImplementation(() => now);
		const dimAnsi = getSessionAccentAnsi(theme.getColorHex("dim"));
		const accentAnsi = getSessionAccentAnsi(theme.getColorHex("accent"));
		if (!dimAnsi || !accentAnsi) throw new Error("expected resolvable dim/accent theme colors");
		const component = makeComponent();
		try {
			// Idle: omp icon settled in the dim color.
			expect(component.renderBottomBar(80, "full")).toContain(`${dimAnsi}${theme.icon.omp} `);

			// Turn start: the glyph becomes a spinner + whole-second timer at
			// once, but the color starts from the on-screen dim — no instant swap.
			component.markActivityStart();
			now += 10;
			const early = component.renderBottomBar(80, "full");
			expect(early).toContain(" 0s ");
			expect(early).not.toContain(theme.icon.omp);
			expect(early).toContain(dimAnsi);
			expect(early).not.toContain(accentAnsi);

			// Mid-fade (225ms of 450ms): a blend that is neither endpoint.
			now += 215;
			const mid = component.renderBottomBar(80, "full");
			expect(mid).not.toContain(dimAnsi);
			expect(mid).not.toContain(accentAnsi);

			// Past the 450ms fade: settled on the accent.
			now += 300;
			expect(component.renderBottomBar(80, "full")).toContain(accentAnsi);
		} finally {
			component.dispose();
		}
	});

	it("fades back to dim from the on-screen accent when the turn ends", () => {
		let now = 2_000_000;
		vi.spyOn(Date, "now").mockImplementation(() => now);
		const dimAnsi = getSessionAccentAnsi(theme.getColorHex("dim"));
		const accentAnsi = getSessionAccentAnsi(theme.getColorHex("accent"));
		if (!dimAnsi || !accentAnsi) throw new Error("expected resolvable dim/accent theme colors");
		const component = makeComponent();
		try {
			component.markActivityStart();
			// The fade arms on the first render observing the edge.
			component.renderBottomBar(80, "full");
			now += 500; // settle the fade-in
			expect(component.renderBottomBar(80, "full")).toContain(accentAnsi);

			// Turn end: the icon returns immediately, the color resumes from the
			// accent currently on screen instead of jumping to dim.
			component.markActivityEnd();
			now += 10;
			const ending = component.renderBottomBar(80, "full");
			expect(ending).toContain(theme.icon.omp);
			expect(ending).toContain(accentAnsi);

			now += 215;
			const mid = component.renderBottomBar(80, "full");
			expect(mid).not.toContain(dimAnsi);
			expect(mid).not.toContain(accentAnsi);

			now += 300;
			expect(component.renderBottomBar(80, "full")).toContain(`${dimAnsi}${theme.icon.omp} `);
		} finally {
			component.dispose();
		}
	});
});
