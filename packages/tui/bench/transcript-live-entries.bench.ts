/**
 * Benchmark: TranscriptContainer per-frame live-entry wrapper cost.
 *
 * `#liveEntries()` builds one `{ entry, index }` wrapper per live block, and
 * the container caches the list so a frame's history reader and its viewport
 * share one walk instead of each allocating the tail.
 *
 * Both cases copy a reachable `PromptComposer.renderFrame` shape
 * (`packages/tui/src/prompt/composer.ts`): it opens the frame with
 * `transcript.beginFrame(frame)` before its history reader, runs exactly one
 * history reader per frame (`liveRowCount` while the header is live,
 * `peekFinalizedBatch` once it has retired), and passes the same frame object
 * to `renderViewport`. No production frame runs all three readers.
 *
 * A narrow viewport bounds the render work, leaving the wrapper allocation and
 * the walk it replaces as the term this measures.
 *
 * Run: bun packages/tui/bench/transcript-live-entries.bench.ts
 */
import { TranscriptContainer } from "../src/chrome/transcript-container";
import type { Component } from "../src/tui";
import { makeBench } from "./_harness";

class Block implements Component {
	#rows: string[];
	#finalized: boolean;

	constructor(rows: string[], finalized: boolean) {
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

const BLOCKS = 256;
const FRAMES = 3000;
const WIDTH = 80;
const VIEWPORT_ROWS = 4;
/** Frames one settled tail feeds before the retirement case rebuilds it (it drains ~1.3 blocks a frame). */
const RETIREMENT_CYCLE = 64;

let seeded = 0;

function transcriptOf(finalized: boolean): TranscriptContainer {
	const transcript = new TranscriptContainer();
	for (let index = 0; index < BLOCKS; index++) transcript.addChild(new Block([`row ${seeded++}`], finalized));
	return transcript;
}

/** Header live: `#offerHistory` measures the tail, then the viewport lays it out. */
function streamingFrame(transcript: TranscriptContainer, tick: number): void {
	const frame = { tick, now: tick * 16 };
	transcript.beginFrame(frame);
	transcript.liveRowCount(WIDTH, VIEWPORT_ROWS);
	transcript.renderViewport(WIDTH, VIEWPORT_ROWS, frame);
}

/**
 * Header retired: `#offerHistory` offers what retirement can take and the
 * viewport lays out what is left. The terminal acknowledges the offer before
 * the next frame, which is also what keeps an offer from freezing every later
 * peek on the same batch.
 */
function retirementFrame(transcript: TranscriptContainer, tick: number): void {
	const frame = { tick, now: tick * 16 };
	transcript.beginFrame(frame);
	const batch = transcript.peekFinalizedBatch(WIDTH, VIEWPORT_ROWS);
	if (batch !== undefined) transcript.acknowledgeFinalizedBatch(batch.id);
	transcript.renderViewport(WIDTH, VIEWPORT_ROWS, frame);
}

const bench = makeBench(1);
console.log(`TranscriptContainer live-entry wrappers (${BLOCKS} blocks x ${FRAMES} frames)\n`);

bench("retirement-frame", () => {
	// Only a settled-block tail can retire, and retirement drains it a viewport
	// at a time; refilling on a cycle keeps every measured frame retiring from a
	// full BLOCKS-block tail instead of measuring an empty one.
	let transcript = transcriptOf(true);
	let framesLeft = RETIREMENT_CYCLE;
	for (let tick = 0; tick < FRAMES; tick++) {
		if (framesLeft-- === 0) {
			transcript = transcriptOf(true);
			framesLeft = RETIREMENT_CYCLE - 1;
		}
		retirementFrame(transcript, tick);
	}
});

bench("active-tail-frame", () => {
	// Nothing settles, so the tail never drains and one transcript serves every
	// frame: the peek finds no finalized prefix and the viewport owns the walk.
	const transcript = transcriptOf(false);
	for (let tick = 0; tick < FRAMES; tick++) retirementFrame(transcript, tick);
});

bench("header-live-frame", () => {
	// The header stays live only while the tail fits the screen, so this case is
	// a short tail by construction.
	const transcript = new TranscriptContainer();
	for (let index = 0; index < VIEWPORT_ROWS - 1; index++) transcript.addChild(new Block([`row ${seeded++}`], true));
	transcript.addChild(new Block([`row ${seeded++}`], false));
	for (let tick = 0; tick < FRAMES; tick++) streamingFrame(transcript, tick);
});
