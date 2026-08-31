import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	CURSOR_MARKER,
	type TerminalFramePlan,
	type TerminalFrameProvider,
	TUI,
	type ViewportSize,
} from "@oh-my-pi/pi-tui";
import { VirtualTerminal } from "./virtual-terminal";

// Regression coverage for the SIGWINCH-side pre-erase archiving the unfinished
// frame on terminals that preserve a full-screen clear (#9780).
//
// Before borrowing the alt buffer, the resize path erases the live viewport off
// the normal screen so a reflow-driven scroll can only push committed rows into
// scrollback. When that erase starts on the first row - the steady state once
// the transcript fills the screen - it covers the whole screen, and a
// preserving terminal archives the screen it is about to blank instead of
// discarding it. The erase meant to keep live rows out of scrollback then puts
// the whole unfinished frame (spinner, half-written cards, composer) there,
// which is the same defect e72762e7d fixed for the history-append path.
//
// The grow branch addresses the erase cursor-relative, so the bytes alone do
// not reveal the trigger: a CUU larger than the distance to the top clamps at
// the first row, and `\r\x1b[J` there is screen-wide. The terminal below
// therefore samples the cursor at each erase, exactly as tmux does.

/**
 * Models a terminal that preserves a full-screen clear, as tmux and Windows
 * conhost (#9597) do: tmux's `screen_write_clearendofscreen()` routes through
 * `grid_view_clear_history()` when the cursor sits on the first cell, and ED2
 * always archives. Counts those clears and pushes the visible screen into
 * scrollback before performing them.
 */
class PreservedClearTerminal extends VirtualTerminal {
	archivedClears = 0;

	override write(data: string): void {
		const erase = /\x1b\[([0-2]?)J/g;
		let cursor = 0;
		for (let match = erase.exec(data); match; match = erase.exec(data)) {
			super.write(data.slice(cursor, match.index));
			cursor = match.index + match[0].length;
			const mode = match[1] === "" ? "0" : match[1];
			const position = this.getCursor();
			if (mode === "2" || (mode === "0" && position.row === 0 && position.col === 0)) {
				this.archivedClears++;
				super.write(`\x1b[${this.rows};1H${"\n".repeat(this.rows)}`);
			}
			super.write(match[0]);
		}
		super.write(data.slice(cursor));
	}
}

class FullFrameProvider implements TerminalFrameProvider {
	history: { id: number; rows: string[] } | undefined;
	markerRow: number | undefined;
	liveRows = 12;

	renderFrame(viewport: ViewportSize): TerminalFramePlan {
		const rows = Array.from({ length: Math.min(this.liveRows, viewport.rows) }, (_, index) => `live-${index}`);
		if (this.markerRow !== undefined && this.markerRow < rows.length) {
			rows[this.markerRow] = `${rows[this.markerRow]}${CURSOR_MARKER}`;
		}
		return { history: this.history, viewport: rows };
	}
	renderResizeFrame(viewport: ViewportSize): readonly string[] {
		return Array.from({ length: Math.min(this.liveRows, viewport.rows) }, (_, index) => `resize-${index}`);
	}
	acknowledgeHistory(): void {
		this.history = undefined;
	}
}

class ResizeScheduler {
	#pending = new Set<() => void>();
	t = 0;
	now(): number {
		return this.t;
	}
	scheduleImmediate(callback: () => void): void {
		callback();
	}
	scheduleRender(callback: () => void, _delayMs?: number) {
		this.#pending.add(callback);
		return { cancel: () => this.#pending.delete(callback) };
	}
	settle(): void {
		const pending = [...this.#pending];
		this.#pending.clear();
		for (const callback of pending) callback();
	}
}

// Every signal isInsideTerminalMultiplexer() recognizes; the suite itself may
// run under tmux, screen, Zellij, CMUX, or Herdr, and the SIGWINCH-side erase
// only runs on direct terminals.
const MUX_SIGNALS = [
	"TMUX",
	"STY",
	"ZELLIJ",
	"HERDR_ENV",
	"CMUX_WORKSPACE_ID",
	"CMUX_SURFACE_ID",
	"CMUX_REMOTE_TRANSPORT",
	"TERM",
] as const;

function startRig(markerRow?: number, columns = 40, rows = 12) {
	const terminal = new PreservedClearTerminal(columns, rows);
	const provider = new FullFrameProvider();
	provider.markerRow = markerRow;
	const renderScheduler = new ResizeScheduler();
	const tui = new TUI(terminal, undefined, { renderScheduler });
	tui.setFrameProvider(provider);
	tui.start();
	terminal.archivedClears = 0;
	return { terminal, tui, provider, renderScheduler };
}

describe("resize pre-erase on a preserved-clear terminal", () => {
	let saved: Partial<Record<(typeof MUX_SIGNALS)[number], string | undefined>>;
	beforeEach(() => {
		saved = {};
		for (const key of MUX_SIGNALS) {
			saved[key] = Bun.env[key];
			delete Bun.env[key];
		}
		Bun.env.TERM = "xterm-256color";
	});
	afterEach(() => {
		for (const key of MUX_SIGNALS) {
			if (saved[key] === undefined) delete Bun.env[key];
			else Bun.env[key] = saved[key];
		}
	});

	it("keeps live rows out of scrollback when a height grow erases a screen-filling viewport", () => {
		// The parked cursor sits mid-frame, so the erase moves up by more rows
		// than the screen has above it and clamps onto the first row.
		const { terminal, tui, renderScheduler } = startRig(4);
		expect(terminal.getViewport()[0]?.trimEnd()).toBe("live-0");

		terminal.resize(40, 20);
		renderScheduler.settle();

		const buffer = terminal.getScrollBuffer();
		const history = buffer.slice(0, Math.max(0, buffer.length - terminal.rows));
		expect(history.map(row => Bun.stripANSI(row).trimEnd()).filter(row => row.startsWith("live-"))).toEqual([]);
		expect(terminal.archivedClears).toBe(0);
		tui.stop();
	});

	it("never issues a screen-wide clear when a height shrink erases a screen-filling viewport", () => {
		// A height shrink pushes the screen's top rows into scrollback in the
		// terminal itself, before the app is signalled, so scrollback content is
		// not the discriminator here - the erase must simply never be screen-wide.
		const { terminal, tui, renderScheduler } = startRig();
		expect(terminal.getViewport()[0]?.trimEnd()).toBe("live-0");

		terminal.resize(40, 6);
		renderScheduler.settle();

		expect(terminal.archivedClears).toBe(0);
		tui.stop();
	});
	it("keeps a short viewport anchored after a height shrink", () => {
		const { terminal, tui, provider, renderScheduler } = startRig();
		provider.liveRows = 3;
		tui.requestRender(true);
		expect(terminal.getViewport()[0]?.trimEnd()).toBe("live-0");

		terminal.resize(40, 6);
		renderScheduler.settle();

		// The split clear visits row 2 for ED0, but the subsequent CPR must still
		// report the viewport's row-1 anchor rather than shifting the repaint down.
		expect(terminal.getCursor().row).toBe(0);
		terminal.sendInput("\x1b[1;17R");
		renderScheduler.settle();
		expect(terminal.getViewport()[0]?.trimEnd()).toBe("live-0");
		tui.stop();
	});

	it("keeps the erase off the first cell at a one-column viewport, where CUF cannot move", () => {
		// One column is a supported geometry, and there CUF clamps at the right
		// margin: stepping one column right leaves the cursor on the first cell,
		// so the erase has to step a row instead.
		const { terminal, tui, renderScheduler } = startRig(2, 1, 4);

		terminal.resize(1, 8);
		renderScheduler.settle();

		expect(terminal.archivedClears).toBe(0);
		tui.stop();
	});
});
