/**
 * Benchmark: TranscriptContainer per-frame live-entry wrapper cost.
 *
 * `#liveEntries()` builds one `{ entry, index }` wrapper per live block,
 * and three per-frame readers (`liveRowCount`, `#composeViewport`,
 * `#peekBatch`) each call it — up to 3 x 256 short-lived objects plus
 * arrays per frame at 30 fps. The container caches the wrapper list and
 * rebuilds it only when the live tail's identity changes, so a settled
 * transcript's repeated frames reuse it.
 *
 * A narrow viewport bounds the render work (the walk stops one block past
 * what the viewport holds), leaving the wrapper allocation as the term
 * this measures.
 *
 * Run: bun packages/tui/bench/transcript-live-entries.bench.ts
 */
import { TranscriptContainer } from "../src/chrome/transcript-container";
import type { Component } from "../src/tui";
import { makeBench } from "./_harness";

class Block implements Component {
	#rows: string[];

	constructor(rows: string[]) {
		this.#rows = rows;
	}

	isTranscriptBlockFinalized(): boolean {
		return true;
	}

	render(): readonly string[] {
		return this.#rows;
	}
}

const BLOCKS = 256;
const FRAMES = 3000;

function build(): TranscriptContainer {
	const transcript = new TranscriptContainer();
	for (let index = 0; index < BLOCKS; index++) transcript.addChild(new Block([`row ${index}`]));
	return transcript;
}

/** One frame's composition: the three per-frame live-tail readers. */
function frame(transcript: TranscriptContainer, tick: number): void {
	transcript.liveRowCount(80);
	transcript.renderViewport(80, 4, { tick, now: tick * 16 });
	transcript.peekFinalizedBatch(80, 4);
}

const transcript = build();
for (let tick = 0; tick < 300; tick++) frame(transcript, tick); // warm up

const bench = makeBench(1);
console.log(`TranscriptContainer live-entry wrappers (${BLOCKS} blocks x ${FRAMES} frames, capacity 4)\n`);

bench("frame-composition", () => {
	for (let tick = 0; tick < FRAMES; tick++) frame(transcript, 1_000_000 + tick);
});
