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
import { TranscriptContainer } from "@oh-my-pi/pi-tui/chrome/transcript-container";
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

/** Prime the wrapper cache, then read the viewport again: same rows, one walk for all three readers. */
function primeAndRerender(transcript: TranscriptContainer, width: number, rows: number): void {
	const builds = transcript.liveEntryWalkBuilds;
	transcript.liveRowCount(width);
	expect(transcript.renderViewport(width, rows, frame)).toEqual(
		transcript.renderViewport(width, rows, { tick: 1, now: 16 }),
	);
	// liveRowCount plus both renders walked the same tail: a rebuild per reader
	// would count three.
	expect(transcript.liveEntryWalkBuilds).toBe(builds + 1);
}

describe("TranscriptContainer live-entry wrapper cache", () => {
	it("shares one live-entry walk across a frame's three readers", () => {
		// `liveRowCount`, `renderViewport`, and `peekFinalizedBatch` walk the same
		// live tail. Rebuilding the wrapper list per reader leaves the rows
		// identical, so only the walk count exposes it: this is the allocation
		// the cache exists to remove.
		const transcript = new TranscriptContainer();
		for (let index = 0; index < 32; index++) transcript.addChild(new Block([`row ${index}`]));
		transcript.renderViewport(80, 10, frame);
		const builds = transcript.liveEntryWalkBuilds;

		transcript.liveRowCount(80);
		transcript.renderViewport(80, 10, { tick: 1, now: 16 });
		transcript.peekFinalizedBatch(80, 10);

		expect(transcript.liveEntryWalkBuilds - builds).toBe(0);
		// A block the cache never saw must still rebuild it exactly once.
		transcript.addChild(new Block(["tail"]));
		transcript.liveRowCount(80);
		transcript.renderViewport(80, 10, frame);
		expect(transcript.liveEntryWalkBuilds - builds).toBe(1);
	});

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
		// An external edit can replace a child at the same index (same length,
		// different identity). A cache that only checks the start index and the
		// length would keep serving the old block's rows.
		const transcript = new TranscriptContainer();
		const old = new Block(["old rows"]);
		transcript.addChild(old);
		primeAndRerender(transcript, 80, 10);

		transcript.children[0] = new Block(["new rows"]);

		expect(transcript.renderViewport(80, 10, frame)).toEqual(["new rows"]);
	});

	it("keeps wrapper indexes in step with a block inserted before the tail", () => {
		// insertChildAt places a new block earlier in the list, so every live
		// index after it shifts. Cached positional wrappers would attribute rows
		// to the wrong block.
		const transcript = new TranscriptContainer();
		transcript.addChild(new Block(["first"]));
		transcript.addChild(new Block(["second"]));
		primeAndRerender(transcript, 80, 10);

		transcript.insertChildAt(new Block(["inserted"]), 1);

		expect(transcript.renderViewport(80, 10, frame)).toEqual(["first", "", "inserted", "", "second"]);
	});

	it("keeps the tail cached across the commit acknowledgement", () => {
		// The pre-ack viewport caches the tail from the offered end, and the
		// acknowledgement moves #frontier to exactly that index. Dropping the
		// cache there makes the frame after every acknowledgement re-walk and
		// re-allocate the whole tail for nothing.
		const transcript = new TranscriptContainer();
		transcript.addChild(new Block(["old"]));
		transcript.addChild(new Block(["fresh"], false));
		const offered = transcript.peekFinalizedBatch(80, 1)!;
		transcript.renderViewport(80, 10, frame);
		transcript.acknowledgeFinalizedBatch(offered.id);

		const builds = transcript.liveEntryWalkBuilds;

		expect(transcript.renderViewport(80, 10, frame)).toEqual(["fresh"]);
		expect(transcript.liveEntryWalkBuilds).toBe(builds);
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
