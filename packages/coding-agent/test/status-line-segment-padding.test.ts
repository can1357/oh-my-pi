/**
 * Contract: status-line segments render unpadded and the group renderer owns
 * all inter-segment spacing, so every separator gap is a single space. The `pi`
 * brand segment used to carry a trailing space inside its own span, which
 * stacked with the separator's leading space into a 2-space gap at the first
 * separator while every later gap stayed single (#11103).
 *
 * The plain layouts (bottom bar, top-rule chip) honor the configured
 * `statusLine.separator` instead of a hardcoded dot (#19084).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { StatusLineComponent } from "@oh-my-pi/pi-tui/status-line";
import { statusLineHost } from "@oh-my-pi/pi-coding-agent/modes/status-line-host";
import { initTheme, theme } from "@oh-my-pi/pi-tui/theme";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";

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

function fakeSession(): AgentSession {
	const model = { id: "test-model", name: "Test Model", contextWindow: 200_000 };
	const messages = [{ role: "user", content: "hi" }];
	return {
		messages,
		systemPrompt: [],
		agent: { state: { tools: [] } },
		skills: [],
		model,
		modelRegistry: { isUsingSubscription: () => false },
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
		isAutoThinking: false,
		autoResolvedThinkingLevel: () => undefined,
		getContextUsage: () => ({ tokens: 1_000, contextWindow: 200_000, percent: 0.5 }),
		contextUsageRevision: 0,
	} as unknown as AgentSession;
}

/** `pi` + `model` bottom bar (plain separators) through the real pipeline. */
function makeComponent(): StatusLineComponent {
	const component = new StatusLineComponent(fakeSession(), statusLineHost);
	component.updateSettings({
		preset: "custom",
		leftSegments: ["pi", "model"],
		rightSegments: [],
		separator: "powerline-thin",
		sessionAccent: false,
	});
	return component;
}

/** Bottom bar plus top-rule chip with two segments per side, for separator coverage. */
function makeSeparatorComponent(separator: "none" | "slash"): StatusLineComponent {
	const component = new StatusLineComponent(fakeSession(), statusLineHost);
	component.updateSettings({
		preset: "custom",
		leftSegments: ["pi", "model"],
		rightSegments: ["hostname", "time"],
		separator,
		sessionAccent: false,
	});
	return component;
}

/** Spaces immediately flanking the first configured-separator glyph in the stripped bar. */
function firstSeparatorGap(bar: string): { before: number; after: number } {
	const plain = bar.replace(/\x1b\[[0-9;]*m/g, "");
	const sep = theme.sep.powerlineThinLeft;
	const dot = plain.indexOf(sep);
	if (dot < 0) throw new Error(`no separator in bar: ${JSON.stringify(plain)}`);
	const before = plain.slice(0, dot).match(/ *$/)?.[0].length ?? 0;
	const after = plain.slice(dot + sep.length).match(/^ */)?.[0].length ?? 0;
	return { before, after };
}

describe("status line segment padding", () => {
	it("keeps a single-space gap at the first separator while a turn runs", () => {
		const now = 1_000_000;
		vi.spyOn(Date, "now").mockImplementation(() => now);
		const component = makeComponent();
		try {
			component.markActivityStart();
			const bar = component.renderBottomBar(80, "full");
			expect(firstSeparatorGap(bar)).toEqual({ before: 1, after: 1 });
		} finally {
			component.dispose();
		}
	});

	it("keeps a single-space gap at the first separator when idle", () => {
		const component = makeComponent();
		try {
			const bar = component.renderBottomBar(80, "full");
			expect(firstSeparatorGap(bar)).toEqual({ before: 1, after: 1 });
		} finally {
			component.dispose();
		}
	});

	it("honors the configured separator in the plain bottom bar and top-rule chip", () => {
		// Regression for #19084: the plain layouts hardcoded the `·` dot, so
		// `statusLine.separator: none` never reached the bottom bar or chip.
		const none = makeSeparatorComponent("none");
		try {
			const bar = Bun.stripANSI(none.renderBottomBar(120, "full"));
			expect(bar).not.toContain("\u00b7");
			const chip = Bun.stripANSI(none.getStandaloneTopBorder(120).content);
			expect(chip).not.toContain("\u00b7");
		} finally {
			none.dispose();
		}

		const slash = makeSeparatorComponent("slash");
		try {
			const bar = Bun.stripANSI(slash.renderBottomBar(120, "full"));
			expect(bar).toContain(` ${theme.sep.slash.trim()} `);
			expect(bar).not.toContain("\u00b7");
			const chip = Bun.stripANSI(slash.getStandaloneTopBorder(120).content);
			expect(chip).toContain(` ${theme.sep.slash.trim()} `);
			expect(chip).not.toContain("\u00b7");
		} finally {
			slash.dispose();
		}
	});
});
