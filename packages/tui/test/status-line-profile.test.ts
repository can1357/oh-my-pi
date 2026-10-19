import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as piUtils from "@oh-my-pi/pi-utils";
import type { SegmentContext } from "../src/status-line/segments";
import { describeSegment, renderSegment } from "../src/status-line/segments";
import { initTheme, theme } from "../src/theme";

beforeAll(async () => {
	await initTheme();
});

afterEach(() => {
	vi.restoreAllMocks();
});

function createContext(overrides: Partial<SegmentContext> = {}): SegmentContext {
	return {
		session: {} as SegmentContext["session"],
		width: 120,
		compactThinkingLevel: false,
		options: {},
		planMode: null,
		loopMode: null,
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
			premiumRequests: 0,
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
		git: { branch: null, status: null, pr: null },
		usage: null,
		...overrides,
	};
}

describe("status line pi segment profile tag", () => {
	it("tags the brand with a named profile and leaves the default profile bare", () => {
		const activeProfile = vi.spyOn(piUtils, "getActiveProfile").mockReturnValue(undefined);
		expect(Bun.stripANSI(renderSegment("pi", createContext()).content)).toBe(theme.icon.omp);

		activeProfile.mockReturnValue("work");
		expect(Bun.stripANSI(renderSegment("pi", createContext()).content)).toBe(`${theme.icon.omp}-work`);
	});

	it("keeps the tag beside the spinner while a turn runs", () => {
		vi.spyOn(piUtils, "getActiveProfile").mockReturnValue("work");
		const rendered = renderSegment("pi", createContext({ now: new Date(0), turnElapsedMs: 92_000 }));
		expect(Bun.stripANSI(rendered.content)).toBe(`${theme.getSpinnerFrames("activity")[0]}-work 1m`);
	});

	it("names the profile in the native status bar", () => {
		const activeProfile = vi.spyOn(piUtils, "getActiveProfile").mockReturnValue("work");
		expect(describeSegment("pi", createContext())?.spans.map(part => part.t)).toEqual(["work"]);

		activeProfile.mockReturnValue(undefined);
		expect(describeSegment("pi", createContext())?.spans).toEqual([]);
	});

	it("drops the tag everywhere when segmentOptions.pi.showProfile is false", () => {
		vi.spyOn(piUtils, "getActiveProfile").mockReturnValue("work");
		const options = { pi: { showProfile: false } };

		expect(Bun.stripANSI(renderSegment("pi", createContext({ options })).content)).toBe(theme.icon.omp);
		const active = renderSegment("pi", createContext({ options, now: new Date(0), turnElapsedMs: 92_000 }));
		expect(Bun.stripANSI(active.content)).toBe(`${theme.getSpinnerFrames("activity")[0]} 1m`);
		expect(describeSegment("pi", createContext({ options }))?.spans).toEqual([]);
	});
});
