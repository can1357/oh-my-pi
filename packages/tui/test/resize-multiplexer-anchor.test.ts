import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	CURSOR_MARKER,
	type TerminalFramePlan,
	type TerminalFrameProvider,
	TUI,
	type ViewportSize,
} from "@oh-my-pi/pi-tui";
import { VirtualTerminal } from "./virtual-terminal";

// Regression coverage for tmux pane zoom corrupting scrollback (duplication and
// committed-row loss). Multiplexers re-lay the pane on their own schedule
// relative to SIGWINCH delivery and do not keep the parked cursor attached
// through a height shrink, so:
// - the SIGWINCH-side erase must not run (it races the re-layout and blanks
//   pulled-back committed rows, destroying popped scrollback), and
// - the settled anchor must come from the deterministic clip model (blank rows
//   below the viewport clip first, then top rows push, moving the viewport up
//   by exactly the pushed count) instead of CPR-relative math.

class FullFrameProvider implements TerminalFrameProvider {
	history: { id: number; rows: string[] } | undefined;
	markerRow: number | undefined;
	liveRows = 8;
	rowPad = 0;

	renderFrame(viewport: ViewportSize): TerminalFramePlan {
		const rows = Array.from({ length: this.liveRows }, (_, i) =>
			this.rowPad > 0 ? `live-${i}`.padEnd(this.rowPad, "x") : `live-${i}`,
		);
		if (this.markerRow !== undefined) rows[this.markerRow] = `${rows[this.markerRow]}${CURSOR_MARKER}`;
		const plan: TerminalFramePlan = {
			history: this.history,
			viewport: rows.slice(-Math.min(this.liveRows, viewport.rows)),
		};
		return plan;
	}
	renderResizeFrame(viewport: ViewportSize): readonly string[] {
		return Array.from({ length: Math.min(8, viewport.rows) }, (_, i) => `resize-${i}`);
	}
	acknowledgeHistory(): void {
		this.history = undefined;
	}
}

function startRig(markerRow?: number) {
	const terminal = new VirtualTerminal(40, 12);
	const provider = new FullFrameProvider();
	provider.markerRow = markerRow;
	provider.history = { id: 1, rows: Array.from({ length: 3 }, (_, i) => `committed-${i}`) };
	const renderScheduler = new ResizeScheduler();
	const tui = new TUI(terminal, undefined, { renderScheduler });
	const writes: string[] = [];
	const originalWrite = terminal.write.bind(terminal);
	terminal.write = (data: string) => {
		writes.push(data);
		originalWrite(data);
	};
	tui.setFrameProvider(provider);
	tui.start();
	return { terminal, tui, provider, renderScheduler, writes };
}

class ResizeScheduler {
	#pending = new Set<() => void>();
	/** Mutable clock: advance past the 100 ms post-settle resize suppression. */
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
// run under tmux, screen, Zellij, CMUX, or Herdr, so direct-terminal describes
// must clear them all (TERM prefixed tmux-/screen- also flags a multiplexer).
const MUX_SIGNALS = [
	"TMUX",
	"STY",
	"ZELLIJ",
	"HERDR_ENV",
	"HERDR_PANE_ID",
	"HERDR_TAB_ID",
	"HERDR_WORKSPACE_ID",
	"CMUX_WORKSPACE_ID",
	"CMUX_SURFACE_ID",
	"CMUX_REMOTE_TRANSPORT",
	"TERM",
] as const;

function useDirectTerminalEnv() {
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
}

describe("resize anchoring inside a terminal multiplexer", () => {
	let previousTmux: string | undefined;

	beforeEach(() => {
		previousTmux = Bun.env.TMUX;
		Bun.env.TMUX = "/tmp/tmux-1000/default,1,0";
	});
	afterEach(() => {
		if (previousTmux === undefined) delete Bun.env.TMUX;
		else Bun.env.TMUX = previousTmux;
	});

	it("skips the SIGWINCH-side erase so a racing re-layout cannot blank popped scrollback", () => {
		const { terminal, tui, renderScheduler, writes } = startRig();
		writes.length = 0;
		terminal.resize(40, 20);
		const beforeAlt = writes.join("").split("\x1b[?1049h")[0] ?? "";
		// No ED (erase-below) may be emitted on the normal screen before the alt
		// borrow: the pane may already have been re-laid, so any erase addressed
		// with stale coordinates can destroy pulled-back committed rows.
		expect(beforeAlt.includes("\x1b[J")).toBe(false);
		renderScheduler.settle();
		renderScheduler.settle();
		tui.stop();
	});

	it("anchors a settled single-step shrink from the parked cursor, not content depth", () => {
		const { terminal, tui, renderScheduler, writes } = startRig();
		// Baseline: 3 committed rows above an 8-row live frame, viewport top = 3,
		// cursor parked at the viewport top (no marker). tmux discards rows below
		// the cursor before pushing anything (measured: even non-blank rows), so
		// a shrink by 6 is absorbed entirely by the 8 below-cursor rows: nothing
		// pushes and the anchor must stay at row 3. A content-depth model would
		// compute pushed=5 and anchor at 0, overwriting the still-visible
		// committed rows.
		terminal.resize(40, 6);
		renderScheduler.settle(); // exit the resize alt borrow, start the CPR probe
		writes.length = 0;
		renderScheduler.settle(); // first timeout: no reply -> one bounded retry
		renderScheduler.settle(); // retry timeout -> clip-model repaint
		const repaint = writes.join("");
		const cup = repaint.match(/\x1b\[(\d+);1H/);
		expect(cup).not.toBeNull();
		expect(Number(cup![1])).toBe(4);
		tui.stop();
	});

	it("treats a coalesced multi-step shrink burst cumulatively from pre-burst state", () => {
		const { terminal, tui, renderScheduler, writes } = startRig();
		// Burst 12 -> 6 -> 2 with no settle in between: cumulative shrink 10,
		// below-cursor rows 8 (cursor parked at viewport top 3), so pushed = 2
		// and the anchor lands at 3 - 2 = 1 (CUP row 2). Per-step recomputation
		// against refreshed state would double-count the below-cursor budget.
		terminal.resize(40, 6);
		terminal.resize(40, 2);
		renderScheduler.settle(); // exit the resize alt borrow, start the CPR probe
		writes.length = 0;
		renderScheduler.settle(); // first timeout: no reply -> one bounded retry
		renderScheduler.settle(); // retry timeout -> clip-model repaint
		const repaint = writes.join("");
		const cup = repaint.match(/\x1b\[(\d+);1H/);
		expect(cup).not.toBeNull();
		expect(Number(cup![1])).toBe(2);
		tui.stop();
	});

	it("lets the settled CPR outrank the clip model on a shrink", () => {
		// SIGWINCH coalescing can hide an intermediate grow entirely, so an
		// observed-monotonic shrink is not proof of monotonicity. The parked
		// cursor's reply IS exact — discards leave it in place, pushes only
		// occur after everything below it is discarded, and hidden grows ride
		// it down — so a reply reporting row 5 must anchor there (CUP row 6)
		// even though the clip model would keep the anchor at the pre-burst
		// top 3 and overwrite the two pulled-back rows.
		const { terminal, tui, renderScheduler, writes } = startRig();
		terminal.resize(40, 6);
		renderScheduler.settle(); // exit the resize alt borrow, start the CPR probe
		writes.length = 0;
		terminal.sendInput("\x1b[6;17R"); // parked cursor: rode a hidden pull down to row 5
		const repaint = writes.join("");
		const cup = repaint.match(/\x1b\[(\d+);1H/);
		expect(cup).not.toBeNull();
		expect(Number(cup![1])).toBe(6);
		tui.stop();
	});

	it("accounts for tmux width reflow in the CPR offset math", () => {
		// tmux clips on height changes but REFLOWS the pane on width changes:
		// a 36-cell row wraps to two physical rows at width 20, and the parked
		// cursor rides its logical line down. With the marker parked 4 logical
		// rows below the viewport top, the cursor sits 8 physical rows below
		// it after the shrink (row 11, reply row 12), so the anchor must be
		// 11 - 8 = 3 (CUP row 4). Counting logical rows (clip semantics) would
		// compute 11 - 4 = 7 and repaint below the real viewport, leaving the
		// old wide rows wrapped above it — one leftover frame per zoom toggle.
		const { terminal, tui, provider, renderScheduler, writes } = startRig(4);
		provider.rowPad = 36;
		tui.requestRender(true); // repaint the window with 36-cell rows
		terminal.resize(20, 12); // width-only shrink: tmux reflow, not clip
		renderScheduler.settle(); // exit the resize alt borrow, start the CPR probe
		writes.length = 0;
		terminal.sendInput("\x1b[12;17R"); // parked cursor after reflow: physical row 11
		const repaint = writes.join("");
		const cup = repaint.match(/\x1b\[(\d+);1H/);
		expect(cup).not.toBeNull();
		expect(Number(cup![1])).toBe(4);
		tui.stop();
	});

	it("preserves modified F3 input while a probe tag is outstanding", () => {
		// Modified F3 encodes as CSI 1;<mod>R with modifier params spanning
		// 2-256 once lock-state bits (caps 64, num 128) are included — e.g.
		// Shift+F3 is CSI 1;2R and F3 with Caps Lock is CSI 1;65R. Row-1
		// sequences that match no live tag must pass through to input
		// untouched instead of being stripped as terminal reports, and must
		// not resolve the probe. The probe's real reply afterwards still
		// resolves normally.
		const { terminal, tui, renderScheduler, writes } = startRig();
		const received: string[] = [];
		tui.addInputListener(data => {
			received.push(data);
			return undefined;
		});
		terminal.resize(40, 6);
		renderScheduler.settle(); // exit the resize alt borrow, start the CPR probe
		writes.length = 0;
		terminal.sendInput("\x1b[1;2R"); // Shift+F3
		terminal.sendInput("\x1b[1;65R"); // F3 with Caps Lock
		terminal.sendInput("\x1b[1;129R"); // F3 with Num Lock
		expect(writes.join("")).not.toMatch(/\x1b\[\d+;1H/);
		expect(received.join("")).toContain("\x1b[1;2R");
		expect(received.join("")).toContain("\x1b[1;65R");
		expect(received.join("")).toContain("\x1b[1;129R");
		terminal.sendInput("\x1b[4;17R"); // the probe's real reply
		const repaint = writes.join("");
		const cup = repaint.match(/\x1b\[(\d+);1H/);
		expect(cup).not.toBeNull();
		expect(Number(cup![1])).toBe(4);
		tui.stop();
	});

	it("falls back to the settled CPR when a coalesced burst reverses direction", () => {
		// Burst 12 -> 20 -> 6: the grow pulls the 3 committed scrollback rows
		// into the pane (parked cursor rides down 3 -> 6), then the 14-row
		// shrink discards the 13 rows below the cursor and pushes 1, leaving
		// the real viewport top at 5 — which the settled CPR reports, because
		// tmux keeps the parked cursor attached through both moves. The clip
		// model would telescope the net 12 -> 6 shrink from pre-burst state
		// (pushed=0, anchor 3) and repaint above the real viewport; the
		// `height - staleRows` bound would be worse still, dragging the anchor
		// to 0 over five retained history rows (tmux discarded stale rows
		// below the cursor rather than pushing them, so the bottom-preserving
		// bound does not hold). The reversed burst must anchor exactly where
		// the CPR reports.
		const { terminal, tui, renderScheduler, writes } = startRig();
		terminal.resize(40, 20);
		terminal.resize(40, 6);
		renderScheduler.settle(); // exit the resize alt borrow, start the CPR probe
		writes.length = 0;
		terminal.sendInput("\x1b[6;17R"); // parked cursor: real viewport top, row 5
		const repaint = writes.join("");
		const cup = repaint.match(/\x1b\[(\d+);1H/);
		expect(cup).not.toBeNull();
		expect(Number(cup![1])).toBe(6);
		tui.stop();
	});

	it("anchors a doubly CPR-less grow at the conservative pull bound", () => {
		// Grow 12 -> 20 with both the original probe's reply and the retry's
		// reply dropped: tmux may have pulled up to 8 scrollback rows down,
		// moving the real viewport top from 3 to as far as 11. The pre-resize
		// top would repaint at row 3 over pulled-back committed rows; the
		// final timeout must anchor at the upper bound 3 + 8 = 11 (CUP row
		// 12) — exact when scrollback covers the pull, and merely below the
		// real viewport when it does not.
		const { terminal, tui, renderScheduler, writes } = startRig();
		terminal.resize(40, 20);
		renderScheduler.settle(); // exit the resize alt borrow, start the CPR probe
		writes.length = 0;
		renderScheduler.settle(); // first timeout: no reply -> one bounded retry
		expect(writes.join("")).toContain("\x1b[18G\x1b[6n\x1b[1G"); // retry: tagged, cursor restored
		expect(writes.join("")).not.toMatch(/\x1b\[\d+;1H/);
		renderScheduler.settle(); // retry timeout: conservative fallback
		const repaint = writes.join("");
		const cup = repaint.match(/\x1b\[(\d+);1H/);
		expect(cup).not.toBeNull();
		expect(Number(cup![1])).toBe(12);
		tui.stop();
	});

	it("accounts for partial regrowth in the CPR-less pull bound", () => {
		// Burst 12 -> 6 -> 10 never exceeds the pre-burst height, but the
		// 6 -> 10 regrow can still pull four scrollback rows down. A bound
		// derived from the tallest height (12) would compute zero pull and
		// repaint from the pre-burst top 3 over those pulled-back committed
		// rows; the accumulated grow steps bound the anchor at 3 + 4 = 7
		// (CUP row 8).
		const { terminal, tui, renderScheduler, writes } = startRig();
		terminal.resize(40, 6);
		terminal.resize(40, 10);
		renderScheduler.settle(); // exit the resize alt borrow, start the CPR probe
		renderScheduler.settle(); // first timeout: no reply -> one bounded retry
		writes.length = 0;
		renderScheduler.settle(); // retry timeout: conservative fallback
		const repaint = writes.join("");
		const cup = repaint.match(/\x1b\[(\d+);1H/);
		expect(cup).not.toBeNull();
		expect(Number(cup![1])).toBe(8);
		tui.stop();
	});

	it("resolves a CPR-less grow from the original probe's late reply", () => {
		// The original probe's reply is merely late: it lands only after the
		// retry is armed. Its column tag still carries the current geometry
		// epoch (no restart happened), so it resolves the anchor eagerly —
		// same geometry, valid answer.
		const { terminal, tui, renderScheduler, writes } = startRig();
		terminal.resize(40, 20);
		renderScheduler.settle(); // exit the resize alt borrow, start the CPR probe
		renderScheduler.settle(); // first timeout: no reply -> one bounded retry
		writes.length = 0;
		terminal.sendInput("\x1b[8;17R"); // original probe's late reply: same epoch
		const repaint = writes.join("");
		const cup = repaint.match(/\x1b\[(\d+);1H/);
		expect(cup).not.toBeNull();
		expect(Number(cup![1])).toBe(8);
		tui.stop();
	});

	it("discards a pre-restart reply instead of trusting it", () => {
		// Mirror ordering of the dropped-reply case: probe A's late reply
		// arrives (pre-restart column tag, row 3) while probe B's own reply
		// is dropped. Trusting the stale row would anchor at 3 (CUP row 4)
		// and overwrite pulled-back history; attribution must discard it,
		// retry, and with the retry also unanswered fall back to the
		// accumulated pull bound 3 + 8 = 11 (CUP row 12).
		const { terminal, tui, renderScheduler, writes } = startRig();
		terminal.resize(40, 20);
		renderScheduler.settle(); // exit the resize alt borrow, start probe A
		terminal.resize(40, 18); // mid-probe restart: cancels A, starts a new borrow
		renderScheduler.settle(); // exit the second borrow, start probe B
		terminal.sendInput("\x1b[4;17R"); // A's late reply: pre-restart tag, discarded
		writes.length = 0;
		renderScheduler.settle(); // B's timeout: no valid reply -> one bounded retry
		expect(writes.join("")).toContain("\x1b[6n");
		expect(writes.join("")).not.toMatch(/\x1b\[\d+;1H/);
		renderScheduler.settle(); // retry timeout: conservative fallback
		const repaint = writes.join("");
		const cup = repaint.match(/\x1b\[(\d+);1H/);
		expect(cup).not.toBeNull();
		expect(Number(cup![1])).toBe(12);
		tui.stop();
	});

	it("resolves from probe B's reply arriving during the retry window", () => {
		// Same mirror ordering, but the dropped-thought probe B answers during
		// the retry window: its column tag carries the post-restart epoch, so
		// it resolves the anchor eagerly instead of waiting for the timeout.
		const { terminal, tui, renderScheduler, writes } = startRig();
		terminal.resize(40, 20);
		renderScheduler.settle(); // exit the resize alt borrow, start probe A
		terminal.resize(40, 18); // mid-probe restart: cancels A, starts a new borrow
		renderScheduler.settle(); // exit the second borrow, start probe B
		terminal.sendInput("\x1b[4;17R"); // A's late reply: pre-restart tag, discarded
		renderScheduler.settle(); // B's timeout: no valid reply -> one bounded retry
		writes.length = 0;
		terminal.sendInput("\x1b[10;18R"); // B's own late reply: post-restart epoch
		const repaint = writes.join("");
		const cup = repaint.match(/\x1b\[(\d+);1H/);
		expect(cup).not.toBeNull();
		expect(Number(cup![1])).toBe(10);
		tui.stop();
	});

	it("rejects a pre-restart reply arriving during the retry window", () => {
		// Probe A (12 -> 14) stays outstanding through the restart (14 -> 20)
		// and both post-restart probes' replies are dropped; A's reply lands
		// only during the retry window. Its queue tag carries the pre-restart
		// epoch, so the retry timeout must not trust it (row 3 would repaint
		// over rows pulled by the second grow) and must use the accumulated
		// pull bound 3 + 8 = 11 (CUP row 12) instead.
		const { terminal, tui, renderScheduler, writes } = startRig();
		terminal.resize(40, 14);
		renderScheduler.settle(); // exit the resize alt borrow, start probe A
		terminal.resize(40, 20); // mid-probe restart: cancels A, starts a new borrow
		renderScheduler.settle(); // exit the second borrow, start probe B
		renderScheduler.settle(); // B's timeout: no reply -> one bounded retry
		terminal.sendInput("\x1b[4;17R"); // A's very late reply: pre-restart tag
		writes.length = 0;
		renderScheduler.settle(); // retry timeout: reject the stale row, use the bound
		const repaint = writes.join("");
		const cup = repaint.match(/\x1b\[(\d+);1H/);
		expect(cup).not.toBeNull();
		expect(Number(cup![1])).toBe(12);
		tui.stop();
	});

	it("recovers eager CPR resolution after a fully dropped transaction", () => {
		// Transaction one (12 -> 20) drops both its replies and resolves at
		// the conservative bound. Its dead request tags must not linger: a
		// later grow (20 -> 26) whose probe answers promptly would otherwise
		// shift the phantom tags, swallow its own valid reply as pre-restart,
		// and fall back below the real viewport — one dropped pair poisoning
		// every subsequent grow. The reply here must resolve eagerly at its
		// reported row 9 (CUP row 10).
		const { terminal, tui, renderScheduler, writes } = startRig();
		terminal.resize(40, 20);
		renderScheduler.settle(); // exit the resize alt borrow, start the CPR probe
		renderScheduler.settle(); // first timeout: no reply -> one bounded retry
		renderScheduler.settle(); // retry timeout: conservative fallback, tags retired
		renderScheduler.t = 1000; // step past the post-settle resize suppression
		terminal.resize(40, 26); // a later responsive grow
		renderScheduler.settle(); // exit the borrow, start a fresh probe
		writes.length = 0;
		terminal.sendInput("\x1b[10;19R"); // prompt reply: must resolve eagerly
		const repaint = writes.join("");
		const cup = repaint.match(/\x1b\[(\d+);1H/);
		expect(cup).not.toBeNull();
		expect(Number(cup![1])).toBe(10);
		tui.stop();
	});

	it("resolves eagerly from the retry's reply when the original was dropped", () => {
		// The original reply never arrives; the retry's own reply is exactly
		// attributable by its column tag and resolves the anchor immediately.
		const { terminal, tui, renderScheduler, writes } = startRig();
		terminal.resize(40, 20);
		renderScheduler.settle(); // exit the resize alt borrow, start the CPR probe
		renderScheduler.settle(); // first timeout: no reply -> one bounded retry
		writes.length = 0;
		terminal.sendInput("\x1b[8;18R"); // retry's reply: exact attribution
		const repaint = writes.join("");
		const cup = repaint.match(/\x1b\[(\d+);1H/);
		expect(cup).not.toBeNull();
		expect(Number(cup![1])).toBe(8);
		tui.stop();
	});

	it("does not reuse a live column tag when the pane narrows", () => {
		// Probe A tags column 17 and its retry column 18; a mid-probe narrow to
		// 3 columns collapses the span so a tagged probe would have to reuse
		// column 17 while A's tag is live — promoting A's delayed pre-restart
		// reply to the current epoch. The narrow probe must send no DSR at
		// all: an untagged reply could never be attributed, and its late
		// arrival would leak into keyboard input. A's late reply is discarded
		// by its old tag, and the timeout anchors at the accumulated pull
		// bound 3 + 8 = 11 (CUP row 12).
		const { terminal, tui, renderScheduler, writes } = startRig();
		terminal.resize(40, 20);
		renderScheduler.settle(); // exit the resize alt borrow, start probe A (col 17)
		renderScheduler.settle(); // A's timeout: no reply -> retry (col 18)
		terminal.resize(3, 18); // mid-probe narrow: span collapses below tagging
		writes.length = 0;
		renderScheduler.settle(); // exit the borrow: degenerate probe, no DSR sent
		expect(writes.join("")).not.toContain("\x1b[6n");
		terminal.sendInput("\x1b[4;17R"); // A's very late reply: old tag, discarded
		expect(writes.join("")).not.toMatch(/\x1b\[\d+;1H/);
		renderScheduler.settle(); // untagged probe's timeout: grow -> one bounded retry
		renderScheduler.settle(); // retry timeout: accumulated pull bound
		const repaint = writes.join("");
		const cup = repaint.match(/\x1b\[(\d+);1H/);
		expect(cup).not.toBeNull();
		expect(Number(cup![1])).toBe(12);
		tui.stop();
	});
});

// Regression coverage for the CPR probe's pre-erase stash on direct terminals:
// the stash (window + park offset) feeds both the `height - staleRows` anchor
// bound and the CPR-relative offset math, so a stale offset or a wiped stash
// silently disables the exact protections the stash exists to provide.
describe("resize anchor probe stash on a direct terminal", () => {
	useDirectTerminalEnv();

	it("zeroes the probe offset after the erase parks the cursor on the viewport top", () => {
		// A cursor marker in live row 4 parks the hardware cursor at offset 4
		// from the viewport top. The SIGWINCH-side erase re-parks the cursor on
		// the viewport's top row, so the settled CPR (row 4 -> viewport top 3)
		// must anchor at 3 (CUP row 4). Carrying the stale offset into the probe
		// would compute 3 - 4 and anchor the repaint at 0, overwriting the three
		// still-visible committed rows.
		const { terminal, tui, renderScheduler, writes } = startRig(4);
		terminal.resize(40, 11);
		renderScheduler.settle(); // exit the resize alt borrow, start the CPR probe
		writes.length = 0;
		terminal.sendInput("\x1b[4;17R"); // parked cursor: viewport top, screen row 3
		const repaint = writes.join("");
		const cup = repaint.match(/\x1b\[(\d+);1H/);
		expect(cup).not.toBeNull();
		expect(Number(cup![1])).toBe(4);
		tui.stop();
	});

	it("keeps the stash when a mid-probe SIGWINCH restarts the transaction", () => {
		// A resize landing after the settle but before the CPR reply restarts
		// the transaction with the live window already stashed and emptied. The
		// restart must not overwrite the stash with the empty window: the second
		// probe still needs the 8-row snapshot so its `height - staleRows` bound
		// (6 - 8 -> 0) overrides the reported row. A wiped stash would bound
		// nothing (staleRows 0) and anchor at the reported row 3, scroll-pushing
		// the repaint into scrollback — the original duplication bug.
		const { terminal, tui, renderScheduler, writes } = startRig();
		terminal.resize(40, 11);
		renderScheduler.settle(); // exit the resize alt borrow, start the CPR probe
		terminal.resize(40, 6); // mid-probe restart: cancels the probe, window already []
		renderScheduler.settle(); // exit the second borrow, start the second probe
		writes.length = 0;
		terminal.sendInput("\x1b[4;17R"); // canceled first probe's delayed reply: discarded
		terminal.sendInput("\x1b[4;18R"); // second probe's reply: parked cursor still on row 3
		const repaint = writes.join("");
		const cup = repaint.match(/\x1b\[(\d+);1H/);
		expect(cup).not.toBeNull();
		expect(Number(cup![1])).toBe(1);
		tui.stop();
	});

	it("discards the canceled probe's delayed reply after a mid-probe restart", () => {
		// The restart cancels the first probe, but its CSI 6n reply is still in
		// flight and reports the cursor row from before the second resize.
		// Matching it to the second probe would anchor the settled repaint at
		// the pre-restart row 3 (CUP row 4) and drop the real reply; its
		// pre-restart column tag identifies it exactly, so it is discarded and
		// the second reply anchors at row 1 (CUP row 2). A 2-row window keeps
		// the height-staleRows bound (6 - 2 = 4) from masking the difference.
		const { terminal, tui, provider, renderScheduler, writes } = startRig();
		provider.liveRows = 2;
		tui.requestRender(true);
		terminal.resize(40, 11);
		renderScheduler.settle(); // exit the resize alt borrow, start the CPR probe
		terminal.resize(40, 6); // mid-probe restart: first reply still outstanding
		renderScheduler.settle(); // exit the second borrow, start the second probe
		writes.length = 0;
		terminal.sendInput("\x1b[4;17R"); // stale: cursor row before the second resize
		expect(writes.join("")).not.toMatch(/\x1b\[\d+;1H/);
		terminal.sendInput("\x1b[2;18R"); // real: parked cursor after the second resize
		const repaint = writes.join("");
		const cup = repaint.match(/\x1b\[(\d+);1H/);
		expect(cup).not.toBeNull();
		expect(Number(cup![1])).toBe(2);
		tui.stop();
	});

	it("resolves the replacement probe's reply when the canceled reply was dropped", () => {
		// If the canceled probe's reply never arrives, the replacement probe's
		// own reply is still exactly attributable by its column tag and
		// resolves the anchor immediately: reply row 1 anchors at 1 (CUP row
		// 2), not the pre-resize top 3.
		const { terminal, tui, provider, renderScheduler, writes } = startRig();
		provider.liveRows = 2;
		tui.requestRender(true);
		terminal.resize(40, 11);
		renderScheduler.settle(); // exit the resize alt borrow, start the CPR probe
		terminal.resize(40, 6); // mid-probe restart: canceled reply never arrives
		renderScheduler.settle(); // exit the second borrow, start the second probe
		writes.length = 0;
		terminal.sendInput("\x1b[2;18R"); // the second probe's own reply: exact attribution
		const repaint = writes.join("");
		const cup = repaint.match(/\x1b\[(\d+);1H/);
		expect(cup).not.toBeNull();
		expect(Number(cup![1])).toBe(2);
		tui.stop();
	});

	it("snapshots a legitimately empty viewport on a fresh transaction", () => {
		// A completed resize populates the stash; a later normal frame may
		// legitimately render an empty viewport. The next fresh transaction must
		// snapshot that empty window: keeping the old 8-row stash would clamp
		// the anchor with `height - staleRows` rows that are no longer on
		// screen (6 - 8 -> 0) and erase committed rows above the real (empty)
		// viewport. With the refreshed stash the anchor stays at the viewport
		// top (row 3, CUP row 4).
		const { terminal, tui, provider, renderScheduler, writes } = startRig();
		terminal.resize(40, 11);
		renderScheduler.settle(); // exit the resize alt borrow, start the CPR probe
		renderScheduler.settle(); // probe timeout path -> settled repaint populates the stash
		renderScheduler.t = 1000; // step past the post-settle resize suppression
		provider.liveRows = 0;
		tui.requestRender(true); // normal frame with an empty viewport
		terminal.resize(40, 6); // fresh transaction: no probe in flight
		renderScheduler.settle();
		writes.length = 0;
		renderScheduler.settle();
		const repaint = writes.join("");
		const cup = repaint.match(/\x1b\[(\d+);1H/);
		expect(cup).not.toBeNull();
		expect(Number(cup![1])).toBe(4);
		tui.stop();
	});
});

// Direct-terminal grow coverage: the height-staleRows clamp is only an upper
// bound, so a stale pre-restart row (or the pre-resize top) can anchor over
// history pulled down by a grow; grows must retry, discard ambiguous swallows,
// and fall back to the accumulated pull bound under the clamp.
describe("resize anchor probe on a direct-terminal grow", () => {
	useDirectTerminalEnv();

	it("discards a pre-restart reply and retries on a grow", () => {
		// Probe A's late reply (pre-restart row 3) arrives while probe B's own
		// reply is dropped. On a grow the clamp cannot save a stale row that
		// is too small, so the reply is discarded by its pre-restart tag, the
		// timeout retries, and with the retry also unanswered anchors at the
		// accumulated pull bound min(3 + 8, 20 - 8) = 11 (CUP row 12).
		const { terminal, tui, renderScheduler, writes } = startRig();
		terminal.resize(40, 16);
		renderScheduler.settle(); // exit the resize alt borrow, start probe A
		terminal.resize(40, 20); // mid-probe restart: cancels A
		renderScheduler.settle(); // exit the second borrow, start probe B
		terminal.sendInput("\x1b[4;17R"); // A's late reply: pre-restart tag, discarded
		writes.length = 0;
		renderScheduler.settle(); // B's timeout: no valid reply on a grow -> retry
		expect(writes.join("")).toContain("\x1b[6n");
		expect(writes.join("")).not.toMatch(/\x1b\[\d+;1H/);
		renderScheduler.settle(); // retry timeout: pull bound under the clamp
		const repaint = writes.join("");
		const cup = repaint.match(/\x1b\[(\d+);1H/);
		expect(cup).not.toBeNull();
		expect(Number(cup![1])).toBe(12);
		tui.stop();
	});

	it("anchors a CPR-less grow at the pull bound under the clamp", () => {
		// Grow 12 -> 20 with every reply dropped: the pre-resize top 3 is
		// stale-low once the grow pulled history down. The final timeout must
		// anchor at min(3 + 8, 20 - 8) = 11 (CUP row 12).
		const { terminal, tui, renderScheduler, writes } = startRig();
		terminal.resize(40, 20);
		renderScheduler.settle(); // exit the resize alt borrow, start the CPR probe
		renderScheduler.settle(); // first timeout: no reply -> one bounded retry
		writes.length = 0;
		renderScheduler.settle(); // retry timeout: pull bound under the clamp
		const repaint = writes.join("");
		const cup = repaint.match(/\x1b\[(\d+);1H/);
		expect(cup).not.toBeNull();
		expect(Number(cup![1])).toBe(12);
		tui.stop();
	});

	it("discards a retired transaction's late replies exactly", () => {
		// Transaction one (12 -> 16) drops both its replies and resolves at
		// the pull bound; its retired replies then arrive during the next
		// grow's probe window. Their column tags identify them exactly, so
		// they are discarded — eagerly resolving from one would anchor the new
		// grow at the old row over pulled-back history — and the new probe's
		// own reply resolves at its reported row 12 under the clamp
		// min(12, 20 - 8) = 12 (CUP row 13).
		const { terminal, tui, renderScheduler, writes } = startRig();
		terminal.resize(40, 16);
		renderScheduler.settle(); // exit the resize alt borrow, start the CPR probe
		renderScheduler.settle(); // first timeout: no reply -> one bounded retry
		renderScheduler.settle(); // retry timeout: pull bound, requests dead
		renderScheduler.t = 1000; // step past the post-settle resize suppression
		terminal.resize(40, 20); // the next grow arms a fresh tagged probe
		renderScheduler.settle(); // exit the borrow, start the fresh probe
		writes.length = 0;
		terminal.sendInput("\x1b[4;17R"); // dead probe's late reply: discarded by tag
		expect(writes.join("")).not.toMatch(/\x1b\[\d+;1H/);
		terminal.sendInput("\x1b[4;18R"); // dead retry's late reply: discarded by tag
		expect(writes.join("")).not.toMatch(/\x1b\[\d+;1H/);
		terminal.sendInput("\x1b[13;19R"); // the fresh probe's own reply
		const repaint = writes.join("");
		const cup = repaint.match(/\x1b\[(\d+);1H/);
		expect(cup).not.toBeNull();
		expect(Number(cup![1])).toBe(13);
		tui.stop();
	});
});
