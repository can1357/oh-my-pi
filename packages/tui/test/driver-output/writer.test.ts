import { describe, expect, it } from "bun:test";
import { anchoredRows } from "@oh-my-pi/pi-tui/driver/images/anchor";
import { duplicated, lines, Vt } from "./vt";

const CURSOR_HIDE = "\x1b[?25l";
const SYNC_BEGIN = "\x1b[?2026h";

describe("history", () => {
	it("writes each batch once, acknowledges its id, and anchors the viewport below it", () => {
		const vt = new Vt({ rows: 6 });
		vt.present({ viewport: ["a1", "a2", "status"], cursor: null });
		expect(vt.present({ history: { id: 1, rows: ["a1", "a2"] }, viewport: ["a3", "status"], cursor: null })).toBe(1);
		// Offered again (an unacknowledged retry): acknowledged without a second copy.
		expect(vt.present({ history: { id: 1, rows: ["a1", "a2"] }, viewport: ["a3", "status"], cursor: null })).toBe(1);
		expect(vt.present({ history: { id: 2, rows: ["a3"] }, viewport: ["a4", "status"], cursor: null })).toBe(2);
		expect(vt.transcript()).toEqual(["a1", "a2", "a3", "a4", "status"]);
	});

	it("pushes history into scrollback in order when it overflows the screen", () => {
		const vt = new Vt({ rows: 5 });
		let id = 0;
		const all: string[] = [];
		for (let block = 0; block < 6; block++) {
			const rows = lines(`b${block}.`, 1, 3);
			all.push(...rows);
			vt.present({ viewport: [...rows, "status"], cursor: null });
			vt.present({ history: { id: ++id, rows }, viewport: ["status"], cursor: null });
		}
		expect(vt.scrollback()).toEqual(all.slice(0, all.length - 4));
		expect(vt.transcript()).toEqual([...all, "status"]);
	});

	it("never creates history from viewport-only frames", () => {
		const vt = new Vt({ rows: 6 });
		for (let n = 1; n <= 6; n++) vt.present({ viewport: lines("v", 1, n), cursor: null });
		for (let n = 6; n >= 1; n--) vt.present({ viewport: lines("w", 1, n), cursor: null });
		for (let n = 1; n <= 6; n++) vt.present({ viewport: lines("x", n, 6), cursor: { row: 0, col: 1 } });
		expect(vt.term.scrollbackLength).toBe(0);
		expect(vt.screen()).toEqual(["x6", "", "", "", "", ""]);
	});

	it("leaves the shell's lines above the viewport", () => {
		const vt = new Vt({ rows: 6, shell: ["$ omp"] });
		vt.present({ viewport: ["hello", "status"], cursor: null });
		expect(vt.screen().slice(0, 3)).toEqual(["$ omp", "hello", "status"]);
		vt.present({ viewport: lines("v", 1, 6), cursor: null });
		expect(vt.scrollback()).toEqual(["$ omp"]);
		expect(vt.screen()).toEqual(lines("v", 1, 6));
	});

	it("starts at an unknown cursor position and still anchors history exactly", () => {
		const vt = new Vt({ rows: 5, blind: true, sync: false });
		let id = 0;
		const all: string[] = [];
		for (let block = 0; block < 4; block++) {
			const rows = lines(`b${block}.`, 1, 2);
			all.push(...rows);
			vt.present({ viewport: [...rows, "status"], cursor: null });
			vt.present({ history: { id: ++id, rows }, viewport: ["status"], cursor: null });
		}
		expect(vt.transcript()).toEqual([...all, "status"]);
	});
});

describe("viewport", () => {
	it("rewrites only the rows that changed", () => {
		const vt = new Vt({ rows: 6 });
		vt.present({ viewport: ["one", "two", "three", "four"], cursor: null });
		const mark = vt.writes.length;
		vt.present({ viewport: ["one", "TWO", "three", "four"], cursor: null });
		const bytes = vt.since(mark);
		expect(bytes).toContain("TWO");
		for (const row of ["one", "three", "four"]) expect(bytes).not.toContain(row);
		expect(vt.screen().slice(0, 4)).toEqual(["one", "TWO", "three", "four"]);
	});

	it("writes nothing for an unchanged frame", () => {
		const vt = new Vt();
		vt.present({ viewport: ["a", "b"], cursor: { row: 1, col: 1 } });
		const mark = vt.writes.length;
		vt.present({ viewport: ["a", "b"], cursor: { row: 1, col: 1 } });
		expect(vt.since(mark)).toBe("");
	});

	it("clears stale rows when the viewport shrinks", () => {
		const vt = new Vt({ rows: 6 });
		vt.present({ viewport: lines("r", 1, 5), cursor: null });
		vt.present({ viewport: ["r1", "x"], cursor: null });
		expect(vt.screen()).toEqual(["r1", "x", "", "", "", ""]);
	});

	it("width-fits rows with autowrap off and resets styles at row ends", () => {
		const vt = new Vt({ columns: 10, rows: 4 });
		vt.present({ viewport: ["\x1b[31mabcdefghijklmnop", "next"], cursor: null });
		expect(vt.screen().slice(0, 2)).toEqual(["abcdefghij", "next"]);
		expect(vt.term.cell(0, 1)?.fg).toEqual(vt.term.cell(0, 3)?.fg);
		expect(vt.term.mode(7)).toBe(1);
	});

	it("closes an open hyperlink at the row end", () => {
		const vt = new Vt({ rows: 3 });
		const mark = vt.writes.length;
		vt.present({ viewport: ["\x1b]8;;https://x.test\x1b\\link", "plain"], cursor: null });
		const bytes = vt.since(mark);
		expect(bytes.indexOf("\x1b]8;;\x1b\\")).toBeLessThan(bytes.indexOf("plain"));
		expect(vt.term.cell(0, 1)?.hyperlinkId ?? 0).toBe(0);
	});

	it("does not erase the last cell of a full-width row", () => {
		const vt = new Vt({ columns: 5, rows: 3 });
		vt.present({ viewport: ["abcde", "fghij"], cursor: null });
		vt.present({ viewport: ["vwxyz", "fghij"], cursor: null });
		expect(vt.screen()).toEqual(["vwxyz", "fghij", ""]);
	});
});

describe("images", () => {
	it("writes the image sequences before the frame's rows, once", () => {
		let queued = "\x1b_Ga=t,i=7;AAAA\x1b\\";
		const vt = new Vt({
			images: {
				takeSequences: () => {
					const out = queued;
					queued = "";
					return out;
				},
			},
		});
		const mark = vt.writes.length;
		vt.present({ viewport: ["caption", "pic"], cursor: null });
		const bytes = vt.since(mark);
		expect(bytes.indexOf("\x1b_Ga=t")).toBeGreaterThanOrEqual(0);
		expect(bytes.indexOf("\x1b_Ga=t")).toBeLessThan(bytes.indexOf("caption"));
		const again = vt.writes.length;
		vt.present({ viewport: ["caption", "pic"], cursor: null });
		expect(vt.since(again)).toBe("");
	});

	it("rewrites rows carrying graphics in place instead of shifting them", () => {
		const vt = new Vt({ rows: 6, sync: false });
		const image = "\x1b_Ga=p,i=1\x1b\\";
		vt.present({ viewport: ["a", `${image}`, "b", "status"], cursor: null });
		const mark = vt.writes.length;
		vt.present({ viewport: [`${image}`, "b", "c", "status"], cursor: null });
		expect(vt.since(mark)).not.toMatch(/\x1b\[\d*[LM]/);
		expect(vt.screen().slice(1, 4)).toEqual(["b", "c", "status"]);
		const removed = vt.writes.length;
		vt.present({ viewport: ["b", "c", "d", "status"], cursor: null });
		expect(vt.since(removed)).not.toMatch(/\x1b\[\d*[LM]/);
		expect(vt.screen().slice(0, 4)).toEqual(["b", "c", "d", "status"]);
	});

	it("erases an anchored image's last row before drawing the image, never after", () => {
		const vt = new Vt({ columns: 30, rows: 8 });
		vt.present({ viewport: ["prose", "stale one", "stale two", "stale three", "more"], cursor: null });
		const mark = vt.writes.length;
		const sixel = '\x1bP9;1;0q"1;1;20;18#0~\x1b\\';
		vt.present({ viewport: ["prose", ...anchoredRows(sixel, 3), "more"], cursor: null });
		const bytes = vt.since(mark);
		// The image's cells start at the restored cursor: an erase there clears the image's bottom row.
		const restored = bytes.slice(bytes.indexOf(sixel) + sixel.length);
		expect(restored.slice(0, restored.search(/\x1b\[\d*B|\n/))).not.toMatch(/\x1b\[\d*K/);
		// The row still loses the older, wider row's text.
		expect(vt.screen().slice(0, 5)).toEqual(["prose", "", "", "", "more"]);
	});
});

describe("cursor", () => {
	it("places a visible cursor at the frame position and hides it for null", () => {
		const vt = new Vt({ rows: 6, shell: ["$ omp"] });
		vt.present({ viewport: ["text", "> abc", "status"], cursor: { row: 1, col: 5 } });
		expect(vt.term.cursor).toMatchObject({ x: 5, y: 2, visible: true });
		vt.present({ viewport: ["text", "> abcd", "status"], cursor: { row: 1, col: 6 } });
		expect(vt.term.cursor).toMatchObject({ x: 6, y: 2, visible: true });
		vt.present({ viewport: ["text", "> abcd", "status"], cursor: null });
		expect(vt.term.cursor.visible).toBe(false);
	});

	it("keeps a resting cursor visible through synchronized frames", () => {
		const vt = new Vt({ rows: 4 });
		const mark = vt.writes.length;
		for (let tick = 0; tick < 4; tick++) {
			vt.present({ viewport: [`working ${"|/-\\"[tick]}`, "> "], cursor: { row: 1, col: 2 } });
		}
		const bytes = vt.since(mark);
		// A kitty-style terminal snapshots visibility at BSU: the cursor must be visible at every one.
		let visible = true;
		const presented: boolean[] = [];
		for (const [seq] of bytes.matchAll(/\x1b\[\?(?:25|2026)[hl]/g)) {
			if (seq === SYNC_BEGIN) presented.push(visible);
			else if (seq === CURSOR_HIDE) visible = false;
			else if (seq === "\x1b[?25h") visible = true;
		}
		expect(presented.length).toBe(4);
		expect(presented.every(Boolean)).toBe(true);
		expect(vt.term.cursor).toMatchObject({ x: 2, y: 1, visible: true });
	});
});

describe("unsynchronized frames", () => {
	it("never shows a row twice while content scrolls under fixed chrome", () => {
		const vt = new Vt({ columns: 24, rows: 8, sync: false });
		vt.present({ viewport: [...lines("line ", 1, 6), "status", "editor"], cursor: null });
		const { screens } = vt.presentObserved({ viewport: [...lines("line ", 4, 9), "status", "editor"], cursor: null });
		for (const screen of screens) {
			expect(duplicated(screen)).toEqual([]);
			expect(screen).toContain("status");
		}
		expect(vt.screen()).toEqual([...lines("line ", 4, 9), "status", "editor"]);
		expect(vt.term.scrollbackLength).toBe(0);
	});

	for (const { name, first, history } of [
		{ name: "rows already on screen", first: [...lines("a", 1, 6), "status", "editor"], history: lines("a", 1, 3) },
		{
			name: "rows scrolled out of a clipped viewport",
			first: [...lines("a", 4, 9), "status", "editor"],
			history: lines("a", 1, 5),
		},
	]) {
		it(`keeps chrome visible and scrollback exact when pushing ${name}`, () => {
			const vt = new Vt({ columns: 24, rows: 8, sync: false });
			vt.present({ viewport: first, cursor: null });
			const after = Number(history.at(-1)!.slice(1));
			const tail = lines("a", after + 1, after + 6);
			const { ack, screens } = vt.presentObserved({
				history: { id: 1, rows: history },
				viewport: [...tail, "status", "editor"],
				cursor: null,
			});
			expect(ack).toBe(1);
			for (const screen of screens) {
				expect(screen).toContain("status");
				expect(duplicated(screen)).toEqual([]);
			}
			expect(vt.scrollback()).toEqual(history);
			expect(vt.screen()).toEqual([...tail, "status", "editor"]);
		});
	}

	for (const [start, rows, shell] of [
		[7, 10, 1],
		[11, 6, 0],
		[23, 12, 20],
		[99, 8, 3],
	] as const) {
		it(`never tears across a random streaming session (seed ${start}, ${rows} rows)`, () => {
			// mulberry32: deterministic.
			let seed: number = start;
			const random = (n: number): number => {
				seed = (seed + 0x6d2b79f5) | 0;
				let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
				t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
				return ((t ^ (t >>> 14)) >>> 0) % n;
			};
			const vt = new Vt({ columns: 30, rows, sync: false, shell: lines("$ omp ", 1, shell) });
			const transcript: string[] = [];
			let live: string[] = [];
			let next = 1;
			let id = 0;
			for (let step = 0; step < 120; step++) {
				const action = random(5);
				let history: { id: number; rows: string[] } | undefined;
				if (action < 2) {
					for (let i = random(4); i >= 0; i--) live.push(`row ${next++}`);
				} else if (action === 2 && live.length > 0) {
					const count = 1 + random(live.length);
					history = { id: ++id, rows: live.slice(0, count) };
					transcript.push(...history.rows);
					live = live.slice(count);
				} else if (action === 3 && live.length > 0) {
					live[random(live.length)] += "*";
				} else if (live.length > 0) {
					live.splice(random(live.length), 1);
				}
				const chrome = [`status ${step % 3}`, "editor"];
				const room = rows - chrome.length;
				const viewport = [...live.slice(-room), ...chrome];
				const { screens } = vt.presentObserved({
					...(history ? { history } : {}),
					viewport,
					cursor: { row: viewport.length - 1, col: 0 },
				});
				for (const screen of screens) expect(duplicated(screen)).toEqual([]);
				// The cursor sits on the last viewport row; everything below it is blank.
				const bottom = vt.term.cursor.y;
				expect(vt.screen().slice(bottom - viewport.length + 1, bottom + 1)).toEqual(viewport);
				expect(
					vt
						.screen()
						.slice(bottom + 1)
						.every(row => row === ""),
				).toBe(true);
			}
			const scrolled = vt.scrollback().filter(row => !row.startsWith("$ omp") && row !== "");
			expect(scrolled.length).toBeGreaterThan(10);
			expect(transcript.slice(0, scrolled.length)).toEqual(scrolled);
			// The session exercised both line shifts.
			const all = vt.writes.join("");
			expect(all).toMatch(/\x1b\[\d*M/);
			expect(all).toMatch(/\x1b\[\d*L/);
		});
	}
});

describe("fullscreen", () => {
	it("draws on the alternate screen and restores the inline viewport and history", () => {
		const vt = new Vt({ rows: 5 });
		vt.present({ viewport: ["a", "b", "status"], cursor: { row: 2, col: 0 } });
		vt.present({ history: { id: 1, rows: ["a"] }, viewport: ["b", "status"], cursor: { row: 1, col: 0 } });
		expect(
			vt.present({ history: { id: 2, rows: ["b"] }, viewport: [], cursor: null, fullscreen: ["menu", "> item"] }),
		).toBeUndefined();
		expect(vt.term.isMainScreen).toBe(false);
		expect(vt.screen()).toEqual(["menu", "> item", "", "", ""]);
		const mark = vt.writes.length;
		vt.present({ viewport: [], cursor: { row: 1, col: 6 }, fullscreen: ["menu", "> item2"] });
		expect(vt.since(mark)).not.toContain("menu");
		expect(vt.term.cursor).toMatchObject({ x: 6, y: 1, visible: true });
		vt.present({ viewport: ["b", "status"], cursor: { row: 1, col: 0 } });
		expect(vt.term.isMainScreen).toBe(true);
		expect(vt.transcript()).toEqual(["a", "b", "status"]);
		expect(vt.present({ history: { id: 2, rows: ["b"] }, viewport: ["status"], cursor: null })).toBe(2);
		expect(vt.transcript()).toEqual(["a", "b", "status"]);
	});
});

describe("display reset", () => {
	it("clears history and replays the ledger in the same write as the frame", () => {
		const vt = new Vt({ rows: 4 });
		vt.present({ history: { id: 1, rows: lines("old", 1, 6) }, viewport: ["status"], cursor: null });
		expect(vt.term.scrollbackLength).toBeGreaterThan(0);
		vt.writer.resetDisplay();
		expect(vt.invalidations).toEqual(["replay"]);
		const mark = vt.writes.length;
		expect(
			vt.present({
				history: { id: 2, rows: lines("new", 1, 5), kind: "replay" },
				viewport: ["status"],
				cursor: null,
			}),
		).toBe(2);
		expect(vt.writes.length).toBe(mark + 1);
		expect(vt.transcript()).toEqual([...lines("new", 1, 5), "status"]);
	});
});

describe("shutdown", () => {
	it("leaves the alternate screen and puts the cursor after the content", () => {
		const vt = new Vt({ rows: 6 });
		vt.present({ viewport: ["a", "b", "", ""], cursor: { row: 0, col: 1 } });
		vt.present({ viewport: [], cursor: null, fullscreen: ["modal"] });
		vt.writer.stop();
		expect(vt.term.isMainScreen).toBe(true);
		expect(vt.term.cursor).toMatchObject({ x: 0, y: 2, visible: true });
		expect(vt.term.mode(7)).toBe(1);
		expect(vt.screen().slice(0, 2)).toEqual(["a", "b"]);
	});
});
