import type { Component } from "../src/tui";
import { TranscriptContainer, type TranscriptStableRow } from "../src/chrome/transcript-container";

const BLOCKS = 20_000;
const ROWS = 8;

class StableBlock implements Component {
	readonly transcriptBlockMode = "appendOnly" as const;
	readonly #rows: string[];
	readonly #stable: TranscriptStableRow[];

	constructor(index: number) {
		this.#rows = Array.from({ length: ROWS }, (_, row) => `${index}:${row} ${"transcript text ".repeat(6)}`);
		this.#stable = this.#rows.map((_, row) => ({ key: `${index}:${row}` }));
	}

	isTranscriptBlockFinalized(): boolean {
		return true;
	}

	getTranscriptStableRows(): readonly TranscriptStableRow[] {
		return this.#stable;
	}

	renderTranscriptStableRows(count: number): readonly string[] {
		return this.#rows.slice(0, count);
	}

	render(): readonly string[] {
		return this.#rows;
	}
}

function buildCommittedTranscript(): TranscriptContainer {
	const container = new TranscriptContainer();
	for (let index = 0; index < BLOCKS; index++) container.addChild(new StableBlock(index));
	container.liveRowCount(100);
	const batch = container.peekFlushBatch(80);
	if (!batch) throw new Error("Expected committed transcript batch");
	container.acknowledgeFinalizedBatch(batch.id);
	return container;
}

async function pssBytes(): Promise<number | undefined> {
	try {
		const rollup = await Bun.file("/proc/self/smaps_rollup").text();
		const kib = Number(rollup.match(/^Pss:\s+(\d+) kB$/m)?.[1]);
		return Number.isFinite(kib) ? kib * 1024 : undefined;
	} catch {
		return undefined;
	}
}

Bun.gc(true);
const before = process.memoryUsage();
const beforePss = await pssBytes();
const transcript = buildCommittedTranscript();
Bun.gc(true);
Bun.gc(true);
const after = process.memoryUsage();
const afterPss = await pssBytes();
console.log(
	JSON.stringify({
		blocks: transcript.children.length,
		heapMiB: Number(((after.heapUsed - before.heapUsed) / 1024 / 1024).toFixed(2)),
		rssMiB: Number(((after.rss - before.rss) / 1024 / 1024).toFixed(2)),
		pssMiB:
			beforePss !== undefined && afterPss !== undefined
				? Number(((afterPss - beforePss) / 1024 / 1024).toFixed(2))
				: undefined,
	}),
);
