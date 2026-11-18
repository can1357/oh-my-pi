/**
 * Output-backpressure render gate.
 *
 * `process.stdout.write` on a TTY blocks the event loop until the terminal
 * drains, so multi-MB repaints froze the whole TUI when the emulator was slow
 * or occluded. The fix pairs an off-thread writer (pi-natives `TtyWriter`)
 * with a render gate: while `Terminal.pendingOutputBytes` exceeds the frame
 * budget, composing another frame would only queue a stale paint behind the
 * backlog.
 *
 * Contract this test defends:
 * 1. A due render against a deep backlog emits nothing and waits for a drain
 *    notification without a retry timer, preserving the pending request.
 * 2. Once the backlog drains, the next frame paints exactly the LATEST component
 *    state — frames produced mid-stall never reach the terminal.
 * 3. Terminals that do not report `pendingOutputBytes` are never gated.
 */
import { describe, expect, it } from "bun:test";
import { type RenderTimer, Text, TUI } from "@oh-my-pi/pi-tui";
import { BackloggedTerminal } from "./backlogged-terminal";
import { VirtualTerminal } from "./virtual-terminal";

class RecordingTerminal extends BackloggedTerminal {
	written: string[] = [];

	override write(data: string): void {
		this.written.push(data);
		super.write(data);
	}
}

class DeferredRenderScheduler {
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

/** Drain immediates + fire the next scheduled render timer. Returns its `delayMs`. */
function stepRender(scheduler: DeferredRenderScheduler): number | null {
	while (scheduler.immediates.length > 0) scheduler.immediates.shift()!();
	const timer = scheduler.timers.shift();
	if (!timer || timer.canceled) return null;
	scheduler.nowMs += timer.delayMs;
	timer.callback();
	return timer.delayMs;
}

describe("TUI output-backpressure render gate", () => {
	it("skips stale frames while the terminal backlog is deep and paints the latest state on drain", () => {
		const term = new RecordingTerminal(40, 6);
		const scheduler = new DeferredRenderScheduler();
		const text = new Text("initial", 0, 0);
		const tui = new TUI(term, undefined, { renderScheduler: scheduler });
		tui.addChild(text);

		try {
			tui.start();
			stepRender(scheduler);
			term.written.length = 0;

			// Deep backlog: due renders must emit nothing without a retry timer.
			term.pendingBytes = 8 * 1024 * 1024;
			text.setText("frame-A");
			tui.requestRender();
			stepRender(scheduler);
			expect(term.written).toEqual([]);
			expect(scheduler.timers).toEqual([]);
			expect(term.drainListeners.size).toBe(1);

			// Still stalled; newer state supersedes frame-A without a paint.
			text.setText("frame-B");
			tui.requestRender();
			expect(stepRender(scheduler)).toBeNull();
			expect(term.written).toEqual([]);
			expect(scheduler.timers).toEqual([]);

			// The drain event schedules exactly the latest state.
			term.pendingBytes = 0;
			while (stepRender(scheduler) !== null) {
				if (term.written.length > 0) break;
			}
			const output = term.written.join("");
			expect(output).toContain("frame-B");
			expect(output).not.toContain("frame-A");
			expect(term.drainListeners.size).toBe(0);
		} finally {
			tui.stop();
		}
	});

	it("preserves forced repaint and scrollback clearing while waiting without a timer", () => {
		const term = new RecordingTerminal(40, 6);
		const scheduler = new DeferredRenderScheduler();
		const tui = new TUI(term, undefined, { renderScheduler: scheduler });
		tui.addChild(new Text("unchanged", 0, 0));
		try {
			tui.start();
			stepRender(scheduler);
			term.written.length = 0;
			term.pendingBytes = 8 * 1024 * 1024;
			tui.requestRender();
			stepRender(scheduler);

			tui.requestRender(true, { clearScrollback: true });
			stepRender(scheduler);
			expect(term.written).toEqual([]);
			expect(scheduler.timers).toEqual([]);
			expect(term.drainListeners.size).toBe(1);

			term.pendingBytes = 0;
			stepRender(scheduler);
			expect(term.written.join("")).toContain("\x1b[3J");
			expect(term.written.join("")).toContain("unchanged");
		} finally {
			tui.stop();
		}
	});

	for (const synchronousNotification of [false, true]) {
		it(`closes the subscribe/drain race with${synchronousNotification ? "" : "out"} an initial notification`, () => {
			const term = new (class extends RecordingTerminal {
				override onOutputDrain(callback: () => void): () => void {
					// The queue emptied between the renderer's read and subscribing.
					this.pendingBytes = 0;
					const unsubscribe = super.onOutputDrain(callback);
					if (synchronousNotification) callback();
					return unsubscribe;
				}
			})(40, 6);
			const scheduler = new DeferredRenderScheduler();
			const text = new Text("initial", 0, 0);
			const tui = new TUI(term, undefined, { renderScheduler: scheduler });
			tui.addChild(text);
			try {
				tui.start();
				stepRender(scheduler);
				term.written.length = 0;
				term.pendingBytes = 8 * 1024 * 1024;
				text.setText("raced drain");
				tui.requestRender();
				stepRender(scheduler);
				expect(term.drainListeners.size).toBe(0);
				expect(scheduler.timers).toHaveLength(1);
				stepRender(scheduler);
				expect(term.written.join("")).toContain("raced drain");
			} finally {
				tui.stop();
			}
		});
	}

	it("ignores queued drain notifications from a stopped session after restart", () => {
		const term = new RecordingTerminal(40, 6);
		const scheduler = new DeferredRenderScheduler();
		const tui = new TUI(term, undefined, { renderScheduler: scheduler });
		tui.addChild(new Text("restarted", 0, 0));
		try {
			tui.start();
			stepRender(scheduler);
			term.pendingBytes = 8 * 1024 * 1024;
			tui.requestRender();
			stepRender(scheduler);
			const oldDrain = [...term.drainListeners][0]!;
			tui.stop();
			expect(term.drainListeners.size).toBe(0);
			oldDrain();
			expect(scheduler.timers).toEqual([]);

			tui.start();
			stepRender(scheduler);
			term.written.length = 0;
			const currentDrain = [...term.drainListeners][0]!;
			// Deliver the old queued event while the new session's event is pending.
			term.drainListeners.delete(currentDrain);
			term.pendingBytes = 0;
			oldDrain();
			expect(scheduler.timers).toEqual([]);
			expect(term.written).toEqual([]);
			currentDrain();
			stepRender(scheduler);
			expect(term.written.join("")).toContain("restarted");
		} finally {
			tui.stop();
		}
	});

	it("ignores a forced-render immediate queued before stop when the TUI restarts", () => {
		const term = new RecordingTerminal(40, 6);
		const scheduler = new DeferredRenderScheduler();
		const tui = new TUI(term, undefined, { renderScheduler: scheduler });
		tui.addChild(new Text("current session", 0, 0));
		try {
			tui.start();
			stepRender(scheduler);
			tui.requestRender(true);
			const oldImmediate = scheduler.immediates.shift()!;
			tui.stop();
			tui.start();
			term.written.length = 0;
			oldImmediate();
			expect(term.written).toEqual([]);
			stepRender(scheduler);
			expect(term.written.join("")).toContain("current session");
		} finally {
			tui.stop();
		}
	});

	it("never gates terminals that do not report an output backlog", () => {
		const term = new VirtualTerminal(40, 6);
		const scheduler = new DeferredRenderScheduler();
		const text = new Text("plain", 0, 0);
		const tui = new TUI(term, undefined, { renderScheduler: scheduler });
		tui.addChild(text);

		try {
			tui.start();
			stepRender(scheduler);

			text.setText("updated");
			tui.requestRender();
			stepRender(scheduler);
			expect(term.getViewport().join("\n")).toContain("updated");
		} finally {
			tui.stop();
		}
	});
});
