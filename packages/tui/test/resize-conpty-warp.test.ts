import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { type TerminalFramePlan, type TerminalFrameProvider, TUI, type ViewportSize } from "@oh-my-pi/pi-tui";
import { VirtualTerminal } from "./virtual-terminal";

// Regression coverage for a resize on Warp under Windows ConPTY leaving the
// screen unrecoverable (scrolled-up duplicate transcript, apparently dead
// input).
//
// The in-place resize path is default-on for Warp: it never borrows the alt
// buffer, skips the ResizeScrollbackMode replay, and instead anchors one settled
// repaint on a DSR (CSI 6n) round trip against a parked cursor. Both halves of
// that contract are false under ConPTY, measured on conhost with omp 18.1.15
// (`PtySession` at 80x24, cursor parked at row 5 column 20):
//
//   - resizing the pseudoconsole makes conhost re-emit its own viewport from
//     `CSI H` with absolute addressing, with the application writing nothing;
//   - the DSR reply after that resize is `CSI 3;1R` (and `CSI 7;1R` after a
//     width shrink) — conhost re-homed the cursor, so the reply never carries
//     the probe's tag column and can never be attributed.
//
// So the probe always times out, the anchor is a guess against a grid conhost
// has already overwritten, and nothing rebuilds the display afterwards. On a
// ConPTY host the resize must therefore keep the alt-screen borrow, whose
// settled transaction ends in the destructive rebuild replay.

const ALT_ENTER = "\x1b[?1049h";
const ED3 = "\x1b[3J";
const DSR = "\x1b[6n";
const COMMITTED = ["committed-0", "committed-1", "committed-2"];

const TERMINAL_ENV = ["TERM", "TERM_PROGRAM", "PI_TUI_RESIZE_IN_PLACE", "TMUX", "STY", "ZELLIJ", "HERDR_ENV"] as const;

/**
 * Windows ConPTY host: answers DSR from its own re-homed cursor (column 1
 * always) and repaints its viewport into the stream on every resize.
 */
class ConPtyTerminal extends VirtualTerminal {
	readonly hostOwnsGridOnResize = true;
	hostRepaints = 0;
	cprReplies: string[] = [];

	override write(data: string): void {
		const probe = data.indexOf("\x1b[6n");
		if (probe === -1) {
			super.write(data);
			return;
		}
		super.write(data.slice(0, probe) + data.slice(probe + 4));
		const reply = `\x1b[${this.getCursor().row + 1};1R`;
		this.cprReplies.push(reply);
		queueMicrotask(() => this.sendInput(reply));
	}

	override resize(columns: number, rows: number): void {
		const stale = this.getViewport().map(row => row.trimEnd());
		super.resize(columns, rows);
		this.hostRepaints++;
		super.write(`\x1b[?25l\x1b[H${stale.map(row => `${row}\x1b[K`).join("\r\n")}\x1b[H\x1b[?25h`);
	}
}

class ReplayProvider implements TerminalFrameProvider {
	history: TerminalFramePlan["history"];
	liveRows = 6;
	#nextId = 1;

	renderFrame(viewport: ViewportSize): TerminalFramePlan {
		const rows = Array.from({ length: Math.min(this.liveRows, viewport.rows) }, (_v, index) => `live-${index}`);
		return { history: this.history, viewport: rows };
	}
	renderResizeFrame(viewport: ViewportSize): readonly string[] {
		return Array.from({ length: Math.min(this.liveRows, viewport.rows) }, (_v, index) => `resize-${index}`);
	}
	acknowledgeHistory(): void {
		this.history = undefined;
	}
	beginHistoryReplay(): void {
		this.history = { id: ++this.#nextId, rows: COMMITTED, kind: "replay" };
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

function startRig() {
	const terminal = new ConPtyTerminal(40, 12);
	const provider = new ReplayProvider();
	provider.history = { id: 1, rows: COMMITTED };
	const renderScheduler = new ResizeScheduler();
	const tui = new TUI(terminal, undefined, { renderScheduler });
	const writes: string[] = [];
	const originalWrite = terminal.write.bind(terminal);
	terminal.write = (data: string) => {
		writes.push(data);
		originalWrite(data);
	};
	tui.setFrameProvider(provider);
	// The coding agent's setting; `preserve` (the raw TUI default) has no replay.
	tui.setResizeScrollback("rebuild");
	tui.start();
	return { terminal, tui, provider, renderScheduler, writes };
}

describe("resize on Warp hosted by Windows ConPTY", () => {
	let saved: Record<string, string | undefined> = {};

	beforeEach(() => {
		saved = {};
		for (const key of TERMINAL_ENV) {
			saved[key] = Bun.env[key];
			delete Bun.env[key];
		}
		Bun.env.TERM = "xterm-256color";
		Bun.env.TERM_PROGRAM = "WarpTerminal";
	});

	afterEach(() => {
		for (const key of TERMINAL_ENV) {
			if (saved[key] === undefined) delete Bun.env[key];
			else Bun.env[key] = saved[key];
		}
		saved = {};
	});

	it("rebuilds the transcript instead of anchoring a repaint conhost already overwrote", async () => {
		const { terminal, tui, renderScheduler, writes } = startRig();
		try {
			renderScheduler.settle();
			writes.length = 0;

			terminal.resize(40, 20);
			renderScheduler.settle(); // leave the borrow, start the settled probe
			renderScheduler.settle(); // probe timeout (no attributable reply)
			renderScheduler.settle(); // settled repaint
			const emitted = writes.join("");

			// conhost repainted its stale viewport with absolute addressing, so the
			// settled resize must erase native history and re-stream the ledger.
			expect(terminal.hostRepaints).toBe(1);
			expect(emitted).toContain(ED3);
			expect(emitted).toContain(COMMITTED[0]);
			// The reply could only report column 1, so the probe is never sent: a
			// dead tag column is never reclaimed and the repaint would wait out the
			// full timeout for it.
			expect(emitted).not.toContain(DSR);
			expect(terminal.cprReplies).toEqual([]);
		} finally {
			tui.stop();
		}
	});

	it("borrows the alt buffer exactly once, so the Warp toggle echo cannot loop", async () => {
		const { terminal, tui, renderScheduler, writes } = startRig();
		try {
			renderScheduler.settle();
			writes.length = 0;

			terminal.resize(40, 20);
			// Warp echoes a height-only ±1 resize on each alt-buffer toggle.
			terminal.resize(40, 19);
			renderScheduler.settle();
			renderScheduler.settle();
			renderScheduler.settle();

			const borrows = writes.join("").split(ALT_ENTER).length - 1;
			expect(borrows).toBe(1);
		} finally {
			tui.stop();
		}
	});

	it("keeps the DSR probe inside a multiplexer, which answers it from its own grid", async () => {
		// WSL-in-tmux is ConPTY-hosted, but tmux consumes the CSI 6n and replies
		// from the grid it owns, so the reply carries the tag column after all.
		Bun.env.TMUX = "/tmp/tmux-1000/default,1,0";
		const { terminal, tui, renderScheduler, writes } = startRig();
		try {
			renderScheduler.settle();
			writes.length = 0;

			terminal.resize(40, 20);
			renderScheduler.settle();
			renderScheduler.settle();

			expect(writes.join("")).toContain(DSR);
		} finally {
			tui.stop();
		}
	});

	it("keeps the DSR probe when PI_TUI_RESIZE_IN_PLACE=1 forces in-place repaint", async () => {
		// The escape hatch restores the whole pre-change path, anchor probe
		// included: an in-place repaint is only as good as its anchor.
		Bun.env.PI_TUI_RESIZE_IN_PLACE = "1";
		const { terminal, tui, renderScheduler, writes } = startRig();
		try {
			renderScheduler.settle();
			writes.length = 0;

			terminal.resize(40, 20);
			renderScheduler.settle();
			renderScheduler.settle();

			const emitted = writes.join("");
			expect(emitted).toContain(DSR);
			expect(emitted).not.toContain(ALT_ENTER);
		} finally {
			tui.stop();
		}
	});
});
