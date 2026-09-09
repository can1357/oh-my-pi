/**
 * Contract: status-line segments render unpadded and the group renderer owns
 * all inter-segment spacing, so every separator gap is a single space. The `pi`
 * brand segment used to carry a trailing space inside its own span, which
 * stacked with the separator's leading space into a 2-space gap at the first
 * separator while every later gap stayed single (#11103).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { StatusLineComponent } from "@oh-my-pi/pi-coding-agent/modes/components/status-line";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
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
		isAutoThinking: false,
		autoResolvedThinkingLevel: () => undefined,
		getContextUsage: () => ({ tokens: 1_000, contextWindow: 200_000, percent: 0.5 }),
		contextUsageRevision: 0,
	} as unknown as AgentSession;
}

/** `pi` + `model` bottom bar (plain dot separators) through the real pipeline. */
function makeComponent(): StatusLineComponent {
	const component = new StatusLineComponent(fakeSession());
	component.updateSettings({
		preset: "custom",
		leftSegments: ["pi", "model"],
		rightSegments: [],
		separator: "powerline-thin",
		sessionAccent: false,
	});
	return component;
}

/** Spaces immediately flanking the first `·` separator in the stripped bar. */
function firstSeparatorGap(bar: string): { before: number; after: number } {
	const plain = bar.replace(/\x1b\[[0-9;]*m/g, "");
	const dot = plain.indexOf("·");
	if (dot < 0) throw new Error(`no separator in bar: ${JSON.stringify(plain)}`);
	const before = plain.slice(0, dot).match(/ *$/)?.[0].length ?? 0;
	const after = plain.slice(dot + 1).match(/^ */)?.[0].length ?? 0;
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
});
