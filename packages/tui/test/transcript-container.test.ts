import { beforeAll, describe, expect, it } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { AssistantMessageComponent } from "@oh-my-pi/pi-tui/chat/assistant-message";
import { UserMessageComponent } from "@oh-my-pi/pi-tui/chat/user-message";
import {
	TranscriptContainer,
	type ScrollableTranscriptProjection,
	type TranscriptStableRow,
	type TranscriptViewportCursor,
	trimBlankEdges,
} from "@oh-my-pi/pi-tui/chrome/transcript-container";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import type { Component, HistoryBatch } from "@oh-my-pi/pi-tui";

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

	replace(rows: string[]): void {
		this.#rows = rows;
	}

	isTranscriptBlockFinalized(): boolean {
		return this.#finalized;
	}

	setTranscriptAllocation(rows: number): void {
		this.allocations.push(rows);
	}

	render(_width?: number): readonly string[] {
		return this.#rows;
	}
}

class FinalizationCountingBlock extends Block {
	finalizationChecks = 0;
	renderCalls = 0;

	override isTranscriptBlockFinalized(): boolean {
		this.finalizationChecks++;
		return super.isTranscriptBlockFinalized();
	}

	override render(width?: number): readonly string[] {
		this.renderCalls++;
		return super.render(width);
	}
}

/** A live block the container recognizes as dynamic tool-activity. */
class ToolBlock extends Block {
	setToolActivityVisible(): void {}
}

/** A settled block whose render costs real wall-clock time, like a markdown-heavy message. */
class SlowBlock extends Block {
	#costMs: number;

	constructor(rows: string[], costMs: number) {
		super(rows, true);
		this.#costMs = costMs;
	}

	override render(): readonly string[] {
		const until = performance.now() + this.#costMs;
		while (performance.now() < until) {}
		return super.render();
	}
}

/** A settled block that records how often the container rendered it. */
class CountingBlock extends Block {
	renders = 0;

	constructor(rows: string[]) {
		super(rows, true);
	}

	override render(): readonly string[] {
		this.renders++;
		return super.render();
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
const finalAnswer: AssistantMessage = {
	role: "assistant",
	content: [
		{ type: "thinking", thinking: "Reasoning first" },
		{ type: "text", text: "## Implemented" },
	],
	api: "openai-codex-responses",
	provider: "openai-codex",
	model: "gpt-5.6-sol",
	stopReason: "stop",
	usage: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	timestamp: 1,
};

const frame = { tick: 0, now: 0 };

describe("TranscriptContainer", () => {
	it("preserves retirement while externally reordered and replaced live children settle", () => {
		const transcript = new TranscriptContainer();
		const archived = new Block(["archived"], true);
		transcript.addChild(archived);
		const history = transcript.peekFlushBatch(80);
		if (!history) throw new Error("Expected history batch");
		transcript.acknowledgeFinalizedBatch(history.id);
		const first = new Block(["first"], false);
		const second = new Block(["second"], false);
		transcript.addChild(first);
		transcript.addChild(second);
		transcript.children.splice(1, 2, second, first);
		expect(transcript.renderViewport(80, 10, frame)).toEqual(["second", "", "first"]);
		const replacement = new Block(["replacement"], false);
		transcript.children = [archived, second, replacement];
		expect(transcript.renderViewport(80, 10, frame)).toEqual(["second", "", "replacement"]);
		transcript.children[1] = first;
		first.finalize(["first done"]);
		replacement.finalize(["replacement done"]);
		const final = transcript.peekFlushBatch(80);
		expect(final?.rows).toEqual(["first done", "", "replacement done", ""]);
		if (!final) throw new Error("Expected live retirement batch");
		transcript.acknowledgeFinalizedBatch(final.id);
		expect(transcript.peekFlushBatch(80)).toBeUndefined();
		transcript.beginReplay();
		expect(transcript.peekReplayBatch(80)?.rows).toEqual(["archived", "", "first done", "", "replacement done", ""]);
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

	it("freezes same-length drift in a reused render buffer without changing emitted history", () => {
		const transcript = new TranscriptContainer();
		const stableRender = ["one"];
		const fullRender = ["one", "tail"];
		const block = new (class extends AppendBlock {
			override renderTranscriptStableRows(count: number): readonly string[] {
				return count === stableRender.length ? stableRender : stableRender.slice(0, count);
			}
		})(fullRender, stableRender);
		transcript.addChild(block);

		const emitted = transcript.peekFinalizedBatch(80, 1);
		if (!emitted) throw new Error("Expected stable history batch");
		transcript.acknowledgeFinalizedBatch(emitted.id);

		stableRender[0] = "changed";
		fullRender[0] = "changed";
		expect(transcript.renderViewport(80, 2, frame)).toEqual(["tail"]);
		expect(emitted.rows).toEqual(["one"]);

		// Restoring the old prefix does not unfreeze publication.
		stableRender.splice(0, 1, "one", "two");
		fullRender.splice(0, 2, "one", "two", "tail");
		block.publish(stableRender);
		expect(transcript.peekFinalizedBatch(80, 0)).toBeUndefined();
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

	it("counts multi-row snapshot prefixes by rendered rows, not snapshot count", () => {
		// One snapshot rendering to 4 physical rows: the old min(rows, count)
		// memo returned 1 row for count=1 and the container redrew retired
		// content into the live region. The per-(width,count) memo returns
		// the real rendered length.
		const transcript = new TranscriptContainer();
		const block = new ReflowingAppendBlock();
		transcript.addChild(block);
		// Prime the container through a live-count pass at width 2: one
		// snapshot -> 4 physical rows.
		transcript.liveRowCount(2);
		transcript.liveRowCount(2);
		const viewport = transcript.renderViewport(2, 10, frame);
		expect(viewport.length).toBeGreaterThan(1);
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
		expect(transcript.render(80)).toEqual(["complete"]);
		transcript.beginReplay();
		expect(transcript.peekReplayBatch(80)?.rows).toEqual(["complete", ""]);
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

		// Under pressure the finished rows the overflow needs retire in one batch.
		const first = transcript.peekFinalizedBatch(80, 1)!;
		expect(first.rows).toEqual(["reasoning one", "reasoning two"]);
		transcript.acknowledgeFinalizedBatch(first.id);
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

	it("never replays a frame's measurements after the block changes outside that frame", () => {
		const transcript = new TranscriptContainer();
		const block = new Block(["draft"], false);
		transcript.addChild(block);
		const first = { tick: 0, now: 0 };
		transcript.beginFrame(first);
		expect(transcript.liveRowCount(80)).toBe(1);
		expect(transcript.renderViewport(80, 5, first)).toEqual(["draft"]);

		// The viewport closed the frame: a later peek measures the change.
		block.finalize(["revised", "twice"]);
		expect(transcript.liveRowCount(80)).toBe(2);

		// A viewport for a different frame discards the open frame's measurements.
		transcript.beginFrame({ tick: 1, now: 16 });
		expect(transcript.peekFinalizedBatch(80, 5)).toBeUndefined();
		block.finalize(["late"]);
		expect(transcript.renderViewport(80, 5, { tick: 2, now: 32 })).toEqual(["late"]);
	});

	it("assigns one row per live block until pressure requires aggregation", () => {
		const transcript = new TranscriptContainer();
		transcript.addChild(new Block(["first"], false));
		transcript.addChild(new Block(["second"], false));

		expect(transcript.renderViewport(80, 2, frame)).toEqual(["first", "second"]);
		expect(transcript.canAdmit(2)).toBe(false);
		expect(transcript.renderViewport(80, 1, frame)).toEqual(["1 more transcript blocks active"]);
	});
	it("does not report settled resume backlog as active", () => {
		const transcript = new TranscriptContainer();
		transcript.addChild(new Block(["settled one"], true));
		transcript.addChild(new Block(["settled two"], true));
		transcript.addChild(new Block(["current tool"], false));

		// The welcome header can consume the first history offer, leaving the
		// settled transcript prefix live for one frame while it drains next.
		expect(transcript.renderViewport(80, 1, frame)).toEqual(["current tool"]);
	});
	it("retires a resumed ledger across frames instead of one blocking batch (#12933)", () => {
		const transcript = new TranscriptContainer();
		const blocks = Array.from({ length: 6 }, (_, index) => new SlowBlock([`block ${index}`], 4));
		for (const block of blocks) transcript.addChild(block);

		const drained: string[] = [];
		let batches = 0;
		for (let batch = transcript.peekFinalizedBatch(80, 0); batch !== undefined;) {
			drained.push(...batch.rows);
			transcript.acknowledgeFinalizedBatch(batch.id);
			if (++batches > blocks.length) throw new Error("retirement did not converge");
			batch = transcript.peekFinalizedBatch(80, 0);
		}

		// The whole backlog would block the frame that first paints it, so a
		// batch stops at the render budget and the rest follows on later frames.
		expect(batches).toBeGreaterThan(1);
		// Chunking must not reorder, drop, or duplicate a single scrollback row.
		expect(drained.filter(row => row !== "")).toEqual(blocks.map((_, index) => `block ${index}`));
		expect(transcript.blockStates()).toEqual(blocks.map(() => "committed"));
	});

	it("leaves the backlog behind the screen unrendered while painting (#12933)", () => {
		const transcript = new TranscriptContainer();
		const blocks = Array.from({ length: 40 }, (_, index) => new CountingBlock([`row ${index}`]));
		for (const block of blocks) transcript.addChild(block);

		expect(transcript.renderViewport(80, 4, frame)).toEqual(["row 36", "row 37", "row 38", "row 39"]);
		// Only the viewport tail, plus the one block that proves the overflow,
		// costs a render; a resumed session's backlog never does.
		expect(blocks.slice(0, 34).map(block => block.renders)).toEqual(blocks.slice(0, 34).map(() => 0));
		expect(blocks[39]!.renders).toBeGreaterThan(0);
	});

	it("keeps an emergency row from a block behind the bounded viewport walk", () => {
		class HintBlock extends Block {
			renderTranscriptBlockEmergencyRow(): string {
				return "hint";
			}
		}
		const transcript = new TranscriptContainer();
		transcript.addChild(new Block(["running"], false));
		transcript.addChild(new HintBlock(["hint body"], true));
		for (let index = 0; index < 5; index++) transcript.addChild(new Block([`settled ${index}`], true));

		expect(transcript.renderViewport(80, 2, frame)).toEqual(["hint", "settled 4"]);
	});

	it("does not count empty active blocks behind the viewport as hidden work", () => {
		const transcript = new TranscriptContainer();
		transcript.addChild(new Block(["running"], false));
		transcript.addChild(new Block([], false));
		for (let index = 0; index < 4; index++) transcript.addChild(new Block([`settled ${index}`], true));

		expect(transcript.renderViewport(80, 2, frame)).toEqual(["settled 2", "settled 3"]);
	});

	it("excludes empty blocks so pressure never emits blank rows (issue 9483)", () => {
		const transcript = new TranscriptContainer();
		// Text blocks interleaved with empty (hidden tool-activity) blocks that
		// render nothing but stay live until retired.
		for (let i = 0; i < 6; i++) {
			transcript.addChild(new Block([`t${i}a`, `t${i}b`, `t${i}c`], true));
			for (let j = 0; j < 8; j++) transcript.addChild(new Block([], true));
		}
		// Emergency path: more non-empty blocks than rows. Every row carries real
		// text — no block's tail is dropped as blank padding.
		const out = transcript.renderViewport(80, 12, frame);
		expect(out).toHaveLength(12);
		expect(out.every(row => /\S/.test(row))).toBe(true);
	});

	it("empty blocks do not reserve capacity from real text under pressure (issue 9483)", () => {
		const transcript = new TranscriptContainer();
		transcript.addChild(new Block(["A1", "A2", "A3", "A4"], true));
		transcript.addChild(new Block([], true));
		transcript.addChild(new Block(["B1", "B2", "B3", "B4"], true));
		transcript.addChild(new Block([], true));
		transcript.addChild(new Block(["C1", "C2", "C3", "C4"], true));
		// Capacity 10 fits all real content once the two empty blocks stop
		// stealing a base row each; the older block keeps its tail rows.
		const out = transcript.renderViewport(80, 10, frame);
		expect(out).toEqual(["A3", "A4", "B1", "B2", "B3", "B4", "C1", "C2", "C3", "C4"]);
	});

	it("keeps a completed assistant answer visible behind an active prefix", () => {
		const transcript = new TranscriptContainer();
		transcript.addChild(new Block(["stale active"], false));
		transcript.addChild(new AssistantMessageComponent(finalAnswer));
		transcript.addChild(new Block(["continued turn"], false));
		transcript.addChild(new Block(["task running"], false));

		expect(transcript.peekFinalizedBatch(80, 3)).toBeUndefined();
		const rows = transcript.renderViewport(80, 3, frame);
		expect(rows[0]).toBe("2 more transcript blocks active");
		expect(Bun.stripANSI(rows[1] ?? "").trim()).toBe("Implemented");
		expect(rows[2]).toBe("task running");
	});

	it("gives surplus rows to assistant text before a growing tool card (issue 9718)", () => {
		const transcript = new TranscriptContainer();
		const assistant = new Block(["A1", "A2", "A3", "A4"], false);
		const tool = new ToolBlock(["T1", "T2", "T3", "T4"], false);
		transcript.addChild(assistant);
		transcript.addChild(tool);
		// Capacity 5 cannot fit both blocks in full. Surplus (3 rows) goes to the
		// assistant block first; the tool card collapses to its one-row minimum
		// instead of clipping already-visible assistant text.
		const out = transcript.renderViewport(80, 5, frame);
		expect(out).toEqual(["A1", "A2", "A3", "A4", "T4"]);
		expect(assistant.allocations.at(-1)).toBe(4);
		expect(tool.allocations.at(-1)).toBe(1);
	});

	it("permits removing settled blocks until they are offered or committed", () => {
		const transcript = new TranscriptContainer();
		const settled = new Block(["settled snapshot"], true);
		const live = new Block(["live", "live", "live"], false);
		transcript.addChild(settled);
		transcript.addChild(live);

		// Settled but still in the mutable viewport: removable without a trace,
		// so a follow-up displaceable snapshot can retract it.
		expect(transcript.canRemoveBlock(settled)).toBe(true);

		// Offered to the terminal: mid-write, no longer removable.
		const batch = transcript.peekFinalizedBatch(80, 2);
		expect(batch?.rows).toEqual(["settled snapshot", ""]);
		expect(transcript.canRemoveBlock(settled)).toBe(false);

		// Committed: immutable history; removal must be refused outright.
		transcript.acknowledgeFinalizedBatch(batch!.id);
		expect(transcript.canRemoveBlock(settled)).toBe(false);
		transcript.removeChild(settled);
		expect(transcript.blockStates()).toEqual(["committed", "active"]);
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

describe("TranscriptContainer progressive assistant retirement", () => {
	const WIDTH = 60;
	const ROOM = 4;
	const paragraph = (label: string, index: number): string =>
		`${label} ${index} weighs **retirement** against native scrollback, with enough words to wrap.\n\n`;
	// Thinking streams first, then an answer after it: every update freezes one
	// more paragraph, and the answer turns the thinking into a closed part.
	const steps: AssistantMessage[] = [];
	let reasoning = "";
	for (let index = 0; index < 8; index++) {
		reasoning += paragraph("Thought", index);
		steps.push({ ...finalAnswer, content: [{ type: "thinking", thinking: `${reasoning}Pending` }] });
	}
	let answer = "";
	for (let index = 0; index < 8; index++) {
		answer += paragraph("Answer", index);
		steps.push({
			...finalAnswer,
			content: [
				{ type: "thinking", thinking: reasoning.trim() },
				{ type: "text", text: `${answer}Pending` },
			],
		});
	}

	beforeAll(async () => {
		await initTheme(false);
	});

	/** With `observe`, the transcript composes every update; otherwise only the block renders. */
	function apply(
		transcript: TranscriptContainer,
		component: AssistantMessageComponent,
		updates: readonly AssistantMessage[],
		observe: boolean,
	): void {
		for (const update of updates) {
			component.updateContent(update, { transient: true });
			if (observe) transcript.renderViewport(WIDTH, 1000, frame);
			else component.render(WIDTH);
		}
	}

	function retire(transcript: TranscriptContainer, width: number): readonly string[] {
		const batch = transcript.peekFinalizedBatch(width, ROOM);
		if (!batch) throw new Error("Expected a stable-row batch");
		transcript.acknowledgeFinalizedBatch(batch.id);
		return batch.rows;
	}

	it("retires several published prefixes per batch as exactly the block's leading rows", () => {
		const runs = [true, false].map(observe => {
			const transcript = new TranscriptContainer();
			const component = new AssistantMessageComponent();
			transcript.addChild(component);
			apply(transcript, component, steps.slice(0, 8), observe);
			const first = retire(transcript, WIDTH);
			const [firstCount = 0] = transcript.emittedStableRows();
			apply(transcript, component, steps.slice(8), observe);
			const second = retire(transcript, WIDTH);
			const [secondCount = 0] = transcript.emittedStableRows();

			expect(firstCount).toBeGreaterThan(1);
			expect(secondCount - firstCount).toBeGreaterThan(1);
			const live = transcript.renderViewport(WIDTH, 1000, frame);
			expect([...first, ...second, ...live]).toEqual([...trimBlankEdges(component.render(WIDTH))]);
			return { first, second, firstCount, secondCount };
		});
		// Whether or not the transcript saw each prefix as it published, the
		// batches are the same rows.
		expect(runs[1]).toEqual(runs[0]!);
	});

	it("retires further published prefixes after a resize as the new width's leading rows", () => {
		const transcript = new TranscriptContainer();
		const component = new AssistantMessageComponent();
		transcript.addChild(component);
		apply(transcript, component, steps.slice(0, 8), true);
		retire(transcript, WIDTH);
		apply(transcript, component, steps.slice(8), true);
		const [emitted = 0] = transcript.emittedStableRows();

		const narrow = 44;
		const emittedRows = component.renderTranscriptStableRows(emitted, narrow);
		const next = retire(transcript, narrow);
		expect(transcript.emittedStableRows()[0]! - emitted).toBeGreaterThan(1);
		const live = transcript.renderViewport(narrow, 1000, frame);
		expect([...emittedRows, ...next, ...live]).toEqual([...trimBlankEdges(component.render(narrow))]);
	});
});

describe("TranscriptContainer viewport click spans", () => {
	it("maps uncapped viewport rows to their blocks, skipping separators", () => {
		const transcript = new TranscriptContainer();
		const first = new Block(["a1", "a2"], false);
		const second = new Block(["b1"], false);
		transcript.addChild(first);
		transcript.addChild(second);

		expect(transcript.renderViewport(80, 10, frame)).toEqual(["a1", "a2", "", "b1"]);
		expect(transcript.getLastViewportSpans()).toEqual([
			{ component: first, start: 0, end: 2 },
			{ component: second, start: 3, end: 4 },
		]);
	});

	it("maps allocation-clipped rows to their surviving tails", () => {
		const transcript = new TranscriptContainer();
		const first = new Block(["a1", "a2", "a3", "a4"], false);
		const second = new Block(["b1", "b2", "b3", "b4"], false);
		transcript.addChild(first);
		transcript.addChild(second);

		expect(transcript.renderViewport(80, 5, frame)).toEqual(["a4", "b1", "b2", "b3", "b4"]);
		expect(transcript.getLastViewportSpans()).toEqual([
			{ component: first, start: 0, end: 1 },
			{ component: second, start: 1, end: 5 },
		]);
	});

	it("leaves the emergency summary row unmapped", () => {
		const transcript = new TranscriptContainer();
		transcript.addChild(new Block(["a1"], false));
		transcript.addChild(new Block(["b1"], false));
		transcript.addChild(new Block(["c1"], false));

		expect(transcript.renderViewport(80, 1, frame)).toEqual(["2 more transcript blocks active"]);
		expect(transcript.getLastViewportSpans()).toEqual([]);
	});

	it("clears spans when the tail is empty or cleared", () => {
		const transcript = new TranscriptContainer();
		const block = new Block(["a1"], false);
		transcript.addChild(block);
		transcript.renderViewport(80, 10, frame);
		expect(transcript.getLastViewportSpans()).toHaveLength(1);

		expect(transcript.renderViewport(80, 0, frame)).toEqual([]);
		expect(transcript.getLastViewportSpans()).toEqual([]);

		transcript.renderViewport(80, 10, frame);
		transcript.clear();
		expect(transcript.getLastViewportSpans()).toEqual([]);
	});
});

class ProjectionCountingBlock extends Block {
	renderCalls = 0;

	override render(width?: number): readonly string[] {
		this.renderCalls++;
		return super.render(width);
	}
}

class CountingUserMessageComponent extends UserMessageComponent {
	renderCalls = 0;

	override render(width: number): readonly string[] {
		this.renderCalls++;
		return super.render(width);
	}
}

function cursor(offsetFromTail: number, measuredRows: number, width: number): TranscriptViewportCursor {
	return { offsetFromTail, measuredRows, width };
}

function createTwoTurnTranscript() {
	const transcript = new TranscriptContainer();
	const firstPrompt = new UserMessageComponent("first prompt\nfirst prompt details");
	const firstResponse = new Block(["first response", "first response detail"], true);
	const secondPrompt = new UserMessageComponent("second prompt\nsecond prompt details");
	const secondResponse = new Block(["second response", "second response detail"], true);
	transcript.addChild(firstPrompt);
	transcript.addChild(firstResponse);
	transcript.addChild(secondPrompt);
	transcript.addChild(secondResponse);
	return { transcript, firstPrompt, firstResponse, secondPrompt, secondResponse };
}

function projectionAtRow(
	transcript: TranscriptContainer,
	width: number,
	measuredRows: number,
	rowIndex: number,
): ScrollableTranscriptProjection {
	return transcript.renderScrollableViewport(
		width,
		1,
		frame,
		cursor(measuredRows - rowIndex - 1, measuredRows, width),
	);
}

describe("TranscriptContainer scrollable viewport projection", () => {
	beforeAll(async () => {
		await initTheme(false);
	});

	it("projects a response-only window with its initiating prompt", () => {
		const { transcript, firstPrompt, firstResponse } = createTwoTurnTranscript();
		const full = transcript.renderScrollableViewport(80, 100, frame, cursor(0, 0, 80));
		const responseSpan = full.spans.find(span => span.component === firstResponse);
		if (!responseSpan) throw new Error("Expected the first response span");
		const promptSpan = full.spans.find(span => span.component === firstPrompt);
		if (!promptSpan) throw new Error("Expected the first prompt span");

		const response = projectionAtRow(transcript, 80, full.cursor.measuredRows, responseSpan.start);
		expect(response.rows).toEqual(["first response"]);
		expect(response.prompt).toBe(firstPrompt);
		expect(response.promptVisible).toBe(false);
		expect(response.spans).toEqual([{ component: firstResponse, start: 0, end: 1 }]);
		expect(responseSpan.start - promptSpan.end).toBe(1);
	});

	it("projects a response under a structurally declared prompt block", () => {
		const transcript = new TranscriptContainer();
		const prompt = Object.assign(new Block(["custom prompt"], true), {
			initiatesResponseTurn: true as const,
			renderStickyPrompt: (_width: number, _maxRows: number) => ["custom prompt"],
		});
		const response = new Block(["custom answer"], true);
		transcript.addChild(prompt);
		transcript.addChild(response);
		const full = transcript.renderScrollableViewport(80, 100, frame, cursor(0, 0, 80));
		const span = full.spans.find(item => item.component === response);
		if (!span) throw new Error("Expected the response span");
		const projected = projectionAtRow(transcript, 80, full.cursor.measuredRows, span.start);
		expect(projected.prompt).toBe(prompt);
		expect(projected.promptVisible).toBe(false);
	});

	it("changes prompt ownership when the projected window crosses a turn boundary", () => {
		const { transcript, firstPrompt, firstResponse, secondPrompt, secondResponse } = createTwoTurnTranscript();
		const full = transcript.renderScrollableViewport(80, 100, frame, cursor(0, 0, 80));
		const firstSpan = full.spans.find(span => span.component === firstResponse);
		const secondSpan = full.spans.find(span => span.component === secondResponse);
		if (!firstSpan || !secondSpan) throw new Error("Expected both response spans");

		expect(projectionAtRow(transcript, 80, full.cursor.measuredRows, firstSpan.start).prompt).toBe(firstPrompt);
		expect(projectionAtRow(transcript, 80, full.cursor.measuredRows, secondSpan.start).prompt).toBe(secondPrompt);
	});

	it("recomputes prompt ownership after transcript children are reordered and replaced", () => {
		const { transcript, firstPrompt, firstResponse, secondPrompt, secondResponse } = createTwoTurnTranscript();
		transcript.children = [secondPrompt, secondResponse, firstPrompt, firstResponse];
		const reordered = transcript.renderScrollableViewport(80, 100, frame, cursor(0, 0, 80));
		const reorderedSpan = reordered.spans.find(span => span.component === secondResponse);
		if (!reorderedSpan) throw new Error("Expected the reordered response span");
		expect(projectionAtRow(transcript, 80, reordered.cursor.measuredRows, reorderedSpan.start).prompt).toBe(
			secondPrompt,
		);

		const replacementPrompt = new UserMessageComponent("replacement prompt");
		transcript.children = [replacementPrompt, secondResponse, firstPrompt, firstResponse];
		const replaced = transcript.renderScrollableViewport(80, 100, frame, cursor(0, 0, 80));
		const replacedSpan = replaced.spans.find(span => span.component === secondResponse);
		if (!replacedSpan) throw new Error("Expected the replacement response span");
		expect(projectionAtRow(transcript, 80, replaced.cursor.measuredRows, replacedSpan.start).prompt).toBe(
			replacementPrompt,
		);
	});

	it("recomputes prompt ownership after an in-place child reorder", () => {
		const { transcript, firstResponse, secondPrompt } = createTwoTurnTranscript();
		transcript.children.splice(1, 2, secondPrompt, firstResponse);
		const reordered = transcript.renderScrollableViewport(80, 100, frame, cursor(0, 0, 80));
		const responseSpan = reordered.spans.find(span => span.component === firstResponse);
		if (!responseSpan) throw new Error("Expected the reordered response span");

		expect(projectionAtRow(transcript, 80, reordered.cursor.measuredRows, responseSpan.start).prompt).toBe(
			secondPrompt,
		);
	});

	it("reports a visible initiating prompt in its projected window", () => {
		const { transcript, secondPrompt } = createTwoTurnTranscript();
		const full = transcript.renderScrollableViewport(80, 100, frame, cursor(0, 0, 80));
		const promptSpan = full.spans.find(span => span.component === secondPrompt);
		if (!promptSpan) throw new Error("Expected the second prompt span");

		const promptTextRow = full.rows.findIndex(
			(row, rowIndex) =>
				rowIndex >= promptSpan.start && rowIndex < promptSpan.end && Bun.stripANSI(row).trim().length > 0,
		);
		if (promptTextRow < 0) throw new Error("Expected a visible prompt text row");
		const promptWindow = projectionAtRow(transcript, 80, full.cursor.measuredRows, promptTextRow);
		expect(promptWindow.prompt).toBe(secondPrompt);
		expect(promptWindow.promptVisible).toBe(true);
	});

	it("does not treat bubble padding alone as visible prompt text", () => {
		const transcript = new TranscriptContainer();
		const prompt = new UserMessageComponent("prompt text");
		transcript.addChild(prompt);
		transcript.addChild(new Block(["response row"], true));
		const full = transcript.renderScrollableViewport(80, 100, frame, cursor(0, 0, 80));
		const promptSpan = full.spans.find(span => span.component === prompt);
		if (!promptSpan) throw new Error("Expected the prompt span");
		const paddingRow = promptSpan.end - 1;
		expect(Bun.stripANSI(full.rows[paddingRow] ?? "").trim()).toBe("");
		const paddingWindow = transcript.renderScrollableViewport(
			80,
			1,
			frame,
			cursor(full.cursor.measuredRows - promptSpan.end, full.cursor.measuredRows, 80),
		);
		expect(paddingWindow.prompt).toBe(prompt);
		expect(paddingWindow.promptVisible).toBe(false);
	});

	it("refreshes a visible historical prompt row after its reaction changes", () => {
		const transcript = new TranscriptContainer();
		const prompt = new UserMessageComponent("reactive prompt");
		transcript.addChild(prompt);
		transcript.addChild(new Block(["response row"], true));
		const full = transcript.renderScrollableViewport(80, 100, frame, cursor(0, 0, 80));
		const promptSpan = full.spans.find(span => span.component === prompt);
		if (!promptSpan) throw new Error("Expected the prompt span");
		const before = projectionAtRow(transcript, 80, full.cursor.measuredRows, promptSpan.start);

		prompt.setReaction("👍");
		const after = projectionAtRow(transcript, 80, full.cursor.measuredRows, promptSpan.start);
		expect(after.rows[0]).not.toBe(before.rows[0]);
	});

	it("recomputes a projected range when a refreshed historical entry changes row count", () => {
		const transcript = new TranscriptContainer();
		const changing = new ProjectionCountingBlock(["row 1", "row 2", "row 3", "row 4"], true);
		transcript.addChild(changing);
		transcript.addChild(new Block(["tail"], true));
		const measured = transcript.renderScrollableViewport(80, 100, frame, cursor(0, 0, 80));
		const middle = transcript.renderScrollableViewport(80, 2, frame, cursor(2, measured.cursor.measuredRows, 80));
		expect(middle.rows).toEqual(["row 3", "row 4"]);

		changing.replace(["row 1", "row 2", "row 3", "row 4", "row 5"]);
		const reflowed = transcript.renderScrollableViewport(80, 2, frame, middle.cursor);
		expect(reflowed.cursor.measuredRows).toBe(measured.cursor.measuredRows + 1);
		expect(reflowed.cursor.offsetFromTail).toBe(middle.cursor.offsetFromTail + 1);
		expect(reflowed.rows).toEqual(middle.rows);
	});

	it("anchors a suspended cursor when an archived tail finalizes with different rows", () => {
		const transcript = new TranscriptContainer();
		transcript.addChild(new Block(["history row"], true));
		const tail = new Block(["partial tail"], false);
		transcript.addChild(tail);

		const full = transcript.renderScrollableViewport(80, 10, frame, cursor(0, 0, 80));
		const suspended = transcript.renderScrollableViewport(80, 1, frame, cursor(2, full.cursor.measuredRows, 80));
		expect(suspended.rows).toEqual(["history row"]);

		tail.finalize(["final row 1", "final row 2", "final row 3"]);
		transcript.archiveFinalizedForViewport();
		const finalized = transcript.renderScrollableViewport(80, 1, frame, suspended.cursor);

		expect(finalized.cursor.measuredRows).toBe(full.cursor.measuredRows + 2);
		expect(finalized.cursor.offsetFromTail).toBe(suspended.cursor.offsetFromTail + 2);
		expect(finalized.rows).toEqual(suspended.rows);
	});

	it("does not offset-anchor growth before a suspended separator", () => {
		const transcript = new TranscriptContainer();
		const active = new Block(["partial row"], false);
		transcript.addChild(active);
		transcript.addChild(new Block(["following row"], true));

		const full = transcript.renderScrollableViewport(80, 10, frame, cursor(0, 0, 80));
		const separator = transcript.renderScrollableViewport(80, 1, frame, cursor(1, full.cursor.measuredRows, 80));
		expect(separator.rows).toEqual([""]);

		active.finalize(["final row 1", "final row 2", "final row 3"]);
		transcript.archiveFinalizedForViewport();
		const after = transcript.renderScrollableViewport(80, 1, frame, separator.cursor);

		expect(after.rows).toEqual(separator.rows);
		expect(after.cursor.offsetFromTail).toBe(separator.cursor.offsetFromTail);
		expect(after.cursor.measuredRows).toBe(full.cursor.measuredRows + 2);
		const intoBlock = transcript.renderScrollableViewport(
			80,
			1,
			frame,
			cursor(after.cursor.offsetFromTail + 1, after.cursor.measuredRows, 80),
		);
		expect(intoBlock.rows).toEqual(["final row 3"]);
		expect(intoBlock.cursor.offsetFromTail).toBe(after.cursor.offsetFromTail + 1);
	});

	it("refreshes active growth before a suspended separator without shifting later seeks", () => {
		const transcript = new TranscriptContainer();
		const active = new Block(["partial row"], false);
		transcript.addChild(active);
		transcript.addChild(new Block(["following row"], true));

		const full = transcript.renderScrollableViewport(80, 10, frame, cursor(0, 0, 80));
		const separator = transcript.renderScrollableViewport(80, 1, frame, cursor(1, full.cursor.measuredRows, 80));
		expect(separator.rows).toEqual([""]);

		active.replace(["active row 1", "active row 2", "active row 3"]);
		const after = transcript.renderScrollableViewport(80, 1, frame, separator.cursor);
		expect(after.rows).toEqual(separator.rows);
		expect(after.cursor.offsetFromTail).toBe(separator.cursor.offsetFromTail);
		expect(after.cursor.measuredRows).toBe(full.cursor.measuredRows + 2);

		const intoBlock = transcript.renderScrollableViewport(
			80,
			1,
			frame,
			cursor(after.cursor.offsetFromTail + 1, after.cursor.measuredRows, 80),
		);
		expect(intoBlock.rows).toEqual(["active row 3"]);
		expect(intoBlock.cursor.offsetFromTail).toBe(after.cursor.offsetFromTail + 1);
	});

	it("anchors suspended cursors on append and keeps tail-following cursors at the tail", () => {
		const transcript = new TranscriptContainer();
		transcript.addChild(new UserMessageComponent("append anchor prompt"));
		const response = new Block(["r1", "r2", "r3", "r4", "r5"], false);
		transcript.addChild(response);
		const measured = transcript.renderScrollableViewport(80, 100, frame, cursor(0, 0, 80));
		const suspended = transcript.renderScrollableViewport(80, 3, frame, cursor(2, measured.cursor.measuredRows, 80));
		const following = transcript.renderScrollableViewport(80, 3, frame, cursor(0, measured.cursor.measuredRows, 80));

		response.replace(["r1", "r2", "r3", "r4", "r5", "r6"]);
		const anchored = transcript.renderScrollableViewport(80, 3, frame, suspended.cursor);
		const tail = transcript.renderScrollableViewport(80, 3, frame, following.cursor);
		expect(anchored.cursor.offsetFromTail).toBe(suspended.cursor.offsetFromTail + 1);
		expect(anchored.rows).toEqual(suspended.rows);
		expect(tail.cursor.offsetFromTail).toBe(0);
		expect(tail.rows.slice(-1)).toEqual(["r6"]);
		const reflowed = transcript.renderScrollableViewport(40, 3, frame, suspended.cursor);
		expect(reflowed.cursor.offsetFromTail).toBe(Math.min(suspended.cursor.offsetFromTail, reflowed.maxOffset));
	});

	it("clamps non-finite and negative dimensions and cursor measurements safely", () => {
		const { transcript } = createTwoTurnTranscript();
		const projection = transcript.renderScrollableViewport(
			Number.POSITIVE_INFINITY,
			Number.NaN,
			frame,
			cursor(Number.POSITIVE_INFINITY, Number.NaN, Number.NEGATIVE_INFINITY),
		);

		expect(projection.rows).toEqual([]);
		expect(projection.cursor.width).toBe(1);
		expect(projection.cursor.offsetFromTail).toBe(0);
		expect(Number.isFinite(projection.cursor.measuredRows)).toBe(true);
		expect(Number.isFinite(projection.maxOffset)).toBe(true);
		const negative = transcript.renderScrollableViewport(-10, -3, frame, cursor(1, 0, 80));
		expect(negative.rows).toEqual([]);
		expect(negative.cursor.width).toBe(1);
		expect(Number.isFinite(negative.maxOffset)).toBe(true);
	});

	it("leaves unrelated old entries unrendered until incremental scrolling reaches them", () => {
		const transcript = new TranscriptContainer();
		const entries: ProjectionCountingBlock[] = [];
		for (let index = 0; index < 20; index++) {
			const entry = new ProjectionCountingBlock([`historical row ${index}`], true);
			entries.push(entry);
			transcript.addChild(entry);
		}

		const tail = transcript.renderScrollableViewport(80, 1, frame, cursor(0, 0, 80));
		expect(tail.rows).toEqual(["historical row 19"]);
		expect(entries.at(-1)!.renderCalls).toBe(1);
		expect(entries.slice(0, -1).every(entry => entry.renderCalls === 0)).toBe(true);

		const boundary = transcript.renderScrollableViewport(80, 1, frame, cursor(1, tail.cursor.measuredRows, 80));
		expect(boundary.rows).toEqual([""]);
		expect(entries[18]!.renderCalls).toBe(1);
		expect(entries[17]!.renderCalls).toBe(0);
		const older = transcript.renderScrollableViewport(80, 1, frame, cursor(2, boundary.cursor.measuredRows, 80));
		expect(older.rows).toEqual(["historical row 18"]);
		expect(entries[17]!.renderCalls).toBe(0);
	});

	it("reuses cached historical rows outside nearby projected windows", () => {
		const transcript = new TranscriptContainer();
		const entries: ProjectionCountingBlock[] = [];
		const prompts: CountingUserMessageComponent[] = [];
		for (let index = 0; index < 12; index++) {
			const prompt = new CountingUserMessageComponent(`prompt ${index}`);
			const response = new ProjectionCountingBlock([`response ${index} row 1`, `response ${index} row 2`], true);
			prompts.push(prompt);
			entries.push(response);
			transcript.addChild(prompt);
			transcript.addChild(response);
		}
		const full = transcript.renderScrollableViewport(80, 1000, frame, cursor(0, 0, 80));
		const last = full.spans.find(span => span.component === entries.at(-1));
		if (!last) throw new Error("Expected the last response span");
		const farPromptRenders = prompts[0]!.renderCalls;
		const farResponseRenders = entries[0]!.renderCalls;
		const nearbyPromptRenders = prompts.at(-1)!.renderCalls;
		const lastResponseRenders = entries.at(-1)!.renderCalls;
		projectionAtRow(transcript, 80, full.cursor.measuredRows, last.start);
		expect(entries.at(-1)!.renderCalls).toBe(lastResponseRenders + 1);
		projectionAtRow(transcript, 80, full.cursor.measuredRows, last.start + 1);
		expect(entries.at(-1)!.renderCalls).toBe(lastResponseRenders + 2);
		expect(prompts[0]!.renderCalls).toBe(farPromptRenders);
		expect(entries[0]!.renderCalls).toBe(farResponseRenders);
		expect(prompts.at(-1)!.renderCalls).toBe(nearbyPromptRenders);
	});
	it("seeks warm deep windows without inspecting the history between the tail and selection", () => {
		const transcript = new TranscriptContainer();
		const entries: ProjectionCountingBlock[] = [];
		for (let index = 0; index < 128; index++) {
			const entry = new ProjectionCountingBlock([`history ${index}`], true);
			entries.push(entry);
			transcript.addChild(entry);
		}
		const full = transcript.renderScrollableViewport(80, 1000, frame, cursor(0, 0, 80));
		const target = entries[12]!;
		const targetSpan = full.spans.find(span => span.component === target);
		if (!targetSpan) throw new Error("Expected the selected historical block span");
		const selected = projectionAtRow(transcript, 80, full.cursor.measuredRows, targetSpan.start);
		expect(selected.spans).toEqual([{ component: target, start: 0, end: 1 }]);

		const appended = new ProjectionCountingBlock(["new tail"], true);
		transcript.addChild(appended);
		const tail = transcript.renderScrollableViewport(80, 1, frame, cursor(0, full.cursor.measuredRows, 80));
		const targetOffset = full.cursor.measuredRows + 2 - targetSpan.start - 1;
		const deepCursor = cursor(targetOffset, tail.cursor.measuredRows, 80);
		const deep = transcript.renderScrollableViewport(80, 1, frame, deepCursor);
		expect(deep.rows).toEqual(["history 12"]);
		expect(deep.spans).toEqual([{ component: target, start: 0, end: 1 }]);

		const historicalEntries = new Set<Component>(entries);
		const originalGet = Map.prototype.get;
		let inspectedHistoricalEntries = 0;
		Map.prototype.get = function <K, V>(this: Map<K, V>, key: K): V | undefined {
			if (historicalEntries.has(key as unknown as Component)) inspectedHistoricalEntries++;
			return originalGet.call(this, key);
		};
		try {
			const repeated = transcript.renderScrollableViewport(80, 1, frame, deep.cursor);
			expect(repeated.rows).toEqual(deep.rows);
		} finally {
			Map.prototype.get = originalGet;
		}
		expect(inspectedHistoricalEntries).toBeLessThan(8);
	});

	it("clears cached historical rows on a presentation reset", () => {
		const transcript = new TranscriptContainer();
		const block = new ProjectionCountingBlock(["before reset"], true);
		transcript.addChild(block);
		const first = transcript.renderScrollableViewport(80, 1, frame, cursor(0, 0, 80));
		expect(first.cursor.measuredRows).toBe(1);
		expect(block.renderCalls).toBe(1);

		block.replace(["after reset"]);
		transcript.resetStableEmission();
		transcript.renderScrollableViewport(80, 1, frame, first.cursor);
		expect(block.renderCalls).toBe(2);
	});

	it("bounds cached historical rows to recent width epochs", () => {
		const transcript = new TranscriptContainer();
		const block = new ProjectionCountingBlock(["stable row"], true);
		transcript.addChild(block);
		for (const width of [10, 20, 30]) {
			transcript.renderScrollableViewport(width, 1, frame, cursor(0, 0, width));
		}
		transcript.renderScrollableViewport(10, 1, frame, cursor(0, 0, 10));
		expect(block.renderCalls).toBe(4);
	});

	it("archives finalized rows without a history offer and flushes each exactly once after release", () => {
		const transcript = new TranscriptContainer();
		const expected: string[] = [];
		const entries: Block[] = [];
		for (let index = 0; index < 300; index++) {
			const row = `archived row ${index}`;
			expected.push(row);
			const entry = new Block([row], true);
			entries.push(entry);
			transcript.addChild(entry);
		}

		transcript.archiveFinalizedForViewport();
		expect(transcript.blockStates()).toEqual(Array.from({ length: 300 }, () => "archived"));
		expect(transcript.canAdmit(1)).toBe(true);
		expect(transcript.canRemoveBlock(entries[0]!)).toBe(false);
		expect(transcript.renderScrollableViewport(80, 1, frame, cursor(0, 0, 80)).rows).toEqual(["archived row 299"]);
		expect(transcript.peekFlushBatch(80)).toBeUndefined();

		transcript.releaseViewportArchiveForFlush();
		const flushed: string[] = [];
		let batch: HistoryBatch | undefined;
		while ((batch = transcript.peekFlushBatch(80)) !== undefined) {
			flushed.push(...batch.rows.filter(row => row.startsWith("archived row ")));
			transcript.acknowledgeFinalizedBatch(batch.id);
		}
		expect(flushed).toEqual(expected);
		expect(transcript.peekFlushBatch(80)).toBeUndefined();
	});

	it("does not revisit archived entries during repeated viewport archival", () => {
		const transcript = new TranscriptContainer();
		const entries: FinalizationCountingBlock[] = [];
		for (let index = 0; index < 300; index++) {
			const entry = new FinalizationCountingBlock([`history ${index}`], true);
			entries.push(entry);
			transcript.addChild(entry);
		}

		let childIndexReads = 0;
		transcript.children = new Proxy(transcript.children, {
			get(target, property, receiver) {
				if (typeof property === "string" && /^(0|[1-9]\d*)$/.test(property) && Number(property) < 300)
					childIndexReads++;
				return Reflect.get(target, property, receiver);
			},
		});
		transcript.archiveFinalizedForViewport();
		const checksAfterArchive = entries.map(entry => entry.finalizationChecks);
		childIndexReads = 0;
		for (let iteration = 0; iteration < 5; iteration++) transcript.archiveFinalizedForViewport();

		expect(entries.map(entry => entry.finalizationChecks)).toEqual(checksAfterArchive);
		expect(childIndexReads).toBe(0);
	});

	it("keeps viewport and pressure polling on the active tail after archival", () => {
		const transcript = new TranscriptContainer();
		const historical: FinalizationCountingBlock[] = [];
		for (let index = 0; index < 300; index++) {
			const entry = new FinalizationCountingBlock([`history ${index}`], true);
			historical.push(entry);
			transcript.addChild(entry);
		}

		let childIndexReads = 0;
		transcript.children = new Proxy(transcript.children, {
			get(target, property, receiver) {
				if (typeof property === "string" && /^(0|[1-9]\d*)$/.test(property) && Number(property) < 300)
					childIndexReads++;
				return Reflect.get(target, property, receiver);
			},
		});
		transcript.archiveFinalizedForViewport();
		for (const entry of historical) {
			entry.finalizationChecks = 0;
			entry.renderCalls = 0;
		}

		const tail = new ProjectionCountingBlock(["active tail"], false);
		transcript.addChild(tail);
		childIndexReads = 0;
		for (let frameIndex = 0; frameIndex < 5; frameIndex++) {
			expect(transcript.liveRowCount(80)).toBe(1);
			expect(transcript.peekFinalizedBatch(80, 10)).toBeUndefined();
			expect(transcript.renderViewport(80, 10, frame)).toEqual(["active tail"]);
		}

		expect(historical.map(entry => entry.finalizationChecks)).toEqual(Array.from({ length: 300 }, () => 0));
		expect(historical.map(entry => entry.renderCalls)).toEqual(Array.from({ length: 300 }, () => 0));
		expect(childIndexReads).toBe(0);
		expect(tail.renderCalls).toBeGreaterThan(0);
	});
});
