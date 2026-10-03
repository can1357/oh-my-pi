/**
 * Benchmark: truncateForPersistence two-phase scan (coding-agent finding F5).
 *
 * The common persisted entry is already clean; the old code allocated
 * Object.entries + per-key tuples for every object node before discovering
 * nothing changed. The predicate pass returns clean nodes with zero
 * allocation; only dirty nodes pay for the rebuild.
 *
 * Run: bun packages/coding-agent/bench/persist-truncate.bench.ts
 */
import { BlobStore } from "../src/session/blob-store";
import { prepareEntryForPersistence } from "../src/session/session-persistence";
import { TempDir } from "@oh-my-pi/pi-utils/temp";

using tempDir = TempDir.createSync("@persist-truncate-bench-");
const blobStore = new BlobStore(tempDir.path());

function cleanEntry(i: number): never {
	return {
		type: "message",
		id: `m${i}`,
		parentId: i === 0 ? null : `m${i - 1}`,
		timestamp: new Date(0).toISOString(),
		message: {
			role: "assistant",
			content: [
				{ type: "text", text: `response body ${i} `.repeat(50) },
				{ type: "toolCall", id: `c${i}`, name: "read", arguments: { path: `/x/${i}` } },
			],
			usage: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 30 },
			timestamp: Date.now(),
		},
	} as never;
}

const N = 200;
const entries = Array.from({ length: N }, (_, i) => cleanEntry(i));
// Warm blob store / caches.
for (const e of entries) prepareEntryForPersistence(e, blobStore);

const start = Bun.nanoseconds();
for (let r = 0; r < 5; r++) {
	for (const e of entries) prepareEntryForPersistence(e, blobStore);
}
const ms = (Bun.nanoseconds() - start) / 1e6;
console.log(
	`prepareEntryForPersistence x${N * 5} clean entries: ${ms.toFixed(1)}ms total (${((ms / (N * 5)) * 1000).toFixed(1)}us/op)`,
);
