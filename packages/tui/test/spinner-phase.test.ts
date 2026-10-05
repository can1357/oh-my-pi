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
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { VirtualTerminal } from "./virtual-terminal";

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
		vi.useFakeTimers();
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

	it("spinnerTickDelay lands every owner on the same boundary and never fires early", () => {
		expect(spinnerTickDelay(250, 0)).toBe(250);
		expect(spinnerTickDelay(250, 120)).toBe(130);
		expect(spinnerTickDelay(250, 249.2)).toBe(1);
		expect(spinnerTickDelay(250, 250)).toBe(250);
		expect(spinnerTickDelay(1000 / 30, 100)).toBe(34);
	});
});
