import { beforeAll, describe, expect, it } from "bun:test";
import {
	TranscriptContainer,
	type TranscriptStableRow,
} from "@oh-my-pi/pi-coding-agent/modes/components/transcript-container";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { Component } from "@oh-my-pi/pi-tui";

class Block implements Component {
	#rows: string[];
	#finalized: boolean;
	allocations: number[] = [];

	constructor(rows: string[], finalized: boolean) {
		this.#rows = rows;
		this.#finalized = finalized;
	}

	finalize(rows: string[]): void {
		this.#rows = rows;
		this.#finalized = true;
	}

	isTranscriptBlockFinalized(): boolean {
		return this.#finalized;
	}

	setTranscriptAllocation(rows: number): void {
		this.allocations.push(rows);
	}

	render(): readonly string[] {
		return this.#rows;
	}
}
class SettledRowsBlock extends Block {
	constructor(
		rows: string[],
		readonly settledRows: number,
	) {
		super(rows, false);
	}

	getTranscriptBlockSettledRows(): number {
		return this.settledRows;
	}
}

function literalStableRow(row: string): TranscriptStableRow {
	return { key: row };
}

class AppendBlock extends Block {
	readonly transcriptBlockMode = "appendOnly" as const;
	#stable: readonly TranscriptStableRow[];
	#stableRender: readonly string[];

	constructor(rows: string[], stable: readonly string[], finalized = false) {
		super(rows, finalized);
		this.#stable = stable.map(literalStableRow);
		this.#stableRender = stable;
	}

	publish(rows: readonly string[]): void {
		this.#stable = rows.map(literalStableRow);
		this.#stableRender = rows;
	}

	publishStable(rows: readonly TranscriptStableRow[], rendered: readonly string[]): void {
		this.#stable = rows;
		this.#stableRender = rendered;
	}

	/** Change the block's full render without finalizing (e.g. hiding thinking). */
	revise(rows: string[]): void {
		this.finalize(rows);
	}

	resetTranscriptStableRows(): void {
		this.#stable = [];
		this.#stableRender = [];
	}

	getTranscriptStableRows(): readonly TranscriptStableRow[] {
		return this.#stable;
	}

	renderTranscriptStableRows(count: number, _width: number): readonly string[] {
		return this.#stableRender.slice(0, count);
	}
}

class ReflowingAppendBlock implements Component {
	readonly transcriptBlockMode = "appendOnly" as const;
	#finalized = false;
	readonly #stable: TranscriptStableRow = { key: "abcdefgh" };

	isTranscriptBlockFinalized(): boolean {
		return this.#finalized;
	}

	finalize(): void {
		this.#finalized = true;
	}

	getTranscriptStableRows(): readonly TranscriptStableRow[] {
		return [this.#stable];
	}

	renderTranscriptStableRows(count: number, width: number): readonly string[] {
		if (count <= 0) return [];
		const rows: string[] = [];
		for (let offset = 0; offset < 8; offset += width) rows.push("abcdefgh".slice(offset, offset + width));
		return rows;
	}

	render(width: number): readonly string[] {
		return [...this.renderTranscriptStableRows(1, width), this.#finalized ? "final" : "partial"];
	}
}

const frame = { tick: 0, now: 0 };

describe("TranscriptContainer", () => {
	it("protects physically borrowed blocks without freezing later live blocks", () => {
		const transcript = new TranscriptContainer();
		const borrowed = new Block(["first", "second"], false);
		const live = new Block(["later"], false);
		transcript.addChild(borrowed);
		transcript.addChild(live);
		transcript.renderViewport(40, 10, frame);
		transcript.setBorrowedViewportRows(1);
		expect(transcript.isBlockUncommitted(borrowed)).toBe(false);
		expect(transcript.canRemoveBlock(borrowed)).toBe(false);
		expect(transcript.isBlockUncommitted(live)).toBe(true);
		expect(transcript.canRemoveBlock(live)).toBe(true);
		transcript.removeChild(borrowed);
		transcript.removeChild(live);
		expect(transcript.children).toEqual([borrowed]);
	});

	it("retains only the actual borrowed rows of surviving owners after finalized drift", () => {
		for (const borrowedRows of [2, 4]) {
			const transcript = new TranscriptContainer();
			const finalized = new Block(["old", "same"], false);
			const live = new Block(["same", "live", "editor"], false);
			transcript.addChild(finalized);
			transcript.addChild(live);
			transcript.renderViewport(80, 10, frame);
			transcript.setBorrowedViewportRows(borrowedRows);
			finalized.finalize(["new", "same"]);
			const history = transcript.peekFinalizedBatch(80, 0);
			expect(history?.rows).toEqual(["new", "same", ""]);
			expect(transcript.renderViewport(80, 10, frame)).toEqual(["same", "live", "editor"]);
			expect(transcript.borrowedViewportRowCount()).toBe(borrowedRows === 4 ? 1 : 0);
			expect(transcript.canRemoveBlock(live)).toBe(borrowedRows === 2);
		}
	});

	it("captures mutable by default and append-only declarations permanently", () => {
		const transcript = new TranscriptContainer();
		const mutable = new Block(["mutable"], false) as Block & {
			transcriptBlockMode?: "appendOnly";
			getTranscriptStableRows?: () => readonly TranscriptStableRow[];
		};
		transcript.addChild(mutable);
		mutable.transcriptBlockMode = "appendOnly";
		mutable.getTranscriptStableRows = () => [literalStableRow("mutable")];
		transcript.addChild(new AppendBlock(["stable", "partial"], ["stable"]));

		expect(transcript.blockModes()).toEqual(["mutable", "appendOnly"]);
	});

	it("freezes a retracting publication and keeps rendering the block", () => {
		const transcript = new TranscriptContainer();
		const block = new AppendBlock(["one", "two"], ["one"]);
		transcript.addChild(block);
		expect(transcript.renderViewport(80, 2, frame)).toEqual(["one", "two"]);

		// Retraction cannot be honored (rows may already sit in scrollback):
		// the block demotes to finalize-time retirement but never fails a render.
		block.publish(["changed"]);
		expect(transcript.renderViewport(80, 2, frame)).toEqual(["one", "two"]);
		expect(transcript.blockModes()).toEqual(["appendOnly"]);
	});

	it("freezes drifted stable bytes, keeps the emitted slice, and retires the remainder once", () => {
		const transcript = new TranscriptContainer();
		const block = new AppendBlock(["one", "two"], ["one"]);
		transcript.addChild(block);
		expect(transcript.renderViewport(80, 2, frame)).toEqual(["one", "two"]);

		const emitted = transcript.peekFinalizedBatch(80, 0)!;
		expect(emitted.rows).toEqual(["one"]);
		transcript.acknowledgeFinalizedBatch(emitted.id);

		// Published bytes drift (e.g. a mid-stream theme change): the emitted
		// slice stays retired, the live tail keeps rendering, and no further
		// mid-stream row is offered.
		block.publishStable([literalStableRow("one"), literalStableRow("two")], ["one", "changed physical row"]);
		expect(transcript.renderViewport(80, 2, frame)).toEqual(["two"]);
		expect(transcript.peekFinalizedBatch(80, 0)).toBeUndefined();

		// Finalization retires exactly the un-emitted suffix.
		block.finalize(["one", "two"]);
		expect(transcript.peekFinalizedBatch(80, 0)?.rows).toEqual(["two", ""]);
	});

	it("emits only the stable current head under row pressure", () => {
		const transcript = new TranscriptContainer();
		const head = new Block(["mutable head"], false);
		const later = new AppendBlock(["later stable", "later partial"], ["later stable"]);
		transcript.addChild(head);
		transcript.addChild(later);

		expect(transcript.peekFinalizedBatch(80, 1)).toBeUndefined();

		head.finalize(["mutable head"]);
		const retired = transcript.peekFinalizedBatch(80, 1);
		expect(retired?.rows).toEqual(["mutable head", ""]);
		transcript.acknowledgeFinalizedBatch(retired!.id);

		const emitted = transcript.peekFinalizedBatch(80, 1);
		expect(emitted?.rows).toEqual(["later stable"]);
		expect(transcript.renderViewport(80, 1, frame)).toEqual(["later partial"]);
	});

	it("retires only the un-emitted final suffix", () => {
		const transcript = new TranscriptContainer();
		const block = new AppendBlock(["one", "two", "partial"], ["one", "two"]);
		transcript.addChild(block);

		const first = transcript.peekFinalizedBatch(80, 2)!;
		expect(first.rows).toEqual(["one"]);
		transcript.acknowledgeFinalizedBatch(first.id);
		const second = transcript.peekFinalizedBatch(80, 1)!;
		expect(second.rows).toEqual(["two"]);
		transcript.acknowledgeFinalizedBatch(second.id);

		block.finalize(["one", "two", "final"]);
		const suffix = transcript.peekFinalizedBatch(80, 0)!;
		expect(suffix.rows).toEqual(["final", ""]);
	});

	it("advances a fully emitted finalized head without a physical write", () => {
		const transcript = new TranscriptContainer();
		const block = new AppendBlock(["complete"], ["complete"]);
		transcript.addChild(block);
		const emitted = transcript.peekFinalizedBatch(80, 0)!;
		transcript.acknowledgeFinalizedBatch(emitted.id);

		block.finalize(["complete"]);
		expect(transcript.peekFinalizedBatch(80, 0)).toBeUndefined();
		expect(transcript.blockStates()).toEqual(["committed"]);
	});

	it("replays and retires semantic stable rows after they reflow at a new width", () => {
		const transcript = new TranscriptContainer();
		const block = new ReflowingAppendBlock();
		transcript.addChild(block);

		const emitted = transcript.peekFinalizedBatch(4, 2)!;
		expect(emitted.rows).toEqual(["abcd", "efgh"]);
		transcript.acknowledgeFinalizedBatch(emitted.id);
		expect(transcript.renderViewport(8, 1, frame)).toEqual(["partial"]);

		transcript.beginReplay();
		const replay = transcript.peekReplayBatch(8)!;
		expect(replay.rows).toEqual(["abcdefgh"]);
		transcript.acknowledgeFinalizedBatch(replay.id);

		block.finalize();
		const suffix = transcript.peekFinalizedBatch(8, 0)!;
		expect(suffix.rows).toEqual(["final", ""]);
	});

	it("drops emitted stable rows on reset so a replay honors a hidden presentation (#10177)", () => {
		const transcript = new TranscriptContainer();
		// A thinking block whose reasoning prefix streams into scrollback ahead of
		// its answer while the whole block is still the live frontier head.
		const block = new AppendBlock(["reasoning one", "reasoning two", "answer"], ["reasoning one", "reasoning two"]);
		transcript.addChild(block);

		const first = transcript.peekFinalizedBatch(80, 1)!;
		expect(first.rows).toEqual(["reasoning one"]);
		transcript.acknowledgeFinalizedBatch(first.id);
		const second = transcript.peekFinalizedBatch(80, 1)!;
		expect(second.rows).toEqual(["reasoning two"]);
		transcript.acknowledgeFinalizedBatch(second.id);
		expect(transcript.emittedStableRows()).toEqual([2]);

		// Ctrl+T hides thinking: the block now renders only its answer and drops
		// its published reasoning snapshots. resetStableEmission forgets the
		// emitted prefix so the paired destructive replay does not resurrect the
		// captured reasoning that visibly streamed into scrollback.
		block.revise(["answer"]);
		transcript.resetStableEmission();
		expect(transcript.emittedStableRows()).toEqual([0]);

		transcript.beginReplay();
		expect(transcript.peekReplayBatch(80)).toBeUndefined();
		expect(transcript.renderViewport(80, 5, frame)).toEqual(["answer"]);
	});

	beforeAll(async () => {
		await initTheme(false);
	});

	it("keeps settled blocks live while the viewport has room", () => {
		const transcript = new TranscriptContainer();
		transcript.addChild(new Block(["settled"], true));
		transcript.addChild(new Block(["streaming"], false));

		// Both fit: nothing retires, the settled block still renders live.
		expect(transcript.peekFinalizedBatch(80, 10)).toBeUndefined();
		expect(transcript.renderViewport(80, 10, frame)).toEqual(["settled", "", "streaming"]);
	});

	it("retires the settled prefix only under capacity pressure, in order", () => {
		const transcript = new TranscriptContainer();
		const first = new Block(["first final"], true);
		const second = new Block(["second live", "row", "row"], false);
		transcript.addChild(first);
		transcript.addChild(second);

		// 5 rows fit everything (1 + separator + 3).
		expect(transcript.peekFinalizedBatch(80, 5)).toBeUndefined();
		// 3 rows force the settled prefix out.
		expect(transcript.peekFinalizedBatch(80, 3)?.rows).toEqual(["first final", ""]);
	});

	it("never retires a finalized successor past an active predecessor", () => {
		const transcript = new TranscriptContainer();
		const active = new Block(["active live"], false);
		const settled = new Block(["settled final"], true);
		transcript.addChild(active);
		transcript.addChild(settled);

		// Pressure exists but the prefix starts with an active block: no batch,
		// and both blocks still render (clipped by the viewport).
		expect(transcript.peekFinalizedBatch(80, 1)).toBeUndefined();
		expect(transcript.renderViewport(80, 10, frame)).toEqual(["active live", "", "settled final"]);

		active.finalize(["active final"]);
		// Capacity 1 fits the remaining settled block, so only the first retires.
		expect(transcript.peekFinalizedBatch(80, 1)?.rows).toEqual(["active final", ""]);
	});

	it("reoffers an unacknowledged batch and retires it exactly once", () => {
		const transcript = new TranscriptContainer();
		transcript.addChild(new Block(["final one"], true));
		transcript.addChild(new Block(["final two"], true));
		const first = transcript.peekFinalizedBatch(80, 0);
		const second = transcript.peekFinalizedBatch(80, 50);

		expect(second).toEqual(first);
		if (first === undefined) throw new Error("expected a batch under zero capacity");
		transcript.acknowledgeFinalizedBatch(first.id);
		// Committed blocks leave the live tail and never render again.
		expect(transcript.renderViewport(80, 10, frame)).toEqual([]);
		expect(transcript.peekFinalizedBatch(80, 10)).toBeUndefined();
	});

	it("excludes an offered batch from the live viewport in the same frame", () => {
		const transcript = new TranscriptContainer();
		transcript.addChild(new Block(["old settled"], true));
		transcript.addChild(new Block(["fresh live"], false));

		const batch = transcript.peekFinalizedBatch(80, 1);
		expect(batch?.rows).toEqual(["old settled", ""]);
		expect(transcript.renderViewport(80, 1, frame)).toEqual(["fresh live"]);
	});

	it("preserves every logical row when live content exceeds terminal capacity", () => {
		const transcript = new TranscriptContainer();
		const block = new Block(["A1", "A2", "A3", "A4"], false);
		transcript.addChild(block);

		expect(transcript.renderViewport(80, 2, frame)).toEqual(["A1", "A2", "A3", "A4"]);
		block.finalize(["A1", "A2", "A3", "A4"]);
		expect(transcript.renderViewport(80, 2, frame)).toEqual(["A1", "A2", "A3", "A4"]);
	});
	it("keeps a tall finalized block live when its visible tail still fits", () => {
		const transcript = new TranscriptContainer();
		const block = new Block(
			Array.from({ length: 40 }, (_value, index) => `row-${index}`),
			true,
		);
		transcript.addChild(block);

		expect(transcript.peekFinalizedBatch(80, 30)).toBeUndefined();
		expect(transcript.renderViewport(80, 30, frame)).toHaveLength(40);
	});

	it("emits only the settled prefix that actually overflows", () => {
		const transcript = new TranscriptContainer();
		const block = new SettledRowsBlock(
			Array.from({ length: 40 }, (_value, index) => `row-${index}`),
			40,
		);
		transcript.addChild(block);

		const batch = transcript.peekFinalizedBatch(80, 30);
		expect(batch?.rows).toEqual(Array.from({ length: 10 }, (_value, index) => `row-${index}`));
		transcript.acknowledgeFinalizedBatch(batch!.id);
		expect(transcript.renderViewport(80, 30, frame)).toEqual(
			Array.from({ length: 30 }, (_value, index) => `row-${index + 10}`),
		);
	});

	it("replays a mutable settled prefix before rendering its live suffix", () => {
		const transcript = new TranscriptContainer();
		const block = new SettledRowsBlock(
			Array.from({ length: 40 }, (_value, index) => `row-${index}`),
			40,
		);
		transcript.addChild(block);

		const first = transcript.peekFinalizedBatch(80, 30);
		expect(first?.rows).toEqual(Array.from({ length: 10 }, (_value, index) => `row-${index}`));
		transcript.acknowledgeFinalizedBatch(first!.id);
		expect(transcript.renderViewport(80, 30, frame)).toEqual(
			Array.from({ length: 30 }, (_value, index) => `row-${index + 10}`),
		);

		transcript.beginReplay();
		const replay = transcript.peekReplayBatch(80);
		expect(replay?.rows).toEqual(Array.from({ length: 10 }, (_value, index) => `row-${index}`));
		expect(transcript.renderViewport(80, 30, frame)).toEqual(
			Array.from({ length: 30 }, (_value, index) => `row-${index + 10}`),
		);
		transcript.acknowledgeFinalizedBatch(replay!.id);
		expect(transcript.peekReplayBatch(80)).toBeUndefined();
		expect(transcript.renderViewport(80, 30, frame)).toEqual(
			Array.from({ length: 30 }, (_value, index) => `row-${index + 10}`),
		);
	});

	it("replays committed history without rewinding lifecycle state", () => {
		const transcript = new TranscriptContainer();
		transcript.addChild(new Block(["final"], true));
		const first = transcript.peekFinalizedBatch(80, 0);
		if (first === undefined) throw new Error("expected initial batch");
		transcript.acknowledgeFinalizedBatch(first.id);
		expect(transcript.blockStates()).toEqual(["committed"]);

		transcript.beginReplay();
		expect(transcript.renderViewport(80, 10, frame)).toEqual([]);
		const replay = transcript.peekFinalizedBatch(80, 10);
		expect(replay?.id).toBeGreaterThan(first.id);
		expect(replay?.rows).toEqual(["final", ""]);
		transcript.acknowledgeFinalizedBatch(replay!.id);
		expect(transcript.blockStates()).toEqual(["committed"]);
		expect(transcript.peekFinalizedBatch(80, 0)).toBeUndefined();
	});

	it("flushes a finalized prefix without viewport pressure", () => {
		const transcript = new TranscriptContainer();
		transcript.addChild(new Block(["fits"], true));

		expect(transcript.peekFinalizedBatch(80, 10)).toBeUndefined();
		expect(transcript.peekFlushBatch(80)?.rows).toEqual(["fits", ""]);
	});

	it("keeps the live viewport while an independent replay is offered", () => {
		const transcript = new TranscriptContainer();
		transcript.addChild(new Block(["committed"], true));
		const committed = transcript.peekFinalizedBatch(80, 0)!;
		transcript.acknowledgeFinalizedBatch(committed.id);
		transcript.addChild(new Block(["active"], false));

		transcript.beginReplay();
		expect(transcript.peekFinalizedBatch(80, 10)?.rows).toEqual(["committed", ""]);
		expect(transcript.renderViewport(80, 10, frame)).toEqual(["active"]);
	});
	it("renders exactly the trailing semantic rows without walking the full ledger", () => {
		const transcript = new TranscriptContainer();
		transcript.addChild(new Block(["a1", "a2"], true));
		transcript.addChild(new Block([], true));
		transcript.addChild(new AppendBlock(["b1", "b2"], ["b1"], true));
		transcript.addChild(new Block(["c1"], false));

		const full = transcript.render(80);
		for (const cap of [1, 3, 4, full.length, full.length + 5]) {
			expect(transcript.renderTail(80, cap)).toEqual(full.slice(-Math.min(cap, full.length)));
		}
		expect(transcript.renderTail(80, 0)).toEqual([]);
	});

	it("cancels a pending replay so shutdown flush emits only un-retired rows", () => {
		const transcript = new TranscriptContainer();
		transcript.addChild(new Block(["committed"], true));
		const committed = transcript.peekFinalizedBatch(80, 0)!;
		transcript.acknowledgeFinalizedBatch(committed.id);
		transcript.addChild(new Block(["tail"], true));

		transcript.beginReplay();
		transcript.cancelReplay();
		expect(transcript.peekFlushBatch(80)?.rows).toEqual(["tail", ""]);
	});
});
