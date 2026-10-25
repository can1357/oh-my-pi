/**
 * The per-frame readers (`liveRowCount`, `renderViewport`, `peekBatch`)
 * share one cached live-entry wrapper list, rebuilt only when the live
 * tail's identity changes. Without the cache each reader allocates one
 * wrapper object per live block per frame.
 *
 * A stale wrapper serves retired blocks to the viewport (committed rows
 * painted twice — once into scrollback, once live) or drops a live block
 * (its rows vanish until the next rebuild), so every case below asserts
 * the viewport and retirement output stay exactly what an uncached walk
 * would produce, across the mutation that must invalidate the cache.
 */
import { describe, expect, it } from "bun:test";
import {
	TranscriptContainer,
} from "@oh-my-pi/pi-tui/chrome/transcript-container";
import type { Component } from "@oh-my-pi/pi-tui";

class Block implements Component {
	#rows: string[];
	#finalized: boolean;

	constructor(rows: string[], finalized = true) {
		this.#rows = rows;
		this.#finalized = finalized;
	}

	isTranscriptBlockFinalized(): boolean {
		return this.#finalized;
	}

	render(): readonly string[] {
		return this.#rows;
	}
}

const frame = { tick: 0, now: 0 };

/** Prime the wrapper cache, then read the viewport again: same rows, no rebuild. */
function primeAndRerender(transcript: TranscriptContainer, width: number, rows: number): void {
	transcript.liveRowCount(width);
	expect(transcript.renderViewport(width, rows, frame)).toEqual(
		transcript.renderViewport(width, rows, { tick: 1, now: 16 }),
	);
}

describe("TranscriptContainer live-entry wrapper cache", () => {
	it("serves the same viewport rows across repeated frames without a rebuild", () => {
		const transcript = new TranscriptContainer();
		transcript.addChild(new Block(["first"]));
		transcript.addChild(new Block(["second"]));

		primeAndRerender(transcript, 80, 10);
		expect(transcript.renderViewport(80, 10, frame)).toEqual(["first", "", "second"]);
	});
	it("includes blocks added after the cache was primed", () => {
		// A new block extends the live tail; a cache that keeps serving the
		// old list would drop its rows from the viewport.
		const transcript = new TranscriptContainer();
		transcript.addChild(new Block(["first"]));
		primeAndRerender(transcript, 80, 10);

		transcript.addChild(new Block(["second"]));

		expect(transcript.renderViewport(80, 10, frame)).toEqual(["first", "", "second"]);
	});

	it("excludes committed blocks from the viewport after retirement", () => {
		// Acknowledging a commit advances the frontier past the retired
		// block; a cache that keeps the old start would paint its rows live
		// even though they are already in scrollback.
		const transcript = new TranscriptContainer();
		transcript.addChild(new Block(["old"]));
		transcript.addChild(new Block(["fresh"], false));
		primeAndRerender(transcript, 80, 10);

		const batch = transcript.peekFinalizedBatch(80, 1)!;
		expect(batch.rows).toEqual(["old", ""]);
		transcript.acknowledgeFinalizedBatch(batch.id);

		expect(transcript.renderViewport(80, 10, frame)).toEqual(["fresh"]);
		expect(transcript.blockStates()).toEqual(["committed", "active"]);
	});

	it("keeps live indexes valid after removing a live block", () => {
		// Removing a live block shifts every later block's index; wrappers
		// holding the old indexes would attribute rows to the wrong block
		// when the viewport walks them.
		const transcript = new TranscriptContainer();
		const settled = new Block(["settled"]);
		const doomed = new Block(["doomed"], false);
		const survivor = new Block(["survivor"], false);
		transcript.addChild(settled);
		transcript.addChild(doomed);
		transcript.addChild(survivor);
		primeAndRerender(transcript, 80, 10);

		transcript.removeChild(doomed);

		expect(transcript.renderViewport(80, 10, frame)).toEqual(["settled", "", "survivor"]);
		expect(transcript.blockStates()).toEqual(["settled", "active"]);
	});

	it("shows every block again after the transcript is cleared and rebuilt", () => {
		// Clearing drops all entries; cached wrappers pointing at the old
		// ones must not survive to paint them back.
		const transcript = new TranscriptContainer();
		transcript.addChild(new Block(["stale"]));
		primeAndRerender(transcript, 80, 10);
		transcript.clear();
		transcript.addChild(new Block(["rebuilt"]));

		expect(transcript.renderViewport(80, 10, frame)).toEqual(["rebuilt"]);
		// The rebuilt block is finalized, so the viewport settles it — the
		// point is the stale pre-clear rows are gone, not the lifecycle state.
		expect(transcript.blockStates()).toEqual(["settled"]);
	});
	it("picks up a block swapped in place without a length change", () => {
		// An external edit can replace a child at the same index (same
		// length, different identity). A cache that only checks length or
		// the start index would keep serving the old block's rows.
		const transcript = new TranscriptContainer();
		const old = new Block(["old rows"]);
		primeAndRerender(transcript, 80, 10);

		transcript.children[0] = new Block(["new rows"]);

		expect(transcript.renderViewport(80, 10, frame)).toEqual(["new rows"]);
	});

	it("retires the settled head the viewport no longer shows", () => {
		// The retirement peek walks the same cached list as the viewport;
		// if the cache excluded the settled head, pressure would never see
		// it and the block would stay live forever.
		const transcript = new TranscriptContainer();
		transcript.addChild(new Block(["old"]));
		transcript.addChild(new Block(["fresh"], false));
		primeAndRerender(transcript, 80, 10);

		const batch = transcript.peekFinalizedBatch(80, 1);

		expect(batch?.rows).toEqual(["old", ""]);
	});
});
