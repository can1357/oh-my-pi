import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { setNativeRendering } from "../src/native/state";
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
	afterEach(() => {
		vi.useRealTimers();
		setNativeRendering(false);
	});
	beforeAll(async () => {
		await initTheme();
	});

	it("repaints on its own cadence while a turn window is open, with no loader running", () => {
		vi.useFakeTimers();
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
		vi.useFakeTimers();
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
		vi.useFakeTimers();
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
		vi.useFakeTimers();
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
});
