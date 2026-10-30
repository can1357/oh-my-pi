import { describe, expect, it } from "bun:test";
import { Text, TUI } from "@oh-my-pi/pi-tui";
import { VirtualRenderScheduler } from "./virtual-render-scheduler";
import { VirtualTerminal } from "./virtual-terminal";
import { WidthReplayProvider } from "./width-replay-provider";

// A settled rebuild-mode resize erases the screen and history and repaints
// from row zero, so it needs no viewport anchor. Restoring the normal buffer
// on its own write, then probing the anchor, exposed the reflowed stale screen
// for a CPR round trip before the rebuild cleared it: one visible flash per
// large resize (a tmux zoom). The restore now rides inside the rebuild write.

const ALT_ENTER = "\x1b[?1049h";
const ALT_EXIT = "\x1b[?1049l";
const ERASE_SCREEN_AND_HISTORY = "\x1b[2J\x1b[3J";
const DSR = "\x1b[6n";
// Resize settle window (120 ms) plus the
// virtual scheduler's 40 ms drain horizon for the frames the settle schedules.
const RESIZE_SETTLE_ADVANCE_MS = 160;

/** Records every engine write and reports a settable output backlog. */
class RecordingTerminal extends VirtualTerminal {
	written: string[] = [];
	pendingBytes = 0;

	get pendingOutputBytes(): number {
		return this.pendingBytes;
	}

	override write(data: string): void {
		this.written.push(data);
		super.write(data);
	}
}

async function startRig() {
	const terminal = new RecordingTerminal(20, 4);
	const scheduler = new VirtualRenderScheduler();
	const tui = new TUI(terminal, undefined, { renderScheduler: scheduler });
	tui.setResizeScrollback("rebuild");
	tui.setFrameProvider(new WidthReplayProvider());
	tui.start();
	await scheduler.settle(terminal);
	terminal.written = [];
	return { terminal, scheduler, tui };
}

function plainRows(terminal: VirtualTerminal): string[] {
	return terminal
		.getScrollBuffer()
		.map(row => row.trimEnd())
		.filter(row => row.length > 0);
}

function count(haystack: string, needle: string): number {
	return haystack.split(needle).length - 1;
}

describe("resize alt borrow entry", () => {
	it("switches to the borrowed buffer in the same write as the first resize frame", async () => {
		const { terminal, scheduler, tui } = await startRig();
		try {
			terminal.resize(30, 4);
			await scheduler.advance(terminal, 10);

			// A switch written on its own lets the terminal present the blank
			// alternate screen for a frame before the resize frame fills it.
			const enterWrites = terminal.written.filter(data => data.includes(ALT_ENTER));
			expect(enterWrites).toHaveLength(1);
			const [enter] = enterWrites;
			expect(enter!.indexOf("editor@30")).toBeGreaterThan(enter!.indexOf(ALT_ENTER));
		} finally {
			tui.stop();
		}
	});
});

describe("resize settle fused alt exit", () => {
	it("restores the normal buffer in the same write as the settled rebuild", async () => {
		const { terminal, scheduler, tui } = await startRig();
		try {
			terminal.resize(30, 4);
			await scheduler.advance(terminal, RESIZE_SETTLE_ADVANCE_MS);

			// Restoring on a write of its own would expose the reflowed stale screen
			// until the rebuild lands; the anchor probe that used to fill that gap
			// has nothing to anchor for a repaint that starts at row zero.
			const exitWrites = terminal.written.filter(data => data.includes(ALT_EXIT));
			expect(exitWrites).toHaveLength(1);
			const [rebuild] = exitWrites;
			expect(rebuild!.indexOf(ERASE_SCREEN_AND_HISTORY)).toBeGreaterThan(rebuild!.indexOf(ALT_EXIT));
			expect(terminal.written.join("")).not.toContain(DSR);
			expect(plainRows(terminal)).toEqual(["history-one@30", "history-two@30", "editor@30"]);
		} finally {
			tui.stop();
		}
	});

	it("resumes the borrow when a resize lands before the fused rebuild is written", async () => {
		const { terminal, scheduler, tui } = await startRig();
		try {
			terminal.resize(30, 4);
			await scheduler.advance(terminal, 60);
			// A previous replay is still draining, so the settled rebuild — and the
			// alt exit fused into it — is deferred while the pane moves again.
			terminal.pendingBytes = Number.MAX_SAFE_INTEGER;
			await scheduler.advance(terminal, RESIZE_SETTLE_ADVANCE_MS);
			terminal.resize(34, 4);
			terminal.pendingBytes = 0;
			await scheduler.advance(terminal, RESIZE_SETTLE_ADVANCE_MS);

			// The terminal never left the borrowed buffer, so entering it again
			// would stack a second switch whose extra exit then lands on the
			// normal screen after the rebuild.
			const emitted = terminal.written.join("");
			expect(count(emitted, ALT_ENTER)).toBe(1);
			expect(count(emitted, ALT_EXIT)).toBe(1);
			expect(plainRows(terminal)).toEqual(["history-one@34", "history-two@34", "editor@34"]);
		} finally {
			tui.stop();
		}
	});

	it("hands the borrowed buffer to a fullscreen overlay opened before the rebuild is written", async () => {
		const { terminal, scheduler, tui } = await startRig();
		try {
			terminal.resize(30, 4);
			await scheduler.advance(terminal, 60);
			const overlay = tui.showOverlay(new Text("modal"), { fullscreen: true });
			await scheduler.advance(terminal, RESIZE_SETTLE_ADVANCE_MS);

			// The overlay's first frame runs while the fused exit is still pending:
			// it must take over the buffer the terminal is already on.
			expect(count(terminal.written.join(""), ALT_ENTER)).toBe(1);

			overlay.hide();
			await scheduler.advance(terminal, 50);

			const emitted = terminal.written.join("");
			expect(count(emitted, ALT_EXIT)).toBe(1);
			expect(emitted.indexOf(ERASE_SCREEN_AND_HISTORY)).toBeGreaterThan(emitted.indexOf(ALT_EXIT));
			expect(plainRows(terminal)).toEqual(["history-one@30", "history-two@30", "editor@30"]);
		} finally {
			tui.stop();
		}
	});
});
