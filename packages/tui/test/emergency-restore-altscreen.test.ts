import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { type TerminalFrameProvider, TUI } from "@oh-my-pi/pi-tui";
import { emergencyTerminalRestore, type ProcessTerminal } from "@oh-my-pi/pi-tui/terminal";
import { ManualScheduler } from "./helpers/manual-scheduler";
import { type FakeTty, fakeProcessTty, NOOP_HOST } from "./helpers/process-tty";
import { withoutTerminalMultiplexer } from "./helpers/terminal-multiplexer";

// Regression coverage for the Windows shell-handoff corruption on exit:
// `emergencyTerminalRestore()` used to write DECRST 1049 ("leave alternate
// screen") unconditionally on every exit path. On xterm-family terminals that
// is a no-op while the main buffer is active, but Windows' shared VT
// dispatcher (conhost + Windows Terminal, AdaptDispatch) runs an unconditional
// CursorRestoreState() for it — with no prior DECSC save the cursor jumps to
// the viewport home. Since the restore runs from a postmortem cleanup callback
// AFTER the TUI has already stopped and printed its exit hints, the parent
// shell prompt then lands on top of the dead frame. The contract: the restore
// leaves the alternate screen only when the session entered it (a fullscreen
// overlay), and nothing is written once output was handed back to the shell.

const ALT_ENTER = "\x1b[?1049h";
const ALT_EXIT = "\x1b[?1049l";
const KITTY_POP = "\x1b[<u";
/** The terminal's answer to the kitty keyboard query: supported, no flags set. */
const KITTY_REPLY = "\x1b[?0u";
/** Long enough for any due frame (the frame cadence is ~33 ms). */
const FRAME_MS = 100;

describe("emergencyTerminalRestore alt-screen gating", () => {
	withoutTerminalMultiplexer();

	let tty: FakeTty;
	const tuis: TUI[] = [];
	const terminals: ProcessTerminal[] = [];

	beforeEach(() => {
		tty = fakeProcessTty();
	});

	afterEach(() => {
		for (const tui of tuis.splice(0)) tui.stop();
		for (const terminal of terminals.splice(0)) terminal.stop();
		tty.dispose();
	});

	function startTerminal(): ProcessTerminal {
		// conpty: false keeps the keyboard negotiation hermetic regardless of an ambient WSL env.
		const terminal = tty.terminal({ conpty: false });
		terminals.push(terminal);
		terminal.bind(NOOP_HOST);
		terminal.start();
		return terminal;
	}

	function startTui(provider?: TerminalFrameProvider): { tui: TUI; scheduler: ManualScheduler } {
		const scheduler = new ManualScheduler();
		const tui = new TUI(tty.terminal({ conpty: false }), undefined, { renderScheduler: scheduler });
		tuis.push(tui);
		if (provider) tui.setFrameProvider(provider);
		tui.start();
		scheduler.advance(FRAME_MS);
		return { tui, scheduler };
	}

	function showFullscreenOverlay(tui: TUI, scheduler: ManualScheduler) {
		const overlay = tui.showOverlay(
			{ render: () => ["session selector"] },
			{ fullscreen: true, width: "100%", maxHeight: "100%" },
		);
		scheduler.advance(FRAME_MS);
		expect(tty.output()).toContain(ALT_ENTER);
		return overlay;
	}

	it("never writes after graceful stop has handed output back to the shell", () => {
		const terminal = startTerminal();
		terminal.stop();
		expect(tty.output()).toContain("\x1b[?25h");

		tty.clear();
		emergencyTerminalRestore();
		terminal.showCursor(true);
		terminal.write("late frame");
		terminal.stop();
		expect(tty.writes).toEqual([]);
	});

	it("permits output again only after a new start", () => {
		const terminal = startTerminal();
		terminal.stop();
		terminal.start({ deferInput: true });
		tty.clear();

		terminal.write("new session");
		expect(tty.output()).toContain("new session");
	});

	it("leaves the alternate screen alone on the crash path when the session never entered it", () => {
		startTerminal();
		tty.clear();

		emergencyTerminalRestore();

		const restore = tty.output();
		expect(restore).not.toContain(ALT_EXIT);
		// The unconditional resets still go out.
		expect(restore).toContain("\x1b[?1006l");
		expect(restore).toContain("\x1b[?1003l");
		expect(restore).toContain("\x1b[?1000l");
		expect(restore).toContain("\x1b[?25h");
	});

	it("leaves a fullscreen overlay's alternate screen on the crash path, popping keyboard frames on both screens", () => {
		const { tui, scheduler } = startTui();
		tty.type(KITTY_REPLY);
		expect(tui.terminal.kittyProtocolActive).toBe(true);
		showFullscreenOverlay(tui, scheduler);
		tty.clear();

		emergencyTerminalRestore();

		const restored = tty.output();
		const altPop = restored.indexOf(KITTY_POP);
		const altExit = restored.indexOf(ALT_EXIT);
		const mainPop = restored.indexOf(KITTY_POP, altExit + 1);
		expect(altPop).toBeGreaterThanOrEqual(0);
		expect(altPop).toBeLessThan(altExit);
		expect(mainPop).toBeGreaterThan(altExit);
		expect(tui.terminal.kittyProtocolActive).toBe(false);

		// The restore handed output back: a second crash-path restore writes nothing.
		tty.clear();
		emergencyTerminalRestore();
		expect(tty.writes).toEqual([]);
	});

	it("does not regain output ownership after a graceful stop from a fullscreen overlay", () => {
		const { tui, scheduler } = startTui();
		showFullscreenOverlay(tui, scheduler);
		tty.clear();

		tui.stop();
		expect(tty.output()).toContain(ALT_EXIT);

		tty.clear();
		emergencyTerminalRestore();
		expect(tty.writes).toEqual([]);
	});

	it("is back on the main screen after a crash in the paint that replaces a fullscreen overlay", () => {
		let failReplacement = false;
		const provider: TerminalFrameProvider = {
			renderFrame: () => {
				if (failReplacement) throw new Error("replacement failed");
				return { viewport: ["old session"] };
			},
			acknowledgeHistory: () => {},
		};
		const { tui, scheduler } = startTui(provider);
		const overlay = showFullscreenOverlay(tui, scheduler);
		tui.requestRender(true, { clearScrollback: true });
		scheduler.advance(FRAME_MS);

		failReplacement = true;
		overlay.hide();
		expect(() => scheduler.advance(FRAME_MS)).toThrow("replacement failed");
		emergencyTerminalRestore();

		const output = tty.output();
		expect(output.lastIndexOf(ALT_EXIT)).toBeGreaterThan(output.lastIndexOf(ALT_ENTER));
		// Let the teardown in afterEach compose its final frame.
		failReplacement = false;
	});
});
