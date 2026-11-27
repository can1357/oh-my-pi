/**
 * Conformance of the frame writer to the Elastic Speculative Slots protocol
 * (https://stencil.so/blog/harness-playbook/elastic-slots.pdf): the streaming
 * realization of a history append (Lemma 4.8) and write-failure fail-stop
 * (RetireFailure, Remark 4.10).
 *
 * Tests tagged ES-nn encode a finding of the conformance review: the
 * counterexample it found, which the writer must keep handling.
 */
import { describe, expect, it } from "bun:test";
import type { FramePlan } from "@oh-my-pi/pi-tui/driver/contract";
import { FrameWriter } from "@oh-my-pi/pi-tui/driver/output/writer";
import { KittyTerminal } from "kitty-vt-wasm";
import { lines, Vt } from "./vt";

describe("history under an empty viewport (Lemma 4.8 with |Q′| = 0)", () => {
	// The writer anchors the viewport on the last screen row even when the frame has no viewport
	// row and history already fills the screen: that row holds the batch's last history row, and
	// the next frame (or the shell prompt after a stop) is written over it.
	for (const sync of [true, false]) {
		const mode = sync ? "synchronized" : "unsynchronized";
		it(`ES-04 keeps the last history row of a batch that fills the screen (${mode})`, () => {
			const vt = new Vt({ rows: 4, sync });
			expect(vt.present({ history: { id: 1, rows: lines("h", 1, 6) }, viewport: [], cursor: null })).toBe(1);
			expect(vt.transcript()).toEqual(lines("h", 1, 6));
			vt.present({ viewport: ["v1"], cursor: null });
			expect(vt.transcript()).toEqual([...lines("h", 1, 6), "v1"]);
		});
	}

	it("ES-04 keeps every row of consecutive batches written under an empty viewport", () => {
		const vt = new Vt({ rows: 4 });
		vt.present({ history: { id: 1, rows: lines("h", 1, 4) }, viewport: [], cursor: null });
		vt.present({ history: { id: 2, rows: lines("g", 1, 2) }, viewport: [], cursor: null });
		vt.present({ viewport: ["v1", "v2"], cursor: null });
		expect(vt.transcript()).toEqual([...lines("h", 1, 4), ...lines("g", 1, 2), "v1", "v2"]);
	});

	it("ES-04 hands the cursor back below the last history row", () => {
		const vt = new Vt({ rows: 4 });
		vt.present({ history: { id: 1, rows: lines("h", 1, 6) }, viewport: [], cursor: null });
		vt.writer.stop();
		// The shell prints its prompt at the cursor: that line must not hold a history row.
		expect(vt.term.line(vt.term.cursor.y).trimEnd()).toBe("");
		expect(vt.transcript()).toEqual(lines("h", 1, 6));
	});

	it("anchors below history that leaves room on the screen", () => {
		const vt = new Vt({ rows: 4 });
		vt.present({ history: { id: 1, rows: lines("h", 1, 3) }, viewport: [], cursor: null });
		vt.present({ viewport: ["v1", "v2"], cursor: null });
		expect(vt.transcript()).toEqual([...lines("h", 1, 3), "v1", "v2"]);
		expect(vt.scrollback()).toEqual(["h1"]);
	});
});

describe("write failure (RetireFailure, Theorem 4.16(vi))", () => {
	// A failed write must leave the commit frontier where it was and stop the host: the batch is
	// never acknowledged and nothing is written after it. The writer records the id as written
	// before the sink took the bytes, so offering the batch again acknowledges it unwritten.
	it("ES-08 neither acknowledges nor writes past a history batch whose write failed", () => {
		const term = KittyTerminal.createSync({ columns: 20, rows: 4, scrollback: 100 });
		let failing = false;
		let writes = 0;
		const writer = new FrameWriter({
			sink: {
				write: data => {
					writes++;
					if (failing) {
						// The terminal took a prefix of the frame, then the descriptor failed.
						term.write(data.slice(0, data.indexOf("a3")));
						throw Object.assign(new Error("write EIO"), { code: "EIO" });
					}
					term.write(data);
				},
				flush: async () => {},
			},
			columns: 20,
			rows: 4,
			synchronizedOutput: () => true,
			multiplexer: () => false,
		});
		writer.start({ row: 0, col: 0 });
		writer.present({ viewport: ["live", "status"], cursor: null });
		const frame: FramePlan = {
			history: { id: 1, rows: ["a1", "a2", "a3", "a4", "a5", "a6"] },
			viewport: ["a7", "status"],
			cursor: null,
		};
		const offer = (): number | undefined => {
			try {
				return writer.present(frame);
			} catch {
				return undefined;
			}
		};
		failing = true;
		expect(offer()).toBeUndefined();
		failing = false;
		const failed = writes;
		// Fail-stop, not fail-retry: the frontier stays, the terminal keeps the prefix it took.
		expect(offer()).toBeUndefined();
		expect(writes).toBe(failed);
	});
});

describe("height shrink (Resize-tagged rows)", () => {
	// A shrink pushes the top viewport rows into scrollback before the program hears of it. When the
	// cursor report confirms the terminal pushed them, a batch starting with those rows skips them;
	// a report elsewhere (a terminal that dropped rows instead) writes them: duplicates, never a loss.
	for (const confirmed of [true, false]) {
		it(`skips rows the shrink pushed only when the cursor report confirms it (${confirmed ? "confirmed" : "elsewhere"})`, async () => {
			const vt = new Vt({
				rows: 6,
				...(confirmed ? {} : { queryCursor: async () => ({ row: 5, col: 0 }) }),
			});
			vt.present({ viewport: ["v0", "v1", "v2", "v3", "v4", "dock"], cursor: { row: 5, col: 0 } });
			vt.resize(20, 4);
			await vt.settle();
			const mark = vt.writes.length;
			vt.present({
				history: {
					id: 1,
					rows: ["v0", "v1", "v2"],
					marks: [
						{ row: 0, before: "\x1b]133;A\x07", after: "\x1b]133;B\x07" },
						{ row: 2, before: "\x1b]133;A\x07", after: "\x1b]133;B\x07" },
					],
				},
				viewport: ["v3", "v4", "dock"],
				cursor: null,
			});
			const written = vt.since(mark);
			expect(written).toContain("\x1b]133;A\x07v2\x1b]133;B\x07");
			if (confirmed) {
				expect(written).not.toContain("v0");
				expect(vt.transcript()).toEqual(["v0", "v1", "v2", "v3", "v4", "dock"]);
			} else {
				expect(written).toContain("\x1b]133;A\x07v0\x1b]133;B\x07");
			}
		});
	}
});
