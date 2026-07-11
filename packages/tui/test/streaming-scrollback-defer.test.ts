import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	type Component,
	type NativeScrollbackCommittedRows,
	type NativeScrollbackLiveRegion,
	TUI,
} from "@pk-nerdsaver-ai/pi-tui";
import { VirtualTerminal } from "./virtual-terminal";

class LineList implements Component {
	#lines: string[];

	constructor(lines: string[]) {
		this.#lines = [...lines];
	}

	invalidate(): void {}

	render(width: number): string[] {
		return this.#lines.map(line => line.slice(0, width));
	}

	setLines(lines: string[]): void {
		this.#lines = [...lines];
	}
}

class LiveLineList extends LineList implements NativeScrollbackLiveRegion {
	getNativeScrollbackLiveRegionStart(): number | undefined {
		return 0;
	}
}

/**
 * A live block whose rendered rows only grow at the bottom and never re-layout
 * (a streaming assistant reply). Its entire body is append-only, so scrolled-off
 * head rows are safe to commit to native scrollback. `Infinity` is clamped to
 * the rendered length by TUI's aggregation.
 */
class AppendOnlyLiveLineList extends LiveLineList {
	getNativeScrollbackCommitSafeEnd(): number | undefined {
		return Number.POSITIVE_INFINITY;
	}
}

/**
 * Records the engine's committed-row claim visible at each render() call.
 * Pins the propagation contract: the claim must be fed *before* render so the
 * child (e.g. the transcript container) can skip re-deriving blocks that
 * already live in immutable native scrollback.
 */
class CommittedRowsProbe extends AppendOnlyLiveLineList implements NativeScrollbackCommittedRows {
	#committedRows = 0;
	committedRowsAtRender: number[] = [];

	setNativeScrollbackCommittedRows(rows: number): void {
		this.#committedRows = rows;
	}

	override render(width: number): string[] {
		this.committedRowsAtRender.push(this.#committedRows);
		return super.render(width);
	}
}

/**
 * A live block that is DURABLE but not byte-stable: it reports a snapshot-safe
 * end (its whole body is permanent content) but no commit-safe end, and it
 * re-lays-out an interior row on every render (a streaming markdown table whose
 * columns re-align as rows arrive). Its scrolled-off head must still reach
 * native scrollback — frozen at its scroll-off snapshot — instead of being
 * dropped, and the later drift of an already-committed row must NOT spray
 * duplicate snapshots into history.
 */
class SnapshotLiveLineList extends LineList implements NativeScrollbackLiveRegion {
	getNativeScrollbackLiveRegionStart(): number | undefined {
		return 0;
	}
	getNativeScrollbackSnapshotSafeEnd(): number | undefined {
		return Number.POSITIVE_INFINITY;
	}
}

async function settle(term: VirtualTerminal): Promise<void> {
	const nextTick = Promise.withResolvers<void>();
	process.nextTick(nextTick.resolve);
	await nextTick.promise;
	await Bun.sleep(40);
	await term.flush();
}

// The non-multiplexer resize fast path paints the viewport at once and defers
// the authoritative full replay (the ED3 scrollback rebuild) until the drag has
// been quiet for the resize settle window (120 ms). This is an integration test
// against the real render scheduler, so the window is driven with a real delay.
async function settleResize(term: VirtualTerminal): Promise<void> {
	await Bun.sleep(160);
	await settle(term);
}

function capture(term: VirtualTerminal): string[] {
	const writes: string[] = [];
	const realWrite = term.write.bind(term);
	(term as unknown as { write: (s: string) => void }).write = (data: string) => {
		writes.push(data);
		realWrite(data);
	};
	return writes;
}

function overrideProbe(term: VirtualTerminal, answer: boolean | undefined): void {
	(term as unknown as { isNativeViewportAtBottom: () => boolean | undefined }).isNativeViewportAtBottom = () => answer;
}

const ERASE_SCROLLBACK = /\x1b\[3J/g;

function eraseScrollbackCount(writes: string[]): number {
	return writes.join("").match(ERASE_SCROLLBACK)?.length ?? 0;
}

function rows(prefix: string, count: number): string[] {
	return Array.from({ length: count }, (_, i) => `${prefix}${i}`);
}

describe("streaming scrollback defer", () => {
	let savedTerminalEnv: Record<string, string | undefined> = {};
	beforeEach(() => {
		// A resize on Warp takes the in-place path (no ED3), so neutralize the
		// ambient terminal identity to keep the direct-terminal scrollback
		// assertions below deterministic on any dev machine.
		for (const key of ["TERM_PROGRAM", "PI_TUI_RESIZE_IN_PLACE"]) {
			savedTerminalEnv[key] = Bun.env[key];
			delete Bun.env[key];
		}
	});
	afterEach(() => {
		for (const key in savedTerminalEnv) {
			const value = savedTerminalEnv[key];
			if (value === undefined) delete Bun.env[key];
			else Bun.env[key] = value;
		}
		savedTerminalEnv = {};
	});

	it("commits the live-region head to native scrollback without loss", async () => {
		if (process.platform === "win32") return;
		const term = new VirtualTerminal(20, 4);
		overrideProbe(term, undefined);
		const tui = new TUI(term);
		const sealed = new LineList(rows("prior-", 12));
		const live = new LiveLineList([]);

		try {
			tui.addChild(sealed);
			tui.addChild(live);
			tui.start();
			await settle(term);

			const writes = capture(term);

			live.setLines(rows("think-", 6));
			tui.requestRender();
			await settle(term);

			// The live block's head (think-0/think-1) scrolls above the 4-row
			// viewport. The engine floor commits every row that scrolls off, so the
			// head reaches native scrollback instead of vanishing — committed
			// nowhere, painted nowhere (the loss bug). No ED3 erase.
			expect(eraseScrollbackCount(writes)).toBe(0);
			expect(term.getScrollBuffer().map(line => line.trimEnd())).toEqual([
				...rows("prior-", 12),
				...rows("think-", 6),
			]);

			// Append-only growth: the committed head is byte-identical, so it never
			// re-anchors or duplicates; the new tail just extends.
			live.setLines(rows("think-", 8));
			tui.requestRender();
			await settle(term);

			const buffer = term.getScrollBuffer().map(line => line.trimEnd());
			expect(eraseScrollbackCount(writes)).toBe(0);
			expect(buffer).toEqual([...rows("prior-", 12), ...rows("think-", 8)]);
		} finally {
			tui.stop();
		}
	});

	it("commits a tall all-live block's scrolled head to native scrollback", async () => {
		if (process.platform === "win32") return;
		const term = new VirtualTerminal(20, 4);
		overrideProbe(term, undefined);
		const tui = new TUI(term);
		// The only block is the live one (liveRegionStart === 0). Rows that scroll
		// above the viewport are committed by the engine floor so they reach native
		// scrollback rather than vanishing; the block grows append-only here, so no
		// committed row is ever rewritten (no duplication).
		const live = new LiveLineList([]);

		try {
			tui.addChild(live);
			tui.start();
			await settle(term);

			const writes = capture(term);

			live.setLines(rows("tool-", 10));
			tui.requestRender();
			await settle(term);

			// tool-0..tool-5 scrolled above the 4-row viewport and reach native
			// scrollback; tool-6..tool-9 stay in the viewport. Nothing is lost.
			expect(eraseScrollbackCount(writes)).toBe(0);
			expect(term.getScrollBuffer().map(line => line.trimEnd())).toEqual(rows("tool-", 10));
		} finally {
			tui.stop();
		}
	});

	it("commits the scrolled-off head of an append-only live block to native scrollback", async () => {
		if (process.platform === "win32") return;
		const term = new VirtualTerminal(20, 4);
		overrideProbe(term, undefined);
		const tui = new TUI(term);
		// The only block is the live one (liveRegionStart === 0), but unlike a
		// volatile tool preview it is append-only (a streaming assistant reply).
		// Rows that scroll above the viewport must reach native scrollback rather
		// than vanishing — committed nowhere, repainted nowhere.
		const live = new AppendOnlyLiveLineList([]);

		try {
			tui.addChild(live);
			tui.start();
			await settle(term);

			const writes = capture(term);

			live.setLines(rows("text-", 10));
			tui.requestRender();
			await settle(term);

			// text-0..text-5 scrolled above the 4-row viewport; because the block
			// is append-only they enter native scrollback (via `\r\n`, no ED3
			// erase) instead of being dropped like the volatile case above.
			expect(eraseScrollbackCount(writes)).toBe(0);
			expect(term.getScrollBuffer().map(line => line.trimEnd())).toEqual(rows("text-", 10));
		} finally {
			tui.stop();
		}
	});

	it("recommits fresh rows without loss when the live region is replaced wholesale", async () => {
		if (process.platform === "win32") return;
		const term = new VirtualTerminal(24, 4);
		overrideProbe(term, undefined);
		const tui = new TUI(term);
		const sealed = new LineList(rows("prior-", 12));
		const live = new LiveLineList([]);

		try {
			tui.addChild(sealed);
			tui.addChild(live);
			tui.start();
			await settle(term);

			const writes = capture(term);

			live.setLines(rows("pending-stale-", 10));
			tui.requestRender();
			await settle(term);

			live.setLines(rows("running-fresh-", 10));
			tui.requestRender();
			await settle(term);

			// The volatile block's head force-committed while it overflowed, then was
			// replaced wholesale. The committed-prefix audit re-anchors at the first
			// diverged row and recommits the fresh content: every running-fresh row
			// reaches the tape (no loss). A stale pending-stale copy may stay frozen in
			// native scrollback — duplication, never loss — which a full repaint (ED3
			// on a real resize / Ctrl+L) clears; no ED3 fires during streaming.
			const buffer = term.getScrollBuffer().map(line => line.trimEnd());
			expect(eraseScrollbackCount(writes)).toBe(0);
			for (const row of rows("running-fresh-", 10)) expect(buffer).toContain(row);
		} finally {
			tui.stop();
		}
	});

	it("keeps the topmost live seam and recommits fresh rows when a lower sibling also reports one", async () => {
		if (process.platform === "win32") return;
		const term = new VirtualTerminal(24, 4);
		overrideProbe(term, undefined);
		const tui = new TUI(term);
		const sealed = new LineList(rows("prior-", 12));
		// Volatile live transcript block: seam at 0, no commit-safe end.
		const live = new LiveLineList([]);
		// Status loader below the transcript: also reports a seam. Commits are
		// prefix-only, so the engine must keep the TOPMOST seam — letting the
		// lower sibling's seam win would move the boundary past the transcript's
		// still-mutable rows.
		const loader = new LiveLineList(["Working..."]);

		try {
			tui.addChild(sealed);
			tui.addChild(live);
			tui.addChild(loader);
			tui.start();
			await settle(term);

			const writes = capture(term);

			live.setLines(rows("pending-stale-", 10));
			tui.requestRender();
			await settle(term);

			live.setLines(rows("running-fresh-", 10));
			tui.requestRender();
			await settle(term);

			// Fresh content recommits with no loss after the wholesale replace; a
			// stale copy may remain frozen above it (duplication, never loss). No ED3.
			const buffer = term.getScrollBuffer().map(line => line.trimEnd());
			expect(eraseScrollbackCount(writes)).toBe(0);
			for (const row of rows("running-fresh-", 10)) expect(buffer).toContain(row);
		} finally {
			tui.stop();
		}
	});

	it("commits scrolled streaming rows to history exactly once without ED3", async () => {
		if (process.platform === "win32") return;
		const term = new VirtualTerminal(40, 10);
		overrideProbe(term, undefined);
		const tui = new TUI(term);
		const component = new LineList([...rows("init-", 10), "prompt"]);

		try {
			tui.addChild(component);
			tui.start();
			await settle(term);

			const writes = capture(term);

			// Grow content past the viewport — without a live-region seam the
			// scrolled-off rows commit to native history as they pass the seam
			// (shell semantics): exactly once, in frame order, with no ED3.
			const frame1 = [...rows("init-", 10), ...rows("stream-", 30), "prompt"];
			component.setLines(frame1);
			tui.requestRender();
			await settle(term);

			expect(eraseScrollbackCount(writes)).toBe(0);
			let buffer = term.getScrollBuffer().map(line => line.trimEnd());
			expect(buffer).toEqual(frame1.slice(0, buffer.length));
			expect(
				term
					.getViewport()
					.map(line => line.trim())
					.at(-1),
			).toBe("prompt");

			// Grow further — history extends append-only: still no ED3, no
			// duplicates, and previously committed rows are untouched.
			const frame2 = [...rows("init-", 10), ...rows("stream-", 50), "prompt"];
			component.setLines(frame2);
			tui.requestRender();
			await settle(term);

			expect(eraseScrollbackCount(writes)).toBe(0);
			buffer = term.getScrollBuffer().map(line => line.trimEnd());
			expect(buffer).toEqual(frame2.slice(0, buffer.length));
			expect(buffer.length).toBeGreaterThan(frame1.length - 10);
		} finally {
			tui.stop();
		}
	});

	it("does not emit ED3 during streaming", async () => {
		if (process.platform === "win32") return;
		const term = new VirtualTerminal(40, 10);
		overrideProbe(term, undefined);
		const tui = new TUI(term);
		const component = new LineList([...rows("init-", 10), "prompt"]);

		try {
			tui.addChild(component);
			tui.start();
			await settle(term);

			const writes = capture(term);

			component.setLines([...rows("grow-", 30), "prompt"]);
			tui.requestRender();
			await settle(term);

			expect(eraseScrollbackCount(writes)).toBe(0);

			tui.requestRender();
			await settle(term);

			expect(eraseScrollbackCount(writes)).toBe(0);
			expect(
				term
					.getViewport()
					.map(line => line.trim())
					.at(-1),
			).toBe("prompt");
		} finally {
			tui.stop();
		}
	});

	it("does not duplicate committed sealed rows when the live region collapses mid-stream", async () => {
		if (process.platform === "win32") return;
		const term = new VirtualTerminal(20, 4);
		overrideProbe(term, undefined);
		const tui = new TUI(term);
		// Sealed prefix above a live block: growth commits the sealed rows to
		// native scrollback; a later collapse must not repaint them back into the
		// viewport (which would duplicate them in history with no ED3 to erase).
		const sealed = new LineList(rows("prior-", 12));
		const live = new LiveLineList([]);

		try {
			tui.addChild(sealed);
			tui.addChild(live);
			tui.start();
			await settle(term);

			const writes = capture(term);

			// Live block overflows the viewport — sealed prefix commits once.
			live.setLines(rows("think-", 30));
			tui.requestRender();
			await settle(term);
			expect(term.getScrollBuffer().filter(line => line.startsWith("prior-"))).toEqual(rows("prior-", 12));

			// Live block collapses to its compact result. The bottom-anchored
			// viewport would re-expose committed sealed rows; the pin must clamp the
			// repaint to the committed boundary instead of duplicating them.
			live.setLines(["done"]);
			tui.requestRender();
			await settle(term);

			expect(eraseScrollbackCount(writes)).toBe(0);
			expect(term.getScrollBuffer().filter(line => line.startsWith("prior-"))).toEqual(rows("prior-", 12));
		} finally {
			tui.stop();
		}
	});

	it("keeps committed prefix accounting after a capped streaming frame", async () => {
		if (process.platform === "win32") return;
		const term = new VirtualTerminal(24, 4);
		overrideProbe(term, undefined);
		const tui = new TUI(term);
		const sealed = new LineList(rows("base-", 12));

		try {
			tui.addChild(sealed);
			tui.start();
			await settle(term);

			const writes = capture(term);

			// No live-region marker yet: streaming caps this transient
			// frame to the viewport. The already-committed base-0..base-7 rows
			// remain physically in native scrollback and must stay accounted.
			sealed.setLines([...rows("base-", 12), ...rows("transient-", 30)]);
			tui.requestRender();
			await settle(term);

			expect(eraseScrollbackCount(writes)).toBe(0);

			// A later frame introduces a live region after the same sealed prefix.
			// If the cap zeroed the high-water mark, liveRegionPinned would append
			// base-0..base-11 again, duplicating base-0..base-7 in native history.
			const live = new LiveLineList(rows("live-", 20));
			sealed.setLines(rows("base-", 12));
			tui.addChild(live);
			tui.requestRender();
			await settle(term);

			expect(eraseScrollbackCount(writes)).toBe(0);
			expect(term.getScrollBuffer().filter(line => line.startsWith("base-"))).toEqual(rows("base-", 12));
		} finally {
			tui.stop();
		}
	});

	it("erases mis-wrapped native scrollback on resize even mid-stream", async () => {
		if (process.platform === "win32") return;
		const term = new VirtualTerminal(40, 10);
		overrideProbe(term, undefined);
		const tui = new TUI(term);
		const component = new LineList([...rows("init-", 5), "prompt"]);

		try {
			tui.addChild(component);
			tui.start();
			await settle(term);

			const writes = capture(term);

			// Stream past the viewport: scrolled rows commit to history in
			// order (shell semantics) and no ED3 fires.
			component.setLines([...rows("stream-", 30), "prompt"]);
			tui.requestRender();
			await settle(term);
			expect(eraseScrollbackCount(writes)).toBe(0);
			const streamed = term.getScrollBuffer().map(line => line.trimEnd());
			expect(streamed).toEqual([...rows("stream-", 30), "prompt"].slice(0, streamed.length));

			// Resize mid-stream. The terminal re-wrapped its saved lines at the old
			// width, so the authoritative rebuild must erase them (ED 3) rather than
			// leaving the corrupt history on screen. That rebuild is deferred until
			// the drag settles; while in flight only the viewport is repainted.
			term.resize(30, 10);
			await settleResize(term);

			expect(eraseScrollbackCount(writes)).toBeGreaterThan(0);
			expect(term.getScrollBuffer().map(line => line.trimEnd())).toEqual([...rows("stream-", 30), "prompt"]);
			expect(
				term
					.getViewport()
					.map(line => line.trim())
					.at(-1),
			).toBe("prompt");
		} finally {
			tui.stop();
		}
	});

	it("feeds committed native scrollback rows to interested children before render", async () => {
		if (process.platform === "win32") return;
		const term = new VirtualTerminal(20, 4);
		overrideProbe(term, undefined);
		const tui = new TUI(term);
		const probe = new CommittedRowsProbe([]);

		try {
			tui.addChild(probe);
			tui.start();
			await settle(term);

			// Grow well past the 4-row viewport: the append-only body lets the
			// engine commit the scrolled-off head to native scrollback.
			probe.setLines(rows("out-", 12));
			tui.requestRender();
			await settle(term);

			// The next compose must surface the engine's committed claim to the
			// child before render(). A severed wire here silently disables the
			// transcript's committed-block bypass (rows stay 0 forever).
			tui.requestRender();
			await settle(term);

			expect(probe.committedRowsAtRender.at(-1)!).toBeGreaterThan(0);
		} finally {
			tui.stop();
		}
	});

	it("commits the scrolled-off head of a durable snapshot block even while it re-lays-out", async () => {
		if (process.platform === "win32") return;
		const term = new VirtualTerminal(20, 4);
		overrideProbe(term, undefined);
		const tui = new TUI(term);
		// Durable but volatile: an interior row re-lays-out every frame (a table
		// re-aligning), so it never earns a byte-stable commit-safe end. The block
		// alone overflows the 4-row viewport. Its scrolled-off head must reach
		// native scrollback (snapshot-safe end), not vanish like a volatile block.
		const live = new SnapshotLiveLineList([]);

		try {
			tui.addChild(live);
			tui.start();
			await settle(term);

			const writes = capture(term);

			for (let n = 4; n <= 12; n++) {
				const lines = rows("tbl-", n);
				lines[1] = `tbl-1 [w${n}]`; // interior row re-lays-out every frame
				live.setLines(lines);
				tui.requestRender();
				await settle(term);
			}

			const buffer = term.getScrollBuffer().map(line => line.trimEnd());
			const joined = buffer.join("\n");
			// No ED3, and every logical row reached the tape (scrollback or window).
			expect(eraseScrollbackCount(writes)).toBe(0);
			for (let i = 2; i < 12; i++) expect(joined).toContain(`tbl-${i}`);
			// The interior row's snapshot is frozen (committed once); it is not lost.
			expect(joined).toContain("tbl-1");
		} finally {
			tui.stop();
		}
	});

	it("does not spray duplicate snapshots when an already-committed durable row drifts", async () => {
		if (process.platform === "win32") return;
		const term = new VirtualTerminal(20, 4);
		overrideProbe(term, undefined);
		const tui = new TUI(term);
		const live = new SnapshotLiveLineList(rows("row-", 12));

		try {
			tui.addChild(live);
			tui.start();
			await settle(term);

			// row-0 has long scrolled off and committed. Keep rewriting it (a
			// scrolled-off table row re-aligning) while appending new rows. The
			// committed-prefix audit must treat it as a durable snapshot and NOT
			// re-anchor + recommit the whole prefix on every drift (a spray storm).
			for (let n = 12; n <= 40; n++) {
				const lines = rows("row-", n);
				lines[0] = `row-0 [drift ${n}]`;
				live.setLines(lines);
				tui.requestRender();
				await settle(term);
			}

			const buffer = term.getScrollBuffer().map(line => line.trimEnd());
			// Without audit-exemption every drift frame recommits the whole prefix,
			// so the tape would balloon far past the ~40 logical rows. Bound it.
			expect(buffer.length).toBeLessThan(60);
			expect(buffer.join("\n")).toContain("row-39");
		} finally {
			tui.stop();
		}
	});
});

/**
 * Root child that reports an arbitrary `NativeScrollbackLiveRegion` seam, so a
 * test can reproduce any barrier shape the TranscriptContainer emits without
 * standing up the whole transcript. `undefined` on a method means "no seam".
 */
class SeamComponent implements Component, NativeScrollbackLiveRegion {
	lines: string[] = [];
	liveStart: number | undefined;
	commitSafe: number | undefined;
	snapSafe: number | undefined;

	invalidate(): void {}

	render(width: number): string[] {
		return this.lines.map(line => line.slice(0, width));
	}

	getNativeScrollbackLiveRegionStart(): number | undefined {
		return this.liveStart;
	}

	getNativeScrollbackCommitSafeEnd(): number | undefined {
		return this.commitSafe;
	}

	getNativeScrollbackSnapshotSafeEnd(): number | undefined {
		return this.snapSafe;
	}
}

/** Indices in `buffer` where `needle` begins as a contiguous run. */
function contiguousAt(buffer: string[], needle: string[]): number[] {
	const hits: number[] = [];
	for (let i = 0; i + needle.length <= buffer.length; i++) {
		let match = true;
		for (let j = 0; j < needle.length; j++) {
			if (buffer[i + j] !== needle[j]) {
				match = false;
				break;
			}
		}
		if (match) hits.push(i);
	}
	return hits;
}

/**
 * Structural no-loss invariant: the current frame appears as a contiguous run in
 * order, and below its last occurrence there is only blank viewport padding
 * (fresh content is the most recent thing on the tape; stale duplicates may sit
 * above it — duplication, never loss). A row in neither history nor the viewport
 * was "committed nowhere, painted nowhere" — the bug. The blank tolerance covers
 * sub-viewport frames, whose viewport is padded with blank rows beneath the
 * content. Returns the trimmed tape for further assertions.
 */
function expectNoLoss(term: VirtualTerminal, frame: string[]): string[] {
	const buffer = term.getScrollBuffer().map(line => line.trimEnd());
	const trimmed = frame.map(line => line.trimEnd());
	const hits = contiguousAt(buffer, trimmed);
	expect(hits.length).toBeGreaterThan(0);
	// Nothing but blank padding may follow the frame's last (most recent) run:
	// any non-blank row below it is content painted out of order or a duplicate
	// of fresher content sitting above its source — both are loss-class bugs.
	const tailStart = hits.at(-1)! + trimmed.length;
	for (let i = tailStart; i < buffer.length; i++) {
		expect(buffer[i]).toBe("");
	}
	return buffer;
}

describe("scrollback commit gap — commit-unstable barriers", () => {
	let savedTerminalEnv: Record<string, string | undefined> = {};
	beforeEach(() => {
		for (const key of ["TERM_PROGRAM", "PI_TUI_RESIZE_IN_PLACE"]) {
			savedTerminalEnv[key] = Bun.env[key];
			delete Bun.env[key];
		}
	});
	afterEach(() => {
		for (const key in savedTerminalEnv) {
			const value = savedTerminalEnv[key];
			if (value === undefined) delete Bun.env[key];
			else Bun.env[key] = value;
		}
		savedTerminalEnv = {};
	});

	it("does not drop the tail when a pending barrier above it is removed (S5/S6)", async () => {
		if (process.platform === "win32") return;
		const term = new VirtualTerminal(20, 4);
		overrideProbe(term, undefined);
		const tui = new TUI(term);
		const root = new SeamComponent();

		try {
			tui.addChild(root);
			tui.start();
			await settle(term);
			const writes = capture(term);

			// Small commit-unstable barrier above a long finalized tail, overflowing
			// the 4-row viewport. liveStart=0 pins the seam; no commit/snapshot end.
			const f1 = ["[tool pending]", ...rows("ans-", 8)];
			root.lines = f1;
			root.liveStart = 0;
			tui.requestRender();
			await settle(term);
			expectNoLoss(term, f1);

			// Barrier removed (agent moved past the tool / poll superseded): the tail
			// shifts up. The audit must re-anchor instead of trusting the stale
			// committed prefix and skipping the shifted rows.
			const f2 = rows("ans-", 8);
			root.lines = f2;
			root.liveStart = undefined;
			tui.requestRender();
			await settle(term);

			const buffer = expectNoLoss(term, f2);
			for (const row of f2) expect(buffer).toContain(row);
			expect(term.getViewport().map(line => line.trimEnd())).toEqual(rows("ans-", 8).slice(-4));
			expect(eraseScrollbackCount(writes)).toBe(0);
		} finally {
			tui.stop();
		}
	});

	it("does not drop result rows when a provisional preview is replaced by a longer result (S4)", async () => {
		if (process.platform === "win32") return;
		const term = new VirtualTerminal(20, 4);
		overrideProbe(term, undefined);
		const tui = new TUI(term);
		const root = new SeamComponent();

		try {
			tui.addChild(root);
			tui.start();
			await settle(term);
			const writes = capture(term);

			const preview = rows("preview-", 10);
			root.lines = preview;
			root.liveStart = 0;
			tui.requestRender();
			await settle(term);
			expectNoLoss(term, preview);

			const result = rows("result-", 9);
			root.lines = result;
			root.liveStart = undefined;
			tui.requestRender();
			await settle(term);

			const buffer = expectNoLoss(term, result);
			for (const row of result) expect(buffer).toContain(row);
			expect(term.getViewport().map(line => line.trimEnd())).toEqual(rows("result-", 9).slice(-4));
			expect(eraseScrollbackCount(writes)).toBe(0);
		} finally {
			tui.stop();
		}
	});

	it("does not drop rows when a barrier partially collapses above a long tail (S10)", async () => {
		if (process.platform === "win32") return;
		const term = new VirtualTerminal(20, 4);
		overrideProbe(term, undefined);
		const tui = new TUI(term);
		const root = new SeamComponent();

		try {
			tui.addChild(root);
			tui.start();
			await settle(term);
			const writes = capture(term);

			// 3-row barrier over an 8-row tail (len 11), overflowing.
			const f1 = [...rows("bar-", 3), ...rows("tail-", 8)];
			root.lines = f1;
			root.liveStart = 0;
			tui.requestRender();
			await settle(term);
			expectNoLoss(term, f1);

			// Barrier collapses to 1 row but the frame stays longer than the
			// committed prefix (NOT the shrink-into-prefix branch), so the audit must
			// catch the upward tail shift.
			const f2 = ["bar-collapsed", ...rows("tail-", 8)];
			root.lines = f2;
			root.liveStart = undefined;
			tui.requestRender();
			await settle(term);

			const buffer = expectNoLoss(term, f2);
			for (const row of rows("tail-", 8)) expect(buffer).toContain(row);
			expect(term.getViewport().map(line => line.trimEnd())).toEqual(f2.slice(-4));
			expect(eraseScrollbackCount(writes)).toBe(0);
		} finally {
			tui.stop();
		}
	});

	it("keeps a finalized tail in order when its live barrier sibling is removed (multi-child S6)", async () => {
		if (process.platform === "win32") return;
		const term = new VirtualTerminal(20, 5);
		overrideProbe(term, undefined);
		const tui = new TUI(term);
		// Realistic transcript shape: a still-live barrier block above a finalized
		// tail block. The container concatenates them; the topmost seam (the
		// barrier at row 0) pins the boundary, forcing the finalized tail to commit
		// under it as it overflows.
		const barrier = new LiveLineList(["[tool pending]"]);
		const tail = new LineList(rows("out-", 10));

		try {
			tui.addChild(barrier);
			tui.addChild(tail);
			tui.start();
			await settle(term);
			const writes = capture(term);

			// Force overflow: the concatenated frame is 11 rows over a 5-row viewport.
			tui.requestRender();
			await settle(term);
			expectNoLoss(term, ["[tool pending]", ...rows("out-", 10)]);

			// Remove the barrier. The finalized tail shifts up by one row; every
			// out-* row must remain, in order, contiguous at the tape bottom.
			tui.removeChild(barrier);
			tui.requestRender();
			await settle(term);

			const buffer = expectNoLoss(term, rows("out-", 10));
			// Strong in-order check: the whole tail is one contiguous run at the
			// bottom (not merely each row present somewhere).
			expect(buffer.slice(-10)).toEqual(rows("out-", 10));
			expect(term.getViewport().map(line => line.trimEnd())).toEqual(rows("out-", 10).slice(-5));
			expect(eraseScrollbackCount(writes)).toBe(0);
		} finally {
			tui.stop();
		}
	});

	it("survives a streaming-then-removed barrier across many frames without loss", async () => {
		if (process.platform === "win32") return;
		const term = new VirtualTerminal(20, 5);
		overrideProbe(term, undefined);
		const tui = new TUI(term);
		const root = new SeamComponent();

		try {
			tui.addChild(root);
			tui.start();
			await settle(term);

			// Pending barrier above a tail that grows every frame, overflowing
			// further each tick; the barrier pins the seam at 0 (commit-unstable).
			for (let n = 1; n <= 20; n++) {
				const frame = ["[pending]", ...rows("row-", n)];
				root.lines = frame;
				root.liveStart = 0;
				tui.requestRender();
				await settle(term);
				expectNoLoss(term, frame);
			}

			const final = rows("row-", 20);
			root.lines = final;
			root.liveStart = undefined;
			tui.requestRender();
			await settle(term);

			const buffer = expectNoLoss(term, final);
			for (const row of final) expect(buffer).toContain(row);
			expect(term.getViewport().map(line => line.trimEnd())).toEqual(rows("row-", 20).slice(-5));
		} finally {
			tui.stop();
		}
	});

	it("audits a forced card below a durable prose tail without spraying its snapshot", async () => {
		if (process.platform === "win32") return;
		// Coexistence case: a commit-stable streaming block whose volatile tail is
		// durable-exempt (snapSafe past its body) with a finalized card committed
		// BELOW it. The card is a forced-overflow row that MUST stay audited, while
		// the prose tail's in-place re-wrap must NOT spray duplicate snapshots.
		const term = new VirtualTerminal(20, 4);
		overrideProbe(term, undefined);
		const tui = new TUI(term);
		const root = new SeamComponent();

		try {
			tui.addChild(root);
			tui.start();
			await settle(term);
			const writes = capture(term);

			for (let n = 0; n < 12; n++) {
				const prose = rows("prose-", 8);
				prose[7] = `prose-7 [w${n}]`; // volatile tail re-wraps in place
				root.lines = [...prose, "card-0", "card-1"];
				root.liveStart = 0;
				root.commitSafe = 7; // byte-stable through prose-6
				root.snapSafe = 8; // durable through the whole prose body
				tui.requestRender();
				await settle(term);
			}

			const buffer = term.getScrollBuffer().map(line => line.trimEnd());
			// No spray: durable prose head committed once, not once-per-drift.
			expect(contiguousAt(buffer, ["prose-0", "prose-1", "prose-2"]).length).toBeLessThanOrEqual(2);
			// No loss: the finalized card below the durable tail reached the tape.
			expect(buffer).toContain("card-0");
			expect(buffer).toContain("card-1");
			expect(eraseScrollbackCount(writes)).toBe(0);
		} finally {
			tui.stop();
		}
	});

	it("does not lose a single-row finalize edit above an unchanged tail (reviewer repro)", async () => {
		if (process.platform === "win32") return;
		const term = new VirtualTerminal(20, 4);
		overrideProbe(term, undefined);
		const tui = new TUI(term);
		const root = new SeamComponent();

		try {
			tui.addChild(root);
			tui.start();
			await settle(term);
			const writes = capture(term);

			// Commit-unstable barrier ("preview") above an 8-row tail, overflowing.
			const f1 = ["preview", ...rows("tail-", 8)];
			root.lines = f1;
			root.liveStart = 0;
			tui.requestRender();
			await settle(term);
			expectNoLoss(term, f1);

			// Finalize: the seam clears and ONLY row 0 changes (preview→result); the
			// whole tail is byte-identical. The committed head "preview" scrolled
			// above the viewport, so the change is invisible unless the audit
			// re-anchors. Tail-sample tolerance alone would skip it (one mismatch
			// over an aligned tail) and "result" would be committed nowhere, painted
			// nowhere — the reviewer's loss. The hard scan of the now-permanent
			// forced suffix forces the re-anchor.
			const f2 = ["result", ...rows("tail-", 8)];
			root.lines = f2;
			root.liveStart = undefined; // seam cleared: forced rows are now permanent
			tui.requestRender();
			await settle(term);

			const buffer = expectNoLoss(term, f2);
			expect(buffer).toContain("result");
			expect(term.getViewport().map(line => line.trimEnd())).toEqual(f2.slice(-4));
			expect(eraseScrollbackCount(writes)).toBe(0);
		} finally {
			tui.stop();
		}
	});

	it("does not lose a single-row finalize edit far above a long unchanged tail (deep tail)", async () => {
		if (process.platform === "win32") return;
		const term = new VirtualTerminal(20, 4);
		overrideProbe(term, undefined);
		const tui = new TUI(term);
		const root = new SeamComponent();

		try {
			tui.addChild(root);
			tui.start();
			await settle(term);
			const writes = capture(term);

			// The changed row sits ~30 rows above the commit boundary with an
			// unchanged tail — far outside the 24-row tail-sample lookback, so only a
			// FULL scan of the now-permanent forced suffix catches it.
			const f1 = ["preview", ...rows("tail-", 30)];
			root.lines = f1;
			root.liveStart = 0;
			tui.requestRender();
			await settle(term);
			expectNoLoss(term, f1);

			const f2 = ["result", ...rows("tail-", 30)];
			root.lines = f2;
			root.liveStart = undefined;
			tui.requestRender();
			await settle(term);

			const buffer = expectNoLoss(term, f2);
			// "result" reached the tape exactly once: the stale "preview" head was
			// never overwritten in place (no ED3) but the changed row is "result",
			// not a second "preview" — duplication of identical rows, never loss.
			expect(buffer).toContain("result");
			expect(buffer.filter(line => line === "result")).toHaveLength(1);
			expect(eraseScrollbackCount(writes)).toBe(0);
		} finally {
			tui.stop();
		}
	});

	it("does not spray when a commit-unstable barrier becomes durable and a scrolled row drifts", async () => {
		if (process.platform === "win32") return;
		const term = new VirtualTerminal(20, 4);
		overrideProbe(term, undefined);
		const tui = new TUI(term);
		const root = new SeamComponent();

		try {
			tui.addChild(root);
			tui.start();
			await settle(term);
			const writes = capture(term);

			// Phase 1: a commit-unstable barrier (no commit/snapshot end) overflows
			// the viewport, force-committing its head as forced-overflow rows.
			root.lines = rows("tbl-", 12);
			root.liveStart = 0;
			tui.requestRender();
			await settle(term);

			// Phase 2: the block becomes DURABLE (reports a snapshot-safe end over its
			// whole body) while a scrolled-off INTERIOR committed row re-lays-out in
			// place every frame — a streaming table that re-aligns its columns after it
			// stops being provisional. An interior row (not row 0) is the load-bearing
			// case: re-anchoring there leaves preDurable < preCommit, so without the
			// hard-audit durableRows advance the durable-rise gate re-fires the full
			// scan AND re-anchors on the drift every frame, ballooning native
			// scrollback with duplicate snapshots (spray). With the advance, the
			// durable row is exempt after the one transition re-anchor.
			for (let n = 0; n < 30; n++) {
				const lines = rows("tbl-", 12);
				lines[5] = `tbl-5 [w${n}]`; // scrolled-off interior durable row drifts
				root.lines = lines;
				root.liveStart = 0;
				root.snapSafe = 12; // durable through the whole body
				tui.requestRender();
				await settle(term);
			}

			const buffer = term.getScrollBuffer().map(line => line.trimEnd());
			// Bounded: ~12 logical rows + at most one transition re-anchor's stale
			// copy. Spray would push this far past 40.
			expect(buffer.length).toBeLessThan(40);
			expect(buffer.join("\n")).toContain("tbl-11");
			expect(eraseScrollbackCount(writes)).toBe(0);
		} finally {
			tui.stop();
		}
	});
});
