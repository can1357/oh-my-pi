/**
 * pi-tui's alternate-screen resize borrow, replayed against a real VT core:
 * a drag is a burst of resizes with frames in between. The writer blanks the
 * live viewport, borrows the alternate screen for the whole burst (frames
 * show the viewport tail there and acknowledge no history), and once the
 * burst goes quiet leaves it, re-anchors with a cursor report and applies the
 * scrollback policy. The emulator then must hold exactly one copy of every
 * row: no torn frame in scrollback, no duplicate, and (rebuild) the same
 * final transcript pi-tui produces: the ledger at the final width, then the
 * viewport.
 */
import { describe, expect, it } from "bun:test";
import type { FramePlan } from "@oh-my-pi/pi-tui/driver/contract";
import { duplicated, lines, Vt, type VtOptions } from "./vt";

const ALT_ENTER = "\x1b[?1049h";
const ALT_LEAVE = "\x1b[?1049l";
const ED3 = "\x1b[3J";
const SYNC_BEGIN = "\x1b[?2026h";

const LEDGER = Array.from({ length: 8 }, (_, i) => `entry${i} ${"word ".repeat(2 + i)}`.trim());
const VIEWPORT = ["status: working", "> prompt text"];
/** The drag: widths and heights a window passes through, shrinking and growing. */
const DRAG: readonly (readonly [number, number])[] = [
	[36, 12],
	[31, 11],
	[26, 9],
	[29, 10],
	[33, 12],
	[28, 10],
];

function wrapAt(text: string, width: number): string[] {
	const rows: string[] = [];
	for (let at = 0; at < text.length; at += width) rows.push(text.slice(at, at + width));
	return rows;
}

const count = (text: string, needle: string): number => text.split(needle).length - 1;

class App {
	readonly vt: Vt;
	#id = 0;
	#replay = false;

	constructor(options: VtOptions) {
		this.vt = new Vt({
			shell: lines("$ cmd", 1, 3),
			...options,
			canReplay: () => true,
			onInvalidate: request => {
				if (request === "replay") this.#replay = true;
			},
		});
	}

	ledger(): string[] {
		return LEDGER.flatMap(line => wrapAt(line, this.vt.term.columns));
	}

	frame(history?: FramePlan["history"]): FramePlan {
		return { ...(history ? { history } : {}), viewport: VIEWPORT, cursor: { row: 1, col: 13 } };
	}

	open(): void {
		expect(this.vt.present(this.frame({ id: ++this.#id, rows: this.ledger() }))).toBe(1);
	}

	render(): void {
		if (!this.#replay) {
			this.vt.present(this.frame());
			return;
		}
		const id = ++this.#id;
		if (this.vt.present(this.frame({ id, rows: this.ledger(), kind: "replay" })) === id) this.#replay = false;
	}

	/** Drag through `DRAG`, rendering after every step, without letting it settle. */
	drag(): void {
		for (const [columns, rows] of DRAG) {
			this.vt.resize(columns, rows);
			this.render();
		}
	}
}

/** Rows that are a strict prefix of a viewport row: a frame torn by a reflow or a partial write. */
function torn(rows: readonly string[]): string[] {
	return rows.filter(row => row !== "" && VIEWPORT.some(live => live !== row && live.startsWith(row)));
}

describe("resize burst (alternate-screen borrow)", () => {
	it("blanks the viewport, borrows once for the whole burst, then returns and rebuilds exactly once", async () => {
		const app = new App({ columns: 40, rows: 12, resizeScrollback: "rebuild" });
		app.open();
		const mark = app.vt.writes.length;
		app.drag();
		const burst = app.vt.since(mark);
		// One borrow for the burst, entered after blanking the live viewport on the normal screen.
		expect(count(burst, ALT_ENTER)).toBe(1);
		expect(burst).not.toContain(ALT_LEAVE);
		const enter = burst.indexOf(ALT_ENTER);
		expect(burst.slice(0, enter)).toMatch(/\x1b\[J/);
		expect(app.vt.term.isMainScreen).toBe(false);
		// The borrowed screen shows the viewport tail, bottom-anchored.
		expect(app.vt.screen().slice(-2)).toEqual(VIEWPORT);
		// Nothing of the burst reached the normal screen's history.
		expect(app.vt.writes.slice(mark).join("")).not.toContain("entry");

		await app.vt.settle();
		app.render();
		const after = app.vt.since(mark).slice(burst.length);
		expect(count(after, ALT_LEAVE)).toBe(1);
		// Leave, erase screen and history, replay: one write, in that order.
		expect(after.indexOf(ALT_LEAVE)).toBeLessThan(after.indexOf(ED3));
		expect(app.vt.term.isMainScreen).toBe(true);
		// pi-tui's rebuild result: the shell is gone with the erased history, the ledger at the final width, the viewport.
		expect(app.vt.transcript()).toEqual([...app.ledger(), ...VIEWPORT]);
		expect(app.vt.term.cursor).toMatchObject({ x: 13, visible: true });
	});

	it("preserve: returns to the normal screen with one copy of every row and no torn frame in scrollback", async () => {
		const app = new App({ columns: 40, rows: 12, resizeScrollback: "preserve" });
		app.open();
		app.drag();
		await app.vt.settle();
		app.render();
		const transcript = app.vt.transcript();
		expect(
			app.vt
				.screen()
				.filter(row => row !== "")
				.slice(-2),
		).toEqual(VIEWPORT);
		expect(duplicated(transcript.filter(row => VIEWPORT.includes(row)))).toEqual([]);
		expect(torn(app.vt.scrollback())).toEqual([]);
		expect(app.vt.scrollback()).not.toContain(VIEWPORT[1]);
		// The shell's lines stay above the ledger, once each.
		expect(transcript.filter(row => row.startsWith("$ cmd"))).toEqual(lines("$ cmd", 1, 3));
	});

	it("survives a second burst right after the first settled", async () => {
		const app = new App({ columns: 40, rows: 12, resizeScrollback: "rebuild" });
		app.open();
		app.drag();
		await app.vt.settle();
		app.render();
		app.vt.resize(34, 12);
		app.render();
		app.vt.resize(30, 11);
		app.render();
		await app.vt.settle();
		app.render();
		expect(app.vt.transcript()).toEqual([...app.ledger(), ...VIEWPORT]);
	});

	it("tmux with synchronized output and rebuild: settles without borrowing the alternate screen", async () => {
		const app = new App({
			columns: 40,
			rows: 12,
			resizeScrollback: "rebuild",
			multiplexer: () => true,
			resizeAvoidsAlternate: () => true,
			renewsSynchronizedOutput: () => true,
		});
		app.open();
		const mark = app.vt.writes.length;
		app.drag();
		// Frames wait for the settle; the multiplexer owns the grid, so nothing is erased either.
		expect(app.vt.writes.length).toBe(mark);
		await app.vt.settle();
		app.render();
		const bytes = app.vt.since(mark);
		expect(bytes).not.toContain(ALT_ENTER);
		expect(bytes).toContain(ED3);
		expect(app.vt.transcript()).toEqual([...app.ledger(), ...VIEWPORT]);
	});
});

describe("resize quirks", () => {
	it("renews synchronized output while a long write streams to a host that expires it", () => {
		const long = Array.from({ length: 300 }, (_, i) => `history row ${i} ${"x".repeat(90)}`);
		const renewing = new Vt({ columns: 120, rows: 20, renewsSynchronizedOutput: () => true });
		const plain = new Vt({ columns: 120, rows: 20 });
		for (const vt of [renewing, plain])
			vt.present({ history: { id: 1, rows: long }, viewport: ["live"], cursor: null });
		expect(count(plain.since(0), SYNC_BEGIN)).toBe(1);
		expect(count(renewing.since(0), SYNC_BEGIN)).toBeGreaterThan(1);
		expect(renewing.transcript()).toEqual(plain.transcript());
	});

	it("re-probes the anchor when Warp's toggle echo lands while a cursor report is in flight", async () => {
		// Like the input half: one report in flight at a time, asked for again only once it answered.
		let probes = 0;
		let inFlight: Promise<{ row: number; col: number } | null> | null = null;
		const pending: Array<() => void> = [];
		let probed = Promise.withResolvers<void>();
		const vt: Vt = new Vt({
			columns: 30,
			rows: 10,
			warp: () => true,
			queryCursor: () => {
				if (inFlight) return inFlight;
				probes++;
				const { promise, resolve } = Promise.withResolvers<{ row: number; col: number } | null>();
				inFlight = promise;
				pending.push(() => {
					inFlight = null;
					resolve({ row: vt.term.cursor.y, col: vt.term.cursor.x });
				});
				probed.resolve();
				return promise;
			},
		});
		vt.present({ viewport: ["live", "> prompt"], cursor: { row: 1, col: 8 } });
		vt.resize(24, 10);
		vt.present({ viewport: ["live", "> prompt"], cursor: { row: 1, col: 8 } });
		void vt.settle();
		// Leaving the borrow (Warp re-reports its size): the echo arrives while the first report is pending.
		expect(probes).toBe(1);
		probed = Promise.withResolvers<void>();
		vt.resize(24, 9);
		pending.shift()!();
		await probed.promise;
		// The predating report is discarded and the anchor asked for again at the echoed size.
		expect(probes).toBe(2);
		pending.shift()!();
		await vt.writer.whenAnchored();
		expect(vt.invalidations.at(-1)).toBe("repaint");
		vt.present({ viewport: ["live", "> prompt"], cursor: { row: 1, col: 8 } });
		expect(vt.screen().filter(row => row === "live")).toHaveLength(1);
	});

	it("retries an unanswered anchor probe once inside a multiplexer", async () => {
		const replies: Array<{ row: number; col: number } | null> = [null];
		let probes = 0;
		const vt: Vt = new Vt({
			columns: 30,
			rows: 10,
			multiplexer: () => true,
			queryCursor: async () => {
				probes++;
				return replies.length > 0 ? replies.shift()! : { row: vt.term.cursor.y, col: vt.term.cursor.x };
			},
		});
		vt.present({ viewport: ["live", "> prompt"], cursor: { row: 1, col: 8 } });
		vt.resize(26, 10);
		vt.present({ viewport: ["live", "> prompt"], cursor: { row: 1, col: 8 } });
		await vt.settle();
		expect(probes).toBe(2);
		vt.present({ viewport: ["live", "> prompt"], cursor: { row: 1, col: 8 } });
		expect(duplicated(vt.transcript())).toEqual([]);
	});

	it("tmux grew before the resize reached us: a once-full viewport left short of the bottom replays under rebuild", async () => {
		let replays = 0;
		const vt: Vt = new Vt({
			columns: 30,
			rows: 6,
			multiplexer: () => true,
			resizeScrollback: "rebuild",
			canReplay: () => true,
			growsBeforeResize: () => true,
			onInvalidate: request => {
				if (request === "replay") replays++;
			},
		});
		vt.present({ history: { id: 1, rows: lines("h", 1, 8) }, viewport: ["a", "b"], cursor: null });
		vt.resize(30, 9);
		vt.present({ viewport: ["a", "b"], cursor: null });
		await vt.settle();
		expect(replays).toBe(1);
		vt.present({ history: { id: 2, rows: lines("h", 1, 8), kind: "replay" }, viewport: ["a", "b"], cursor: null });
		expect(vt.transcript()).toEqual([...lines("h", 1, 8), "a", "b"]);
	});

	it("erases before image sequences on a rebuild, and re-sends images entering the alternate screen", async () => {
		const calls: string[] = [];
		const vt = new Vt({
			columns: 30,
			rows: 10,
			resizeScrollback: "rebuild",
			canReplay: () => true,
			images: {
				takeSequences: screen => {
					calls.push(`take:${screen}`);
					return `\x1b_Gimg-${screen}\x1b\\`;
				},
				enteredAlternate: () => calls.push("enter"),
				cleared: () => calls.push("cleared"),
			},
		});
		vt.present({ history: { id: 1, rows: ["h1"] }, viewport: ["live"], cursor: null });
		vt.resize(24, 10);
		vt.present({ viewport: ["live"], cursor: null });
		expect(calls.slice(-2)).toEqual(["enter", "take:alternate"]);
		await vt.settle();
		const mark = vt.writes.length;
		vt.present({ history: { id: 2, rows: ["h1"], kind: "replay" }, viewport: ["live"], cursor: null });
		const fused = vt.since(mark);
		expect(calls.slice(-2)).toEqual(["cleared", "take:main"]);
		expect(fused.indexOf(ED3)).toBeLessThan(fused.indexOf("img-main"));
		expect(fused.indexOf("img-main")).toBeLessThan(fused.indexOf("live"));
	});
});
