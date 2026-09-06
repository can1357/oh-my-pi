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
 * 1. A due render against a deep backlog emits nothing and re-arms a retry
 *    instead, preserving the pending request.
 * 2. Once the backlog drains, the retry paints exactly the LATEST component
 *    state — frames produced mid-stall never reach the terminal.
 * 3. Terminals that do not report `pendingOutputBytes` are never gated.
 */
import { describe, expect, it } from "bun:test";
import { type RenderTimer, Text, TUI } from "@oh-my-pi/pi-tui";
import { VirtualTerminal } from "./virtual-terminal";

class BackloggedTerminal extends VirtualTerminal {
	pendingBytes = 0;
	written: string[] = [];

	get pendingOutputBytes(): number {
		return this.pendingBytes;
	}

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
		const term = new BackloggedTerminal(40, 6);
		const scheduler = new DeferredRenderScheduler();
		const text = new Text("initial", 0, 0);
		const tui = new TUI(term, undefined, { renderScheduler: scheduler });
		tui.addChild(text);

		try {
			tui.start();
			stepRender(scheduler);
			term.written.length = 0;

			// Deep backlog: due renders must emit nothing and re-arm a retry.
			term.pendingBytes = 8 * 1024 * 1024;
			text.setText("frame-A");
			tui.requestRender();
			stepRender(scheduler);
			expect(term.written).toEqual([]);
			expect(scheduler.timers.length).toBeGreaterThan(0);

			// Still stalled; newer state supersedes frame-A without a paint.
			text.setText("frame-B");
			tui.requestRender();
			stepRender(scheduler);
			expect(term.written).toEqual([]);

			// Backlog drained: the retry paints exactly the latest state.
			term.pendingBytes = 0;
			while (stepRender(scheduler) !== null) {
				if (term.written.length > 0) break;
			}
			const output = term.written.join("");
			expect(output).toContain("frame-B");
			expect(output).not.toContain("frame-A");
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
