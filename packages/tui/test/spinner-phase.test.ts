import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { type RenderScheduler, TUI } from "@oh-my-pi/pi-tui";
import { stopSharedSpinnerTicker, ToolExecutionComponent } from "@oh-my-pi/pi-tui/chat/tool-execution";
import { Loader } from "@oh-my-pi/pi-tui/components/loader";
import {
	DEFAULT_SPINNER_INTERVAL_MS,
	setSpinnerInterval,
	sharedSpinnerFrame,
	spinnerTickDelay,
} from "@oh-my-pi/pi-tui/spinner-clock";
import { StatusLineComponent } from "@oh-my-pi/pi-tui/status-line/component";
import type { StatusLineHost, StatusLineSession } from "@oh-my-pi/pi-tui/status-line/host";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { VirtualTerminal } from "./virtual-terminal";

/** A status line with an open turn window and nothing else to draw. */
function createStatusLine(): StatusLineComponent {
	const session = {
		sessionFile: undefined,
		isStreaming: false,
		state: { model: undefined, messages: [] },
		isFastModeActive: () => false,
		getAsyncJobSnapshot: () => ({ running: [] }),
	} as unknown as StatusLineSession;
	const host = {
		getSettings: () => ({}),
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
	return new StatusLineComponent(session, host);
}

/** The default scheduler on fake timers: `setImmediate` is not faked, a zero timeout is. */
const scheduler: RenderScheduler = {
	now: () => performance.now(),
	scheduleImmediate: callback => {
		setTimeout(callback, 0);
	},
	scheduleRender: (callback, delayMs) => {
		const timer = setTimeout(callback, delayMs);
		return { cancel: () => clearTimeout(timer) };
	},
};

describe("spinner owners share one clock", () => {
	beforeAll(async () => {
		await initTheme();
	});
	beforeEach(() => {
		stopSharedSpinnerTicker();
	});
	afterEach(() => {
		setSpinnerInterval(DEFAULT_SPINNER_INTERVAL_MS);
		vi.useRealTimers();
	});

	it("a working row and a live tool card started out of phase repaint once per period, not once each", () => {
		// Each owner used to tick on its own start time: two spinners 120 ms apart woke the renderer
		// twice per period — 8 frames/s at a 250 ms cadence — and showed different glyphs.
		vi.useFakeTimers({ now: 0 });
		setSpinnerInterval(250);
		const term = new VirtualTerminal(80, 12);
		let paints = 0;
		const tui = new TUI(term, undefined, { onPaint: () => paints++, renderScheduler: scheduler });
		const identity = (t: string) => t;
		const row = new Loader(tui, identity, identity, "Working");
		tui.addChild(row);
		tui.start();
		vi.advanceTimersByTime(120);
		const card = new ToolExecutionComponent(
			"eval",
			{ language: "py", code: "import time\ntime.sleep(10)" },
			{},
			undefined,
			tui,
			process.cwd(),
		);
		tui.addChild(card);
		try {
			// Let the start-up paints settle on a boundary, then count whole periods.
			vi.advanceTimersByTime(380);
			paints = 0;
			vi.advanceTimersByTime(4_000);
			expect(paints).toBe(16);
			// Both owners show the clock's glyph, not a phase of their own.
			const frame = sharedSpinnerFrame(10);
			expect(row.debugState().frame).toBe(frame);
		} finally {
			card.stopAnimation();
			row.stop();
			tui.stop();
		}
	});

	it("the status line's turn-window ticker rides the working row's ticks instead of adding its own", () => {
		// The status line repaints on its own timer while a turn is open (a safety net for paths
		// that stop the loader mid-turn). Armed from its own start, it was a second out-of-phase
		// 250 ms owner under `--motion reduced` — 8 frames/s again — and under the default 80 ms
		// cadence it added four paints a second between the row's own.
		vi.useFakeTimers({ now: 0 });
		const countPaintsPerFourSeconds = (spinnerMs: number): number => {
			setSpinnerInterval(spinnerMs);
			const term = new VirtualTerminal(80, 12);
			let paints = 0;
			const tui = new TUI(term, undefined, { onPaint: () => paints++, renderScheduler: scheduler });
			const identity = (t: string) => t;
			const row = new Loader(tui, identity, identity, "Working");
			const statusLine = createStatusLine();
			statusLine.watchBranch(() => tui.requestRender());
			tui.addChild(row);
			tui.start();
			vi.advanceTimersByTime(120);
			statusLine.markActivityStart();
			try {
				vi.advanceTimersByTime(380);
				paints = 0;
				vi.advanceTimersByTime(4_000);
				return paints;
			} finally {
				statusLine.dispose();
				row.stop();
				tui.stop();
			}
		};
		// `reduced`: one frame per 250 ms period, not two.
		expect(countPaintsPerFourSeconds(250)).toBe(16);
		// Default: the row's 50 frames and nothing on top.
		expect(countPaintsPerFourSeconds(DEFAULT_SPINNER_INTERVAL_MS)).toBe(50);
	});

	it("spinnerTickDelay lands every owner on the same boundary and never fires early", () => {
		expect(spinnerTickDelay(250, 0)).toBe(250);
		expect(spinnerTickDelay(250, 120)).toBe(130);
		expect(spinnerTickDelay(250, 249.2)).toBe(1);
		expect(spinnerTickDelay(250, 250)).toBe(250);
		expect(spinnerTickDelay(1000 / 30, 100)).toBe(34);
	});
});
