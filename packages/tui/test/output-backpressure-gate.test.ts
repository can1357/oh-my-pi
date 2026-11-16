/**
 * Output-backpressure render gate.
 *
 * A slow or occluded terminal leaves output queued. While the terminal's
 * `pendingOutputBytes` exceeds the frame budget, composing another frame would
 * only queue a stale paint behind the backlog, so the engine parks the frame
 * until the output stream reports a drain.
 *
 * Contract this test defends:
 * 1. A due render against a deep backlog emits nothing and waits for a drain
 *    notification without a retry timer, preserving the pending request.
 * 2. Once the backlog drains, the next frame paints exactly the LATEST component
 *    state — frames produced mid-stall never reach the terminal.
 * 3. Terminals whose output never backs up are never gated.
 */
import { describe, expect, it } from "bun:test";
import { Text, TUI } from "@oh-my-pi/pi-tui";
import { ManualScheduler } from "./helpers/manual-scheduler";
import { VirtualTerminal } from "./virtual-terminal";

const DEEP_BACKLOG = 8 * 1024 * 1024;
/** Long enough for any due frame (the frame cadence is ~33 ms). */
const FRAME_MS = 100;

/** Records what reaches the emulator; `afterReceive` runs once the bytes landed. */
class RecordingTerminal extends VirtualTerminal {
	readonly written: string[] = [];
	afterReceive: (() => void) | undefined;

	override receive(data: string): void {
		this.written.push(data);
		super.receive(data);
		this.afterReceive?.();
	}
}

function startTui(term: VirtualTerminal, text: string): { tui: TUI; scheduler: ManualScheduler; component: Text } {
	const scheduler = new ManualScheduler();
	const component = new Text(text, 0, 0);
	const tui = new TUI(term, undefined, { renderScheduler: scheduler });
	tui.addChild(component);
	tui.start();
	scheduler.advance(FRAME_MS);
	return { tui, scheduler, component };
}

describe("TUI output-backpressure render gate", () => {
	it("skips stale frames while the terminal backlog is deep and paints the latest state on drain", () => {
		const term = new RecordingTerminal(40, 6);
		const { tui, scheduler, component } = startTui(term, "initial");
		try {
			expect(term.written.join("")).toContain("initial");
			term.written.length = 0;

			// Deep backlog: due renders must emit nothing without a retry timer.
			term.setOutputBacklog(DEEP_BACKLOG);
			component.setText("frame-A");
			tui.requestRender();
			scheduler.advance(FRAME_MS);
			expect(term.written).toEqual([]);
			expect(term.pendingOutputBytes).toBe(DEEP_BACKLOG);
			expect(scheduler.pending).toBe(0);

			// Still stalled; newer state supersedes frame-A without a paint.
			component.setText("frame-B");
			tui.requestRender();
			scheduler.advance(FRAME_MS);
			expect(term.written).toEqual([]);
			expect(scheduler.pending).toBe(0);

			// The drain notification schedules exactly the latest state.
			term.setOutputBacklog(0);
			scheduler.advance(FRAME_MS);
			const output = term.written.join("");
			expect(output).toContain("frame-B");
			expect(output).not.toContain("frame-A");
		} finally {
			tui.stop();
		}
	});

	it("preserves forced repaint and scrollback clearing while waiting without a timer", () => {
		const term = new RecordingTerminal(40, 6);
		const { tui, scheduler } = startTui(term, "unchanged");
		try {
			term.written.length = 0;
			term.setOutputBacklog(DEEP_BACKLOG);
			tui.requestRender();
			scheduler.advance(FRAME_MS);

			tui.requestRender(true, { clearScrollback: true });
			scheduler.advance(FRAME_MS);
			expect(term.written).toEqual([]);
			expect(scheduler.pending).toBe(0);

			term.setOutputBacklog(0);
			scheduler.advance(FRAME_MS);
			expect(term.written.join("")).toContain("\x1b[3J");
			expect(term.written.join("")).toContain("unchanged");
		} finally {
			tui.stop();
		}
	});

	it("resumes when the drain is reported from inside a write that is still being delivered", () => {
		const term = new RecordingTerminal(40, 6);
		const { tui, scheduler, component } = startTui(term, "initial");
		try {
			term.setOutputBacklog(DEEP_BACKLOG);
			component.setText("raced drain");
			tui.requestRender();
			scheduler.advance(FRAME_MS);
			expect(term.written.join("")).not.toContain("raced drain");

			// An out-of-band write lands and the stream empties while the terminal
			// is still delivering it.
			term.afterReceive = () => {
				term.afterReceive = undefined;
				term.setOutputBacklog(0);
			};
			term.write("\x1b]0;title\x07");
			scheduler.advance(FRAME_MS);
			expect(term.written.join("")).toContain("raced drain");
		} finally {
			tui.stop();
		}
	});

	it("writes nothing for a drain after stop and paints the restarted session", () => {
		const term = new RecordingTerminal(40, 6);
		const { tui, scheduler } = startTui(term, "restarted");
		try {
			term.setOutputBacklog(DEEP_BACKLOG);
			tui.requestRender();
			scheduler.advance(FRAME_MS);
			tui.stop();

			term.written.length = 0;
			term.setOutputBacklog(0);
			scheduler.advance(FRAME_MS);
			expect(term.written).toEqual([]);
			expect(scheduler.pending).toBe(0);

			tui.start();
			scheduler.advance(FRAME_MS);
			expect(term.written.join("")).toContain("restarted");
		} finally {
			tui.stop();
		}
	});

	it("ignores a render timer queued before stop when the TUI restarts", () => {
		const term = new RecordingTerminal(40, 6);
		const { tui, scheduler } = startTui(term, "current session");
		try {
			tui.requestRender(true);
			const stale = scheduler.take();
			expect(stale.length).toBeGreaterThan(0);
			tui.stop();
			tui.start();
			term.written.length = 0;
			for (const run of stale) run();
			expect(term.written).toEqual([]);
			scheduler.advance(FRAME_MS);
			expect(term.written.join("")).toContain("current session");
		} finally {
			tui.stop();
		}
	});

	it("never gates terminals whose output does not back up", () => {
		const term = new VirtualTerminal(40, 6);
		const { tui, scheduler, component } = startTui(term, "plain");
		try {
			component.setText("updated");
			tui.requestRender();
			scheduler.advance(FRAME_MS);
			expect(term.getViewport().join("\n")).toContain("updated");
		} finally {
			tui.stop();
		}
	});
});
