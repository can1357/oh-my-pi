import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { setNativeRendering } from "../src/native/state";
import { DEFAULT_SPINNER_INTERVAL_MS, SPINNER_INTERVAL_STATIC, setSpinnerInterval } from "../src/spinner-clock";
import { StatusLineComponent } from "../src/status-line/component";
import type { StatusLineHost, StatusLineSession } from "../src/status-line/host";
import type { StatusLineSettings } from "../src/status-line/types";
import { initTheme } from "../src/theme";

function createSession(isStreaming = false) {
	return {
		sessionFile: undefined,
		isStreaming,
		state: { model: undefined, messages: [] },
		isFastModeActive: () => false,
		getAsyncJobSnapshot: () => ({ running: [] }),
	} as unknown as StatusLineSession;
}

function createHost(settings?: StatusLineSettings) {
	return {
		getSettings: () => settings ?? {},
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
}

function createComponent(settings?: StatusLineSettings) {
	const component = new StatusLineComponent(createSession(), createHost(settings));
	const repaint = vi.fn();
	component.watchBranch(repaint);
	return { component, repaint };
}

/**
 * Contract: while a turn's active-processing window is open, the status line
 * repaints itself on its own timer. The `pi` segment's spinner and turn timer
 * are painted from the wall clock, so without this ticker any path that stops
 * the working-row loader mid-turn (error banner, stale retry/compaction
 * loader reference) froze the animation until the next keystroke.
 */
describe("status line active-window repaint ticker", () => {
	beforeEach(() => {
		// Ticks land on the shared spinner clock's boundaries, a whole number of spinner frames
		// apart. A 250 ms spinner makes the period the safety net itself, so the lifecycle
		// tests below count in plain 250 ms steps; the cadence contract has its own tests.
		setSpinnerInterval(250);
	});
	afterEach(() => {
		vi.useRealTimers();
		setNativeRendering(false);
		setSpinnerInterval(DEFAULT_SPINNER_INTERVAL_MS);
	});
	beforeAll(async () => {
		await initTheme();
	});

	it("repaints on its own cadence while a turn window is open, with no loader running", () => {
		vi.useFakeTimers({ now: 0 });
		const { component, repaint } = createComponent();

		component.markActivityStart();
		vi.advanceTimersByTime(250);
		expect(repaint.mock.calls.length).toBe(1);
		vi.advanceTimersByTime(1000);
		expect(repaint.mock.calls.length).toBe(5);

		component.markActivityEnd();
		vi.advanceTimersByTime(2000);
		expect(repaint.mock.calls.length).toBe(5);

		component.dispose();
	});

	it("stays silent while idle, re-arms for the next turn, and stops on dispose", () => {
		vi.useFakeTimers({ now: 0 });
		const { component, repaint } = createComponent();

		vi.advanceTimersByTime(1000);
		expect(repaint.mock.calls.length).toBe(0);

		component.markActivityStart();
		vi.advanceTimersByTime(250);
		expect(repaint.mock.calls.length).toBe(1);

		component.markActivityEnd();
		component.markActivityStart();
		vi.advanceTimersByTime(500);
		expect(repaint.mock.calls.length).toBe(3);

		component.dispose();
		vi.advanceTimersByTime(1000);
		expect(repaint.mock.calls.length).toBe(3);
	});

	it("re-arms when focus returns to a session whose turn is still running", () => {
		vi.useFakeTimers({ now: 0 });
		const main = createSession(true);
		const component = new StatusLineComponent(main, createHost());
		const repaint = vi.fn();
		component.watchBranch(repaint);

		component.markActivityStart();
		vi.advanceTimersByTime(250);
		expect(repaint.mock.calls.length).toBe(1);

		// Focus an idle subagent: its tick sees no open window and the
		// ticker stops itself.
		component.setSession(createSession());
		vi.advanceTimersByTime(2000);
		expect(repaint.mock.calls.length).toBe(1);

		// Refocus the still-running main session: its window never closed,
		// so the synthesized agent_start is a no-op — the ticker must
		// re-arm on its own.
		component.setSession(main);
		vi.advanceTimersByTime(2000);
		expect(repaint.mock.calls.length).toBe(9);

		component.dispose();
	});

	it("re-arms when a native surface that suppressed the ticker is revoked mid-turn", () => {
		vi.useFakeTimers({ now: 0 });
		const { component, repaint } = createComponent();

		// The turn starts while a TSP surface renders the status area, so
		// arm attempts stand down.
		setNativeRendering(true);
		component.markActivityStart();
		vi.advanceTimersByTime(2000);
		expect(repaint.mock.calls.length).toBe(0);

		// The surface is revoked and rendering falls back to rows without
		// any activity transition; the still-open window must resume.
		setNativeRendering(false);
		vi.advanceTimersByTime(250);
		expect(repaint.mock.calls.length).toBe(1);

		component.dispose();
	});

	it("follows the spinner clock: a slower or static spinner stops the 4 Hz wakeups", () => {
		vi.useFakeTimers({ now: 0 });
		const { component, repaint } = createComponent();

		// A spinner slower than the safety net sets the pace.
		setSpinnerInterval(500);
		component.markActivityStart();
		vi.advanceTimersByTime(1000);
		expect(repaint.mock.calls.length).toBe(2);

		// Static spinners (`tui.motion: none`): the armed tick lands at t=1500, then only the one-second
		// turn timer moves (2000, 3000, 4000).
		setSpinnerInterval(SPINNER_INTERVAL_STATIC);
		repaint.mockClear();
		vi.advanceTimersByTime(3000);
		expect(repaint.mock.calls.length).toBe(4);

		component.dispose();
		vi.advanceTimersByTime(2000);
		expect(repaint.mock.calls.length).toBe(4);
		setSpinnerInterval(DEFAULT_SPINNER_INTERVAL_MS);
	});

	it("ticks a whole number of spinner frames apart, on the clock's boundaries, whenever the turn started", () => {
		vi.useFakeTimers({ now: 0 });
		const { component, repaint } = createComponent();

		// Default 80 ms spinner: the safety net rounds up to 320 ms. A turn opened at t=120 ticks at
		// 320, 640, 960 and 1280 — never at 370, 620, … from its own start.
		setSpinnerInterval(DEFAULT_SPINNER_INTERVAL_MS);
		vi.advanceTimersByTime(120);
		component.markActivityStart();
		vi.advanceTimersByTime(199);
		expect(repaint.mock.calls.length).toBe(0);
		vi.advanceTimersByTime(1);
		expect(repaint.mock.calls.length).toBe(1);
		vi.advanceTimersByTime(960);
		expect(repaint.mock.calls.length).toBe(4);

		// A 100 ms spinner: three frames per tick (300 ms), realigned live — from t=1280 the next
		// boundaries are 1500, 1800 and 2100.
		setSpinnerInterval(100);
		repaint.mockClear();
		vi.advanceTimersByTime(1000);
		expect(repaint.mock.calls.length).toBe(3);

		component.dispose();
	});
});
