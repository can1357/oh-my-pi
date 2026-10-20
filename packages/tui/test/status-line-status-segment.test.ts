import { beforeAll, describe, expect, it } from "bun:test";
import type { SegmentContext } from "../src/status-line/segments";
import { describeSegment, renderSegment } from "../src/status-line/segments";
import { initTheme, theme } from "../src/theme";

beforeAll(async () => {
	await initTheme();
});

/** Extension statuses as a session publishes them, with the session accent
 *  disabled so the theme's own accent color is the one the segment paints. */
function createStatusContext(hookStatuses: readonly string[]): SegmentContext {
	return {
		session: {
			state: {},
			isFastModeEnabled: () => false,
			modelRegistry: { isUsingOAuth: () => false },
			sessionManager: undefined,
		} as unknown as SegmentContext["session"],
		width: 120,
		compactThinkingLevel: false,
		options: {},
		sessionAccent: false,
		hookStatuses,
		planMode: null,
		prewalk: null,
		goalMode: null,
		vibeMode: null,
		vim: null,
		collab: null,
		stream: null,
		recording: false,
		usageStats: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			orchestrationInput: 0,
			orchestrationOutput: 0,
			orchestrationCacheRead: 0,
			premiumTokens: 0,
			cost: 0,
			tokensPerSecond: null,
		},
		contextPercent: 0,
		contextTokens: 0,
		contextWindow: 0,
		autoCompactEnabled: false,
		compactionSpeculation: "idle",
		speculationBlinkOn: true,
		subagentCount: 0,
		activeMs: 0,
		turnElapsedMs: null,
		activeRepo: null,
		worktree: null,
		git: {
			branch: null,
			status: null,
			pr: null,
		},
		usage: null,
	} as unknown as SegmentContext;
}

describe("status line extension status segment", () => {
	it("paints the separator between statuses with the separator color", () => {
		const content = renderSegment("status", createStatusContext(["A !", "B ?"])).content;
		const accentAnsi = theme.getFgAnsi("accent");
		const separatorAnsi = theme.getFgAnsi("statusLineSep");
		// Without distinct foregrounds the assertions below would be vacuous.
		expect(accentAnsi).not.toBe(separatorAnsi);

		// The dot takes the separator's foreground, not the statuses' accent.
		expect(content).toContain(`${separatorAnsi}${theme.sep.dot}`);
		expect(content).not.toContain(`${accentAnsi}${theme.sep.dot}`);
		// The status text keeps the accent.
		expect(content).toContain(`${accentAnsi}A !`);
		expect(content).toContain(`${accentAnsi}B ?`);
	});

	it("describes the separator between statuses with the separator token", () => {
		const view = describeSegment("status", createStatusContext(["A !", "B ?"]));
		expect(view?.spans.map(span => span.s)).toEqual(["accent", "statusLineSep", "accent"]);
		expect(view?.spans[0]?.t).toBe("A !");
		expect(view?.spans[1]?.t).toBe(theme.sep.dot);
		expect(view?.spans[2]?.t).toBe("B ?");
	});

	it("renders a single status without a separator", () => {
		const content = renderSegment("status", createStatusContext(["A !"])).content;
		expect(content).not.toContain(theme.sep.dot);
		expect(content).toContain("A !");

		const view = describeSegment("status", createStatusContext(["A !"]));
		expect(view?.spans.map(span => span.s)).toEqual(["accent"]);
	});
});
