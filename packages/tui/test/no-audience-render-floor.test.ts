/**
 * No-audience render floor.
 *
 * A detached tmux pane keeps draining everything written to it, so nothing in
 * the render path slows down when the last client leaves: a session parked on
 * a model call kept writing ~30 animation frames a second into a pane no
 * client was reading.
 *
 * Contract this test defends, measured the way the cost is: animation frames
 * delivered to the terminal over a fixed window.
 * 1. A terminal that reports no audience receives roughly one frame a second
 *    instead of the ~30 it receives with one.
 * 2. A terminal that reports an audience is unchanged.
 * 3. A terminal that cannot tell (`undefined`, which is every plain terminal,
 *    ssh pty, ACP and RPC host) is unchanged — the floor applies only to an
 *    established empty audience, never to an unknown one.
 * 4. A forced render still paints immediately with no audience, so a user
 *    action is never held behind the floor.
 * 5. A floor already armed does not outlive the state that set it: when the
 *    audience question re-opens — the keystroke a re-attached client types —
 *    the frame owed to that keystroke is re-armed for the ordinary cadence
 *    instead of serving out the second it was given.
 */
import { describe, expect, it } from "bun:test";
import { type RenderTimer, Text, TUI } from "@oh-my-pi/pi-tui";
import { VirtualTerminal } from "./virtual-terminal";

class AudienceTerminal extends VirtualTerminal {
	audience: boolean | undefined;
	readonly frames: string[] = [];

	constructor(audience: boolean | undefined) {
		super(60, 8);
		this.audience = audience;
	}

	get hasAudience(): boolean | undefined {
		return this.audience;
	}

	override write(data: string): void {
		this.frames.push(data);
		super.write(data);
	}
}

class VirtualClockScheduler {
	nowMs = 0;
	readonly immediates: Array<() => void> = [];
	readonly timers: Array<{ callback: () => void; canceled: boolean; delayMs: number }> = [];

	now(): number {
		return this.nowMs;
	}

	scheduleImmediate(callback: () => void): void {
		this.immediates.push(callback);
	}

	scheduleRender(callback: () => void, delayMs: number): RenderTimer {
		const timer = { callback, canceled: false, delayMs };
		this.timers.push(timer);
		return {
			cancel: () => {
				timer.canceled = true;
			},
		};
	}
}

/** Drain immediates, then fire the next live render timer and advance the clock by its delay. */
function stepRender(scheduler: VirtualClockScheduler): boolean {
	while (scheduler.immediates.length > 0) scheduler.immediates.shift()!();
	const timer = scheduler.timers.shift();
	if (!timer) return false;
	if (timer.canceled) return true;
	scheduler.nowMs += timer.delayMs;
	timer.callback();
	return true;
}

/**
 * Run an 80 ms-cadence animation (the loader's own tick) for `windowMs` of
 * virtual time and return how many frames reached the terminal.
 */
function framesOverWindow(audience: boolean | undefined, windowMs: number): number {
	const term = new AudienceTerminal(audience);
	const scheduler = new VirtualClockScheduler();
	const text = new Text("tick 0", 0, 0);
	const tui = new TUI(term, undefined, { renderScheduler: scheduler });
	tui.addChild(text);
	try {
		tui.start();
		while (stepRender(scheduler)) {
			// drain the startup paint
		}
		term.frames.length = 0;

		let tick = 0;
		while (scheduler.nowMs < windowMs) {
			text.setText(`tick ${++tick}`);
			tui.requestRender();
			if (!stepRender(scheduler)) break;
		}
		return term.frames.length;
	} finally {
		tui.stop();
	}
}

describe("TUI no-audience render floor", () => {
	it("drops an unwatched terminal to about a frame a second and leaves a watched one at full rate", () => {
		const windowMs = 4_000;
		const unwatched = framesOverWindow(false, windowMs);
		const watched = framesOverWindow(true, windowMs);

		// ~1 fps vs the 30 fps cadence ceiling.
		expect(unwatched).toBeLessThanOrEqual(6);
		expect(watched).toBeGreaterThanOrEqual(60);
		expect(watched / Math.max(1, unwatched)).toBeGreaterThan(10);
	});

	it("keeps the full rate when the terminal cannot establish who is watching", () => {
		const windowMs = 4_000;
		expect(framesOverWindow(undefined, windowMs)).toBeGreaterThanOrEqual(60);
	});

	it("paints a forced render immediately even with no audience", () => {
		const term = new AudienceTerminal(false);
		const scheduler = new VirtualClockScheduler();
		const text = new Text("before", 0, 0);
		const tui = new TUI(term, undefined, { renderScheduler: scheduler });
		tui.addChild(text);
		try {
			tui.start();
			while (stepRender(scheduler)) {
				// drain the startup paint
			}
			term.frames.length = 0;

			text.setText("after-force");
			tui.requestRender(true);
			while (scheduler.immediates.length > 0) scheduler.immediates.shift()!();

			expect(scheduler.nowMs).toBe(0);
			expect(term.frames.join("")).toContain("after-force");
		} finally {
			tui.stop();
		}
	});

	it("paints the keystroke that re-opens the audience question instead of waiting out the armed floor", () => {
		const term = new AudienceTerminal(false);
		const scheduler = new VirtualClockScheduler();
		const text = new Text("before", 0, 0);
		const tui = new TUI(term, undefined, { renderScheduler: scheduler });
		tui.addChild(text);
		try {
			tui.start();
			while (stepRender(scheduler)) {
				// drain the startup paint
			}
			term.frames.length = 0;

			// An animation frame arms the one-second no-audience delay while the
			// pane is still detached.
			text.setText("animating");
			tui.requestRender();
			while (scheduler.immediates.length > 0) scheduler.immediates.shift()!();

			// A client attaches without changing the pane's shape and types.
			// ProcessTerminal re-opens the audience question on the keystroke
			// (`hasAudience` goes back to `undefined`), and the focused component
			// asks for the ordinary repaint that shows the character.
			term.audience = undefined;
			text.setText("typed");
			tui.requestRender();

			const startedAtMs = scheduler.nowMs;
			for (let step = 0; step < 10 && !term.frames.join("").includes("typed"); step++) {
				if (!stepRender(scheduler)) break;
			}

			expect(term.frames.join("")).toContain("typed");
			// One ordinary frame interval, not the second the detached pane was
			// held to: the delay already on the clock must be re-armed, not kept.
			expect(scheduler.nowMs - startedAtMs).toBeLessThanOrEqual(Math.ceil(1000 / 30));
		} finally {
			tui.stop();
		}
	});
});
