import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	CURSOR_MARKER,
	type TerminalFramePlan,
	type TerminalFrameProvider,
	TUI,
	type ViewportSize,
} from "@oh-my-pi/pi-tui";
import { withoutTerminalMultiplexer } from "./helpers/terminal-multiplexer";
import { VirtualTerminal } from "./virtual-terminal";

// Regression coverage for the end-of-turn viewport anchor resync (the "text
// folding" cure): streaming can scroll the physical screen without the ledger
// knowing (ConPTY pending-wrap materialization, image rows taller than the
// reserved band, multiplexer REP expansion), so `#providerViewportTop` goes
// stale and every later frame repaints at the wrong physical offset. Turn end
// fires the same tagged DSR round trip the settled resize uses and re-anchors
// the viewport from the parked cursor's reported row.
//
// Rig geometry (24 rows): 3 committed history rows + 14 live viewport rows
// park the anchor at row 3 (0-based) with the hidden cursor at 1-based row 4,
// so a drifted reply row of 2 implies trueTop = 1.

const COMMITTED = ["committed-0", "committed-1", "committed-2"];
const DSR_PROBE = "\x1b[6n";

class FullFrameProvider implements TerminalFrameProvider {
	history: TerminalFramePlan["history"];
	markerRow: number | undefined;
	liveRows = 14;

	renderFrame(viewport: ViewportSize): TerminalFramePlan {
		const rows = Array.from({ length: this.liveRows }, (_, i) => `live-${i}`);
		if (this.markerRow !== undefined) rows[this.markerRow] = `${rows[this.markerRow]}${CURSOR_MARKER}`;
		return {
			history: this.history,
			viewport: rows.slice(-Math.min(this.liveRows, viewport.rows)),
		};
	}
	renderResizeFrame(viewport: ViewportSize): readonly string[] {
		return Array.from({ length: Math.min(8, viewport.rows) }, (_, i) => `resize-${i}`);
	}
	acknowledgeHistory(): void {
		this.history = undefined;
	}
}

/** Windows ConPTY host: re-homes the cursor on its own repaints (column 1). */
class ConPtyHostTerminal extends VirtualTerminal {
	readonly hostOwnsGridOnResize = true;
}

class ResizeScheduler {
	#pending = new Set<() => void>();
	now(): number {
		return Date.now();
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

function startRig(options: { markerRow?: number; terminal?: VirtualTerminal } = {}) {
	const terminal = options.terminal ?? new VirtualTerminal(40, 24);
	const provider = new FullFrameProvider();
	provider.markerRow = options.markerRow;
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
	tui.start();
	return { terminal, tui, provider, renderScheduler, writes };
}

/** Drain the initial history frame and its ack pump so the anchor is parked. */
function parkInitialFrame(renderScheduler: ResizeScheduler): void {
	renderScheduler.settle();
	renderScheduler.settle();
}

function parkedTag(writes: string[]): string {
	const joined = writes.join("");
	const tag = joined.match(/\x1b\[(\d+)G\x1b\[6n/);
	expect(tag).not.toBeNull();
	return tag![1];
}

withoutTerminalMultiplexer();

describe("end-of-turn viewport anchor resync", () => {
	let previousTerm: string | undefined;

	beforeEach(() => {
		previousTerm = Bun.env.TERM;
		Bun.env.TERM = "xterm-256color";
	});

	afterEach(() => {
		if (previousTerm === undefined) delete Bun.env.TERM;
		else Bun.env.TERM = previousTerm;
	});

	it("re-anchors a drifted viewport and forces a viewport repaint", () => {
		const { terminal, tui, renderScheduler, writes } = startRig();
		try {
			parkInitialFrame(renderScheduler);
			writes.length = 0;

			tui.resyncViewportAnchor();
			// The probe parks a tagged column and restores the cursor to column 1.
			const tag = parkedTag(writes);
			expect(tag).toBe("17");
			expect(writes.join("")).toContain(`\x1b[${tag}G\x1b[6n\x1b[1G`);

			// The terminal scrolled two rows without telling the ledger: the
			// parked cursor's logical row moved from 4 to 2, so trueTop = 1.
			terminal.sendInput(`\x1b[2;${tag}R`);
			const repaint = writes.slice(1).join("");
			expect(repaint).not.toBe("");
			const cup = repaint.match(/\x1b\[(\d+);1H/);
			expect(cup).not.toBeNull();
			expect(Number(cup![1])).toBe(2);
		} finally {
			tui.stop();
		}
	});

	it("does nothing when the reply matches the parked anchor", async () => {
		const { terminal, tui, renderScheduler, writes } = startRig();
		try {
			parkInitialFrame(renderScheduler);
			writes.length = 0;

			tui.resyncViewportAnchor();
			expect(writes).toHaveLength(1);
			// The virtual terminal answers the DSR itself (microtask) from the
			// parked cursor: the reported row implies trueTop = 3 = expectedTop,
			// so no repaint may be requested at all.
			await terminal.flush();
			renderScheduler.settle();
			expect(writes).toHaveLength(1);
		} finally {
			tui.stop();
		}
	});

	it("skips the probe on a ConPTY host, whose reply is unattributable", () => {
		const { tui, renderScheduler, writes } = startRig({ terminal: new ConPtyHostTerminal(40, 24) });
		try {
			parkInitialFrame(renderScheduler);
			writes.length = 0;

			tui.resyncViewportAnchor();
			expect(writes.join("")).not.toContain(DSR_PROBE);
		} finally {
			tui.stop();
		}
	});

	it("drops the record at the timeout and burns only the one tag column", () => {
		const { terminal, tui, renderScheduler, writes } = startRig();
		try {
			parkInitialFrame(renderScheduler);
			writes.length = 0;

			tui.resyncViewportAnchor();
			expect(writes).toHaveLength(1);
			renderScheduler.settle(); // probe timeout: record dropped, nothing repaints
			expect(writes).toHaveLength(1);

			// The dropped record frees the slot: a second probe parks a fresh
			// tag (column 17 stays burned — dead tags are never reclaimed) and
			// sends a new DSR.
			tui.resyncViewportAnchor();
			expect(writes).toHaveLength(2);
			expect(writes.join("")).toContain("\x1b[18G\x1b[6n\x1b[1G");

			// The first probe's late reply must not be misattributed: matching
			// by epoch alone would accept it (both probes parked under epoch 0)
			// and repaint from a stale row; only the column identifies it.
			terminal.sendInput("\x1b[2;17R");
			expect(writes).toHaveLength(2);

			// The live probe still owns its record and resolves normally.
			terminal.sendInput("\x1b[2;18R");
			const repaint = writes.slice(2).join("");
			const cup = repaint.match(/\x1b\[(\d+);1H/);
			expect(cup).not.toBeNull();
			expect(Number(cup![1])).toBe(2);
		} finally {
			tui.stop();
		}
	});

	it("converts the reply through the marker's parked-cursor offset", () => {
		const { terminal, tui, renderScheduler, writes } = startRig({ markerRow: 2 });
		try {
			parkInitialFrame(renderScheduler);
			writes.length = 0;

			// The hardware-cursor marker parks the cursor on viewport row 2
			// (1-based row 6), i.e. `parkedOffset = 2` below the anchor. The
			// naive `reportedRow - 1` would read the reply as trueTop = 3.
			tui.resyncViewportAnchor();
			const tag = parkedTag(writes);

			// The whole grid scrolled two rows up: trueTop = 1, so the reply
			// row is trueTop + parkedOffset + 1 = 4.
			terminal.sendInput(`\x1b[4;${tag}R`);
			const repaint = writes.slice(1).join("");
			const cup = repaint.match(/\x1b\[(\d+);1H/);
			expect(cup).not.toBeNull();
			expect(Number(cup![1])).toBe(2);
		} finally {
			tui.stop();
		}
	});
});

// Tier-2 trigger: a full-rewrite frame whose write scrolls the screen
// (`pushed > 0`) can scroll beyond the ledger's arithmetic mid-turn
// (ConPTY pending-wrap, ambiguous-width glyphs), and the turn-end probe
// only repairs at yield — so a scrolled frame re-fires the same tagged
// DSR probe, throttled to one per #RESYNC_MIN_INTERVAL_MS. Rig geometry:
// 14 live rows + 8 appended history rows overflow the 24-row screen by
// exactly one row (pushed = 1) per scrolled frame.
function scrolledBatch(id: number, prefix: string, count = 8): TerminalFramePlan["history"] {
	return { id, rows: Array.from({ length: count }, (_, i) => `${prefix}-${i}`) };
}

/** Standalone probe writes (the frame write never contains a tagged DSR). */
function probeTags(writes: string[]): number[] {
	return writes
		.filter(data => /\x1b\[\d+G\x1b\[6n\x1b\[1G/.test(data))
		.map(data => Number(data.match(/\x1b\[(\d+)G\x1b\[6n/)![1]));
}

describe("scroll-frame tier-2 anchor resync", () => {
	let previousTerm: string | undefined;

	beforeEach(() => {
		previousTerm = Bun.env.TERM;
		Bun.env.TERM = "xterm-256color";
	});

	afterEach(() => {
		if (previousTerm === undefined) delete Bun.env.TERM;
		else Bun.env.TERM = previousTerm;
	});

	it("fires the tagged probe after a full-rewrite frame that scrolled (pushed > 0)", () => {
		const { tui, provider, renderScheduler, writes } = startRig();
		try {
			parkInitialFrame(renderScheduler);
			writes.length = 0;

			// Appending 8 history rows to 14 live rows overflows the 24-row
			// screen: the write scrolls once, so the probe must be scheduled
			// (visible tagged-DSR write) right after the frame.
			provider.history = scrolledBatch(2, "batch2");
			tui.requestRender(true);
			renderScheduler.settle();
			expect(probeTags(writes)).toEqual([17]);
			expect(writes.join("")).toContain("\x1b[17G\x1b[6n\x1b[1G");

			// The ack pump settles afterwards: its frame does not scroll and
			// the outstanding record needs no second probe.
			renderScheduler.settle();
			expect(probeTags(writes)).toEqual([17]);
		} finally {
			tui.stop();
		}
	});

	it("does not fire on a frame that did not scroll (pushed = 0)", () => {
		const { tui, provider, renderScheduler, writes } = startRig();
		try {
			parkInitialFrame(renderScheduler);
			writes.length = 0;

			// 3 appended rows keep the write inside the screen: full rewrite,
			// but pushed = 0, so no probe.
			provider.history = scrolledBatch(2, "batch2", 3);
			tui.requestRender(true);
			renderScheduler.settle();
			renderScheduler.settle();
			expect(probeTags(writes)).toEqual([]);
		} finally {
			tui.stop();
		}
	});

	it("throttles back-to-back scrolled frames to one probe per min interval", () => {
		const realNow = Date.now;
		let fakeNow = realNow();
		Date.now = () => fakeNow;
		const { tui, provider, renderScheduler, writes } = startRig();
		try {
			parkInitialFrame(renderScheduler);
			writes.length = 0;

			provider.history = scrolledBatch(2, "batch2");
			tui.requestRender(true);
			renderScheduler.settle();
			expect(probeTags(writes)).toEqual([17]);

			// A second scrolled frame inside the interval is suppressed, even
			// though the first record has meanwhile timed out.
			provider.history = scrolledBatch(3, "batch3");
			tui.requestRender(true);
			renderScheduler.settle();
			expect(probeTags(writes)).toEqual([17]);

			// Past #RESYNC_MIN_INTERVAL_MS the next scrolled frame probes
			// again, parking the next tag column.
			fakeNow += 501;
			provider.history = scrolledBatch(4, "batch4");
			tui.requestRender(true);
			renderScheduler.settle();
			expect(probeTags(writes)).toEqual([17, 18]);
		} finally {
			Date.now = realNow;
			tui.stop();
		}
	});

	it("leaves the turn-end probe unthrottled and functional after a tier-2 probe", () => {
		const { terminal, tui, provider, renderScheduler, writes } = startRig();
		try {
			parkInitialFrame(renderScheduler);
			writes.length = 0;

			// A scrolled frame fires the tier-2 probe (tag 17).
			provider.history = scrolledBatch(2, "batch2");
			tui.requestRender(true);
			renderScheduler.settle();
			expect(probeTags(writes)).toEqual([17]);

			// The turn-end probe is never throttled: within the interval it
			// still cancels the outstanding tier-2 record, parks the next
			// column (18), and re-arms immediately.
			tui.resyncViewportAnchor();
			expect(probeTags(writes)).toEqual([17, 18]);

			// Its reply still re-anchors and forces the viewport repaint: the
			// reply row 2 implies trueTop = 1, which has drifted from the
			// expected anchor, so the viewport re-anchors to row 1 (CUP 2).
			terminal.sendInput("\x1b[2;18R");
			renderScheduler.settle();
			const repaint = writes.slice(3).join("");
			const cup = repaint.match(/\x1b\[(\d+);1H/);
			expect(cup).not.toBeNull();
			expect(Number(cup![1])).toBe(2);
		} finally {
			tui.stop();
		}
	});
});
