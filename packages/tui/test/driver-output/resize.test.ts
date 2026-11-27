import { describe, expect, it } from "bun:test";
import type { FramePlan } from "@oh-my-pi/pi-tui/driver/contract";
import { duplicated, lines, Vt, type VtOptions } from "./vt";

const ED3 = "\x1b[3J";
const ALT_ENTER = "\x1b[?1049h";
const ALT_LEAVE = "\x1b[?1049l";

/** Long logical lines: their rows depend on the width, like a transcript's. */
const LEDGER = Array.from({ length: 6 }, (_, i) => `entry${i} ${"word ".repeat(3 + i)}`.trim());

function wrapAt(text: string, width: number): string[] {
	const rows: string[] = [];
	for (let at = 0; at < text.length; at += width) rows.push(text.slice(at, at + width));
	return rows;
}

/**
 * A frame source that retires the whole ledger once, then answers replay
 * requests with the ledger at the current width under a fresh id.
 */
class Source {
	readonly vt: Vt;
	#id = 0;
	#replay = false;
	readonly acks: number[] = [];

	constructor(options: VtOptions) {
		this.vt = new Vt({
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

	viewport(): string[] {
		return ["live", "> prompt"];
	}

	frame(history?: FramePlan["history"]): FramePlan {
		return { ...(history ? { history } : {}), viewport: this.viewport(), cursor: { row: 1, col: 8 } };
	}

	/** First frame: the ledger retires into history. */
	open(): void {
		this.present(this.frame({ id: ++this.#id, rows: this.ledger() }));
	}

	render(): number | undefined {
		if (this.#replay) {
			const history = { id: ++this.#id, rows: this.ledger(), kind: "replay" as const };
			const ack = this.present(this.frame(history));
			if (ack === history.id) this.#replay = false;
			return ack;
		}
		return this.present(this.frame());
	}

	present(frame: FramePlan): number | undefined {
		const ack = this.vt.present(frame);
		if (ack !== undefined) this.acks.push(ack);
		return ack;
	}

	/** Resize, render through the settle window, then render once more. */
	async resize(columns: number, rows: number): Promise<void> {
		this.vt.resize(columns, rows);
		this.render();
		await this.vt.settle();
		this.render();
	}
}

describe("resize", () => {
	it("borrows the alternate screen until the resize settles, without acknowledging history there", async () => {
		const source = new Source({ columns: 30, rows: 10 });
		source.open();
		source.vt.resize(24, 10);
		const mark = source.vt.writes.length;
		expect(source.present(source.frame({ id: 99, rows: ["never"] }))).toBeUndefined();
		expect(source.vt.since(mark)).toContain(ALT_ENTER);
		expect(source.vt.term.isMainScreen).toBe(false);
		expect(source.vt.screen().slice(-2)).toEqual(["live", "> prompt"]);
		await source.vt.settle();
		expect(source.vt.term.isMainScreen).toBe(true);
		source.render();
		expect(source.vt.transcript().slice(-2)).toEqual(["live", "> prompt"]);
	});

	it("preserve: repaints only the viewport and keeps old-width history", async () => {
		const source = new Source({ columns: 30, rows: 10, resizeScrollback: "preserve" });
		source.open();
		const mark = source.vt.writes.length;
		await source.resize(40, 10);
		expect(source.vt.since(mark)).not.toContain(ED3);
		const transcript = source.vt.transcript();
		expect(transcript.slice(-2)).toEqual(["live", "> prompt"]);
		expect(transcript.filter(row => row === "live").length).toBe(1);
		// The 30-column rows stay as written.
		expect(transcript.slice(0, -2)).toEqual(LEDGER.flatMap(line => wrapAt(line, 30)));
	});

	it("rebuild: clears history and replays it at the new width in the same write as the exit", async () => {
		const source = new Source({ columns: 30, rows: 10, resizeScrollback: "rebuild" });
		source.open();
		source.vt.resize(20, 10);
		source.render();
		await source.vt.settle();
		const mark = source.vt.writes.length;
		const ack = source.render();
		expect(ack).toBe(2);
		const fused = source.vt.since(mark);
		expect(source.vt.writes.length).toBe(mark + 1);
		expect(fused.indexOf(ALT_LEAVE)).toBeLessThan(fused.indexOf(ED3));
		expect(source.vt.transcript()).toEqual([...LEDGER.flatMap(line => wrapAt(line, 20)), "live", "> prompt"]);
		expect(source.vt.term.cursor).toMatchObject({ x: 8, visible: true });
	});

	it("rebuild: a height-only grow repaints without replaying", async () => {
		const source = new Source({ columns: 30, rows: 8, resizeScrollback: "rebuild" });
		source.open();
		const mark = source.vt.writes.length;
		await source.resize(30, 12);
		expect(source.vt.since(mark)).not.toContain(ED3);
		expect(source.acks).toEqual([1]);
		const transcript = source.vt.transcript();
		expect(transcript.slice(-2)).toEqual(["live", "> prompt"]);
		expect(transcript.filter(row => row === "live").length).toBe(1);
	});

	it("append: appends a current-width copy below retained history on width changes only", async () => {
		const source = new Source({ columns: 30, rows: 10, resizeScrollback: "append" });
		source.open();
		await source.resize(20, 10);
		expect(source.acks).toEqual([1, 2]);
		const transcript = source.vt.transcript();
		const replay = LEDGER.flatMap(line => wrapAt(line, 20));
		expect(transcript.slice(-(replay.length + 2))).toEqual([...replay, "live", "> prompt"]);
		expect(transcript.filter(row => row === "live").length).toBe(1);
		await source.resize(20, 12);
		expect(source.acks).toEqual([1, 2]);
		expect(source.vt.transcript().filter(row => row === "live").length).toBe(1);
	});

	it("keeps live rows out of scrollback on a height shrink of a full screen", async () => {
		const source = new Source({ columns: 30, rows: 10, shell: lines("$ ", 1, 3) });
		source.open();
		await source.resize(30, 6);
		expect(source.vt.screen().slice(-2)).toEqual(["live", "> prompt"]);
		expect(duplicated(source.vt.transcript())).toEqual([]);
		expect(source.vt.scrollback()).not.toContain("> prompt");
	});

	it("rebuilds on a host that repaints its own grid (ConPTY) instead of probing the anchor", async () => {
		let probes = 0;
		const source = new Source({
			columns: 30,
			rows: 10,
			resizeScrollback: "preserve",
			hostOwnsGrid: () => true,
			queryCursor: async () => {
				probes++;
				return null;
			},
		});
		source.open();
		await source.resize(20, 10);
		expect(probes).toBe(0);
		expect(source.acks).toEqual([1, 2]);
		expect(source.vt.transcript()).toEqual([...LEDGER.flatMap(line => wrapAt(line, 20)), "live", "> prompt"]);
	});

	it("anchors from the cursor report inside a multiplexer", async () => {
		const source = new Source({ columns: 30, rows: 10, multiplexer: () => true });
		source.open();
		await source.resize(24, 10);
		const transcript = source.vt.transcript();
		expect(transcript.slice(-2)).toEqual(["live", "> prompt"]);
		expect(duplicated(transcript.filter(row => row === "live" || row === "> prompt"))).toEqual([]);
	});

	it("in place: paints nothing until the drag settles, never borrows, never replays", async () => {
		const source = new Source({ columns: 30, rows: 10, resizeScrollback: "rebuild", inPlaceResize: () => true });
		source.open();
		const mark = source.vt.writes.length;
		source.vt.resize(26, 10);
		expect(source.render()).toBeUndefined();
		source.vt.resize(22, 10);
		const drag = source.vt.writes.length;
		expect(source.render()).toBeUndefined();
		expect(source.vt.writes.length).toBe(drag);
		await source.vt.settle();
		source.render();
		const bytes = source.vt.since(mark);
		expect(bytes).not.toContain(ALT_ENTER);
		expect(bytes).not.toContain(ED3);
		expect(source.vt.invalidations).toEqual([]);
		expect(source.acks).toEqual([1]);
		expect(source.vt.screen().filter(row => row === "live").length).toBe(1);
		expect(source.vt.transcript().slice(-2)).toEqual(["live", "> prompt"]);
	});

	it("consumes Warp's height echo of an alternate-screen toggle", () => {
		const vt = new Vt({ columns: 30, rows: 10, warp: () => true });
		vt.present({ viewport: ["live"], cursor: null });
		vt.present({ viewport: [], cursor: null, fullscreen: ["modal"] });
		vt.resize(30, 9);
		expect(vt.invalidations).toEqual(["repaint"]);
		const mark = vt.writes.length;
		vt.present({ viewport: [], cursor: null, fullscreen: ["modal"] });
		expect(vt.since(mark)).toContain("modal");
		vt.present({ viewport: ["live"], cursor: null });
		expect(vt.term.isMainScreen).toBe(true);
		expect(vt.screen().filter(row => row === "live").length).toBe(1);
	});

	it("re-anchors after a resize behind a fullscreen frame once it closes", async () => {
		const vt = new Vt({ columns: 30, rows: 10, shell: lines("$ ", 1, 2) });
		vt.present({ viewport: ["live", "> prompt"], cursor: { row: 1, col: 8 } });
		vt.present({ viewport: [], cursor: null, fullscreen: ["modal"] });
		vt.resize(24, 12);
		vt.present({ viewport: [], cursor: null, fullscreen: ["modal"] });
		await vt.settle();
		expect(vt.term.isMainScreen).toBe(false);
		expect(vt.present({ viewport: ["live", "> prompt"], cursor: { row: 1, col: 8 } })).toBeUndefined();
		expect(vt.term.isMainScreen).toBe(true);
		await vt.writer.whenAnchored();
		vt.present({ viewport: ["live", "> prompt"], cursor: { row: 1, col: 8 } });
		expect(vt.transcript()).toEqual(["$ 1", "$ 2", "live", "> prompt"]);
	});

	it("stops mid-resize on the normal screen with the cursor below the content", () => {
		const vt = new Vt({ columns: 30, rows: 10 });
		vt.present({ viewport: ["live", "> prompt"], cursor: { row: 1, col: 8 } });
		vt.resize(24, 10);
		vt.present({ viewport: ["live", "> prompt"], cursor: { row: 1, col: 8 } });
		vt.writer.stop();
		expect(vt.term.isMainScreen).toBe(true);
		expect(vt.term.cursor.visible).toBe(true);
		expect(vt.term.cursor.x).toBe(0);
	});
});
