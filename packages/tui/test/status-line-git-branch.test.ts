import { beforeAll, describe, expect, it } from "bun:test";
import type { SegmentContext } from "../src/status-line/segments";
import { renderSegment } from "../src/status-line/segments";
import { initTheme } from "../src/theme";

const LONG_BRANCH = "feature/1234-add-configurable-archive-memory-budget";

function createGitContext(branch: string | null, maxLength?: number): SegmentContext {
	return {
		session: {
			state: {},
			isFastModeEnabled: () => false,
			modelRegistry: { isUsingOAuth: () => false },
			sessionManager: undefined,
		} as unknown as SegmentContext["session"],
		width: 120,
		compactThinkingLevel: false,
		options: {
			git: { maxLength },
		},
		planMode: null,
		loopMode: null,
		prewalk: null,
		goalMode: null,
		vibeMode: null,
		vim: null,
		collab: null,
		stream: null,
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
		git: {
			branch,
			status: null,
			pr: null,
		},
		usage: null,
	} as unknown as SegmentContext;
}

describe("status line git branch maxLength (issue #10617)", () => {
	beforeAll(async () => {
		await initTheme();
	});

	it("shows the full branch name without a limit", () => {
		const rendered = renderSegment("git", createGitContext(LONG_BRANCH));
		expect(rendered.visible).toBe(true);
		expect(Bun.stripANSI(rendered.content)).toContain(LONG_BRANCH);
	});

	it("truncates the branch with an ellipsis at maxLength", () => {
		const rendered = renderSegment("git", createGitContext(LONG_BRANCH, 20));
		const text = Bun.stripANSI(rendered.content);
		expect(rendered.visible).toBe(true);
		expect(text).toContain("…");
		expect(text.length).toBeLessThan(LONG_BRANCH.length);
		expect(text).toContain(LONG_BRANCH.slice(0, 10));
	});
});
