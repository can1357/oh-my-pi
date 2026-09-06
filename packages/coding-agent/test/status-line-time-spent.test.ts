/**
 * Regression for #3681: the `time_spent` status segment used to display
 * `Date.now() - sessionStartTime`, i.e. wall-clock since session start, so a
 * session that sat idle for hours still reported hours of "time spent".
 *
 * Contract:
 * - The segment reads `SegmentContext.activeMs` only — wall-clock never
 *   leaks in.
 * - `StatusLineComponent` accumulates `agent_start`→`agent_end` windows;
 *   reentrant starts and unmatched ends never double-count.
 * - `resetActiveTime` resets both the accumulator and any in-flight
 *   window so `/clear` and fresh-session flows zero the meter.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { StatusLineComponent } from "@oh-my-pi/pi-coding-agent/modes/components/status-line";
import type { SegmentContext } from "@oh-my-pi/pi-coding-agent/modes/components/status-line/segments";
import { renderSegment } from "@oh-my-pi/pi-coding-agent/modes/components/status-line/segments";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";

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

function createCtx(activeMs: number): SegmentContext {
	return {
		// The segment under test never touches `session`; stub it.
		session: {} as unknown as SegmentContext["session"],
		width: 120,
		compactThinkingLevel: false,
		options: {},
		planMode: null,
		loopMode: null,
		prewalk: null,
		goalMode: null,
		vibeMode: null,
		collab: null,
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
		activeMs,
		turnElapsedMs: null,
		activeRepo: null,
		worktree: null,
		git: { branch: null, status: null, pr: null },
		usage: null,
	};
}

function makeSession(
	overrides: { isStreaming?: boolean; sessionFile?: string | undefined } = {},
): ConstructorParameters<typeof StatusLineComponent>[0] {
	// The component reads the session for usage stats, model, the
	// `isStreaming` gate inside `#closeStaleActiveWindow`, and the
	// `sessionFile` snapshot inside `#meter()` (file-change detection).
	// The time-spent accounting path otherwise never touches it — stub
	// with the minimum surface the constructor needs to settle.
	return {
		state: { messages: [], model: undefined },
		messages: [],
		systemPrompt: [],
		agent: { state: { tools: [] } },
		skills: [],
		isStreaming: overrides.isStreaming ?? false,
		isAutoThinking: false,
		autoResolvedThinkingLevel: () => undefined,
		isFastModeActive: () => false,
		isFastModeEnabled: () => false,
		getGoalModeState: () => null,
		getAsyncJobSnapshot: () => ({ running: [] }),
		modelRegistry: { isUsingOAuth: () => false },
		sessionFile: overrides.sessionFile,
		sessionManager: {
			getSessionName: () => "time-spent test",
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

describe("time_spent segment", () => {
	it("renders active processing time and ignores wall-clock", () => {
		const rendered = renderSegment("time_spent", createCtx(10_000));
		expect(rendered.visible).toBe(true);
		expect(rendered.content).toContain("10");
		expect(rendered.content).toContain("s");
	});

	it("hides under one second of activity so the segment does not flash 0s at session start", () => {
		expect(renderSegment("time_spent", createCtx(0)).visible).toBe(false);
		expect(renderSegment("time_spent", createCtx(999)).visible).toBe(false);
		expect(renderSegment("time_spent", createCtx(1000)).visible).toBe(true);
	});

	it("scales beyond seconds: formatDuration produces minute/hour suffixes", () => {
		const fiveMin = renderSegment("time_spent", createCtx(5 * 60_000));
		expect(fiveMin.content).toContain("5m");
		const twoHours = renderSegment("time_spent", createCtx(2 * 3_600_000));
		expect(twoHours.content).toContain("2h");
	});
});

describe("StatusLineComponent active-time accounting", () => {
	it("accumulates only across markActivityStart/markActivityEnd windows, not idle time", () => {
		const c = new StatusLineComponent(makeSession());
		let now = 1_000_000_000;
		vi.spyOn(Date, "now").mockImplementation(() => now);

		// Idle: nothing accrues even as wall-clock advances.
		now += 10_000;
		expect(c.getActiveMs()).toBe(0);

		// First turn: 3s.
		now += 10_000;
		c.markActivityStart();
		now += 3_000;
		c.markActivityEnd();
		expect(c.getActiveMs()).toBe(3_000);

		// Long idle gap (5 minutes) — total stays at 3s.
		now += 300_000;
		expect(c.getActiveMs()).toBe(3_000);

		// Second turn: 2s. Total = 5s.
		c.markActivityStart();
		now += 2_000;
		c.markActivityEnd();
		expect(c.getActiveMs()).toBe(5_000);
	});

	it("ticks live during an open window so the segment animates while the agent runs", () => {
		const c = new StatusLineComponent(makeSession());
		let now = 2_000_000_000;
		vi.spyOn(Date, "now").mockImplementation(() => now);

		c.markActivityStart();
		now += 1_500;
		expect(c.getActiveMs()).toBe(1_500);
		now += 2_700;
		expect(c.getActiveMs()).toBe(4_200);
	});

	it("is idempotent: reentrant markActivityStart and unmatched markActivityEnd never double-count", () => {
		const c = new StatusLineComponent(makeSession());
		let now = 3_000_000_000;
		vi.spyOn(Date, "now").mockImplementation(() => now);

		// Unmatched end while idle is a no-op.
		c.markActivityEnd();
		expect(c.getActiveMs()).toBe(0);

		c.markActivityStart();
		// A second start while already running must not reset the anchor.
		now += 5_000;
		c.markActivityStart();
		now += 2_000;
		c.markActivityEnd();
		expect(c.getActiveMs()).toBe(7_000);

		// Closing again is a no-op.
		now += 92_000;
		c.markActivityEnd();
		expect(c.getActiveMs()).toBe(7_000);
	});

	it("resetActiveTime resets the active accumulator for /clear and fresh-session flows", () => {
		const c = new StatusLineComponent(makeSession());
		let now = 4_000_000_000;
		vi.spyOn(Date, "now").mockImplementation(() => now);

		c.markActivityStart();
		now += 10_000;
		c.markActivityEnd();
		expect(c.getActiveMs()).toBe(10_000);

		c.resetActiveTime();
		expect(c.getActiveMs()).toBe(0);

		// Starting after reset begins from zero, not the prior total.
		now += 2_000;
		c.markActivityStart();
		now += 1_500;
		c.markActivityEnd();
		expect(c.getActiveMs()).toBe(1_500);
	});

	it("resetActiveTime also drops an in-flight window so /clear during a turn starts fresh", () => {
		const c = new StatusLineComponent(makeSession());
		let now = 5_000_000_000;
		vi.spyOn(Date, "now").mockImplementation(() => now);

		c.markActivityStart();
		now += 4_000;
		expect(c.getActiveMs()).toBe(4_000);

		c.resetActiveTime();
		expect(c.getActiveMs()).toBe(0);

		// A stale markActivityEnd after the reset must not re-credit the dropped window.
		now += 5_000;
		c.markActivityEnd();
		expect(c.getActiveMs()).toBe(0);
	});

	it("tracks meters per session: subagent agent_start opened while focused never ticks into the main meter on detach", () => {
		// Regression for the PR review: SessionFocusController synthesizes
		// `agent_start` on mid-turn attach but unfocusing immediately
		// unsubscribes without a matching synthetic `agent_end`. With a
		// single shared meter the main status line kept ticking through
		// idle time after the subagent later finished. Per-session WeakMap
		// keeps the leak inside the subagent's meter.
		const main = makeSession({ isStreaming: false });
		const sub = makeSession({ isStreaming: true });
		const c = new StatusLineComponent(main);
		let now = 6_000_000_000;
		vi.spyOn(Date, "now").mockImplementation(() => now);

		// 1s of main activity, closed cleanly.
		c.markActivityStart();
		now += 1_000;
		c.markActivityEnd();
		expect(c.getActiveMs()).toBe(1_000);

		// Focus into a streaming subagent: synthesized agent_start opens
		// the subagent's meter only.
		c.setSession(sub, "Subagent");
		c.markActivityStart();
		now += 3_000;
		expect(c.getActiveMs()).toBe(3_000);

		// Detach back to main while subagent is still running — the
		// subagent meter stays open but the main meter is untouched.
		c.setSession(main);
		expect(c.getActiveMs()).toBe(1_000);
		// Wall-clock keeps advancing; main meter must not tick.
		now += 60_000;
		expect(c.getActiveMs()).toBe(1_000);
	});

	it("drops a stale subagent window on re-focus when the agent finished while we were detached", () => {
		// SessionFocusController only synthesizes agent_start when the
		// session is currently streaming. Re-focusing a now-idle session
		// whose previous meter is still open would otherwise tick over
		// the entire detached gap; the setSession close-stale path drops
		// it instead.
		const main = makeSession({ isStreaming: false });
		const sub = makeSession({ isStreaming: true });
		const c = new StatusLineComponent(main);
		let now = 7_000_000_000;
		vi.spyOn(Date, "now").mockImplementation(() => now);

		c.setSession(sub, "Subagent");
		c.markActivityStart();
		now += 2_000;
		// Detach mid-turn — subagent meter left open.
		c.setSession(main);

		// Long detached gap. The subagent finishes in reality during this
		// gap, but we never see its agent_end because we're unsubscribed.
		now += 600_000;

		// Re-focus the (now idle) subagent. The stale window is dropped
		// rather than crediting the detached gap.
		(sub as unknown as { isStreaming: boolean }).isStreaming = false;
		c.setSession(sub, "Subagent");
		expect(c.getActiveMs()).toBe(0);
	});

	it("resets the meter when AgentSession.switchSession swaps the loaded session file under the same ref", () => {
		// Regression for the PR review: /resume, /move, ACP fork/load,
		// RPC switch_session, and extension switchSession all mutate
		// `sessionManager`'s loaded file in place under the same
		// AgentSession ref, so a WeakMap keyed only on the session ref
		// would carry the previous conversation's meter into the
		// resumed one.
		const session = makeSession({ sessionFile: "/tmp/conv-a.jsonl" });
		const c = new StatusLineComponent(session);
		let now = 8_000_000_000;
		vi.spyOn(Date, "now").mockImplementation(() => now);

		c.markActivityStart();
		now += 30_000;
		c.markActivityEnd();
		expect(c.getActiveMs()).toBe(30_000);

		// Simulate `session.switchSession("/tmp/conv-b.jsonl")` mutating
		// the file in place. The next meter read sees a real-to-real
		// transition and starts fresh.
		(session as unknown as { sessionFile: string }).sessionFile = "/tmp/conv-b.jsonl";
		expect(c.getActiveMs()).toBe(0);

		// Activity in the resumed conversation accrues from zero, not
		// from the previous conversation's 30s.
		c.markActivityStart();
		now += 2_000;
		c.markActivityEnd();
		expect(c.getActiveMs()).toBe(2_000);
	});

	it("does not reset the meter on a first-save transition (sessionFile undefined → real)", () => {
		// A brand-new session starts without a loaded file path; the
		// first autosave sets one. That transition is the same
		// conversation, so accumulated active time MUST survive.
		const session = makeSession({ sessionFile: undefined });
		const c = new StatusLineComponent(session);
		let now = 9_000_000_000;
		vi.spyOn(Date, "now").mockImplementation(() => now);

		c.markActivityStart();
		now += 5_000;
		c.markActivityEnd();
		expect(c.getActiveMs()).toBe(5_000);

		// First save assigns a session file path. Same conversation —
		// the meter must NOT reset.
		(session as unknown as { sessionFile: string }).sessionFile = "/tmp/new-session.jsonl";
		expect(c.getActiveMs()).toBe(5_000);
	});
});
