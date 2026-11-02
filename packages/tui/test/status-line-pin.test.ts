import { beforeAll, describe, expect, it } from "bun:test";
import type { StatusLineHost, StatusLineSession } from "../src/status-line/host";
import { describeSegment, renderSegment, type SegmentContext } from "../src/status-line/segments";
import { initTheme, theme } from "../src/theme";
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
	it("prepends theme.icon.pin when isPinned is true in render()", () => {
		const ctx = createMockContext(true);
		const result = renderSegment("session_name", ctx);
		expect(result.visible).toBe(true);
		const plain = stripVTControlCharacters(result.content);
		expect(plain).toBe(`${theme.icon.pin} My Active Session`);
	});

	it("omits pin icon when isPinned is false in render()", () => {
		const ctx = createMockContext(false);
		const result = renderSegment("session_name", ctx);
		expect(result.visible).toBe(true);
		const plain = stripVTControlCharacters(result.content);
		expect(plain).toBe("My Active Session");
	});

	it("prepends theme.icon.pin when isPinned is true in describe()", () => {
		const ctx = createMockContext(true);
		const result = describeSegment("session_name", ctx);
		expect(result).not.toBeNull();
		const view = result as { spans: Array<{ t: string }> };
		expect(view.spans[0]?.t).toBe(`${theme.icon.pin} My Active Session`);
	});

	it("omits pin icon when isPinned is false in describe()", () => {
		const ctx = createMockContext(false);
		const result = describeSegment("session_name", ctx);
		expect(result).not.toBeNull();
		const view = result as { spans: Array<{ t: string }> };
		expect(view.spans[0]?.t).toBe("My Active Session");
	});

	it("StatusLineComponent updates pin state via setSessionPinned and setPinnedSessionIds", () => {
		const fakeSession = {
			state: { messages: [] },
			isFastModeEnabled: () => false,
			modelRegistry: { isUsingOAuth: () => false },
			sessionManager: {
				getSessionId: () => "sess-1",
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
		expect(topBorder).not.toContain(theme.icon.pin);

		// Pin session
		component.setSessionPinned("sess-1", true);
		topBorder = stripVTControlCharacters(component.getTopBorder(80).content);
		expect(topBorder).toContain(`${theme.icon.pin} Pinned Test Session`);

		// Unpin session
		component.setSessionPinned("sess-1", false);
		topBorder = stripVTControlCharacters(component.getTopBorder(80).content);
		expect(topBorder).toContain("Pinned Test Session");
		expect(topBorder).not.toContain(theme.icon.pin);

		// Bulk set
		component.setPinnedSessionIds(["sess-1"]);
		topBorder = stripVTControlCharacters(component.getTopBorder(80).content);
		expect(topBorder).toContain(`${theme.icon.pin} Pinned Test Session`);
	});

	it("preserves pinned state across subagent focus proxy switches without cross-session bleed", () => {
		const mainSession = {
			state: { messages: [] },
			isFastModeEnabled: () => false,
			modelRegistry: { isUsingOAuth: () => false },
			sessionManager: {
				getSessionId: () => "main-session-id",
				getSessionName: () => "Main Session Title",
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

		const subagentSession = {
			state: { messages: [] },
			isFastModeEnabled: () => false,
			modelRegistry: { isUsingOAuth: () => false },
			sessionManager: {
				getSessionId: () => "subagent-session-id",
				getSessionName: () => "Subagent Worker",
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

		const component = new StatusLineComponent(mainSession, host);
		component.updateSettings({
			preset: "minimal",
			leftSegments: ["session_name"],
			rightSegments: [],
		});

		// 1. Pin the main session
		component.setSessionPinned("main-session-id", true);
		let border = stripVTControlCharacters(component.getTopBorder(80).content);
		expect(border).toContain(`${theme.icon.pin} Main Session Title`);

		// 2. Focus subagent (setSession called on attach)
		component.setSession(subagentSession, "worker-agent");
		border = stripVTControlCharacters(component.getTopBorder(80).content);
		expect(border).toContain("Subagent Worker");
		expect(border).not.toContain(theme.icon.pin);

		// 3. Return to main session (setSession called on detach)
		component.setSession(mainSession, undefined);
		border = stripVTControlCharacters(component.getTopBorder(80).content);
		expect(border).toContain(`${theme.icon.pin} Main Session Title`);
	});
});
