import { beforeAll, describe, expect, it } from "bun:test";
import type { StatusLineHost, StatusLineSession } from "../src/status-line/host";
import { describeSegment, renderSegment, type SegmentContext } from "../src/status-line/segments";
import { initTheme } from "../src/theme";
import { StatusLineComponent } from "../src/status-line/component";
import { stripVTControlCharacters } from "node:util";

beforeAll(async () => {
	await initTheme();
});

function createMockContext(isPinned?: boolean): SegmentContext {
	return {
		session: {
			state: { messages: [] },
			isFastModeEnabled: () => false,
			modelRegistry: { isUsingOAuth: () => false },
			sessionManager: {
				getSessionName: () => "My Active Session",
			},
		} as unknown as SegmentContext["session"],
		isPinned,
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
		subagentTreeCost: 0,
		activeMs: 0,
		turnElapsedMs: null,
		brandFgAnsi: "",
		git: { branch: null, status: null, pr: null },
		worktree: null,
		activeRepo: null,
		usage: null,
	};
}

describe("status line session_name pin indicator", () => {
	it("prepends 📌 when isPinned is true in render()", () => {
		const ctx = createMockContext(true);
		const result = renderSegment("session_name", ctx);
		expect(result.visible).toBe(true);
		const plain = stripVTControlCharacters(result.content);
		expect(plain).toBe("📌 My Active Session");
	});

	it("omits 📌 when isPinned is false in render()", () => {
		const ctx = createMockContext(false);
		const result = renderSegment("session_name", ctx);
		expect(result.visible).toBe(true);
		const plain = stripVTControlCharacters(result.content);
		expect(plain).toBe("My Active Session");
	});

	it("omits 📌 when isPinned is undefined in render()", () => {
		const ctx = createMockContext(undefined);
		const result = renderSegment("session_name", ctx);
		expect(result.visible).toBe(true);
		const plain = stripVTControlCharacters(result.content);
		expect(plain).toBe("My Active Session");
	});

	it("prepends 📌 when isPinned is true in describe()", () => {
		const ctx = createMockContext(true);
		const result = describeSegment("session_name", ctx);
		expect(result).not.toBeNull();
		const view = result as { spans: Array<{ t: string }> };
		expect(view.spans[0]?.t).toBe("📌 My Active Session");
	});

	it("omits 📌 when isPinned is false in describe()", () => {
		const ctx = createMockContext(false);
		const result = describeSegment("session_name", ctx);
		expect(result).not.toBeNull();
		const view = result as { spans: Array<{ t: string }> };
		expect(view.spans[0]?.t).toBe("My Active Session");
	});

	it("StatusLineComponent updates pin state via setSessionPinned", () => {
		const fakeSession = {
			state: { messages: [] },
			isFastModeEnabled: () => false,
			modelRegistry: { isUsingOAuth: () => false },
			sessionManager: {
				getSessionName: () => "Pinned Test Session",
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
			getAsyncJobSnapshot: () => ({ running: [] }),
		} as unknown as StatusLineSession;

		const host = {
			getSettings: () => ({
				preset: "minimal",
				leftSegments: ["session_name"],
				rightSegments: [],
			}),
			gitEnabled: () => false,
			codexResetFireworksEnabled: () => false,
			getSettingsRevision: () => 0,
			getSessionSettingsIdentity: () => null,
			getSessionSettingsRevision: () => 0,
			goalStatusInFooter: () => false,
			activeAccount: () => undefined,
			canFetchUsageReports: () => false,
			fetchUsageReports: () => Promise.resolve(null),
			calculateTokensPerSecond: () => null,
			limitMatchesActiveAccount: () => false,
			computeCompactionBoundaries: () => null,
			lookupPullRequest: () => Promise.resolve({ stdout: "", exitCode: 0 }),
			resolveActiveRepo: () => null,
		} as unknown as StatusLineHost<StatusLineSession>;

		const component = new StatusLineComponent(fakeSession, host);
		component.updateSettings({
			preset: "minimal",
			leftSegments: ["session_name"],
			rightSegments: [],
		});

		// Initially unpinned
		let topBorder = stripVTControlCharacters(component.getTopBorder(80).content);
		expect(topBorder).toContain("Pinned Test Session");
		expect(topBorder).not.toContain("📌");

		// Pin session
		component.setSessionPinned(true);
		topBorder = stripVTControlCharacters(component.getTopBorder(80).content);
		expect(topBorder).toContain("📌 Pinned Test Session");

		// Unpin session
		component.setSessionPinned(false);
		topBorder = stripVTControlCharacters(component.getTopBorder(80).content);
		expect(topBorder).toContain("Pinned Test Session");
		expect(topBorder).not.toContain("📌");
	});
});
