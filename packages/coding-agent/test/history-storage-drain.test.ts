import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { HistoryStorage } from "@pk-nerdsaver-ai/pi-coding-agent/session/history-storage";
import { removeWithRetries } from "@pk-nerdsaver-ai/pi-utils";

let tempDir = "";

async function freshStorage(prefix = "omp-history-drain-"): Promise<HistoryStorage> {
	tempDir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	const dbPath = path.join(tempDir, "history.db");
	HistoryStorage.resetInstance();
	return HistoryStorage.open(dbPath);
}

/** Drain the 100ms insert batch window, then await the pending writes. */
async function flush(...writes: Promise<void>[]): Promise<void> {
	vi.advanceTimersByTime(100);
	await Promise.all(writes);
}

beforeEach(() => {
	HistoryStorage.resetInstance();
	vi.useFakeTimers();
});

afterEach(async () => {
	HistoryStorage.resetInstance();
	vi.useRealTimers();
	if (tempDir) {
		await removeWithRetries(tempDir).catch(() => {});
		tempDir = "";
	}
});

/**
 * Contract for the history-storage async drain: multiple rapid `add()` calls
 * within the drain window are batched into a single flushed write, and the
 * returned promise resolves once the batch is persisted. This guards the
 * `Promise.withResolvers()` refactor of `AsyncDrain` — the drain must still
 * coalesce pushes and resolve its per-batch promise.
 */
describe("HistoryStorage AsyncDrain batching", () => {
	it("coalesces pushes within the drain window into one flushed write", async () => {
		const storage = await freshStorage();
		// Three rapid adds before the 100ms drain window fires.
		const p1 = storage.add("first prompt");
		const p2 = storage.add("second prompt");
		const p3 = storage.add("third prompt");
		await flush(p1, p2, p3);

		expect(storage.getRecent(10).map(r => r.prompt)).toEqual(["third prompt", "second prompt", "first prompt"]);
	});

	it("resolves the returned promise for each coalesced push", async () => {
		const storage = await freshStorage();
		const p1 = storage.add("a");
		const p2 = storage.add("b");
		await flush(p1, p2);
		// Both promises must have resolved (not hang) — flush awaited them.
		expect(storage.getRecent(10)).toHaveLength(2);
	});

	it("starts a fresh batch after the prior one flushes", async () => {
		const storage = await freshStorage();
		await flush(storage.add("batch-one"));
		// After the first batch flushes, a new add starts a new batch.
		await flush(storage.add("batch-two"));
		expect(storage.getRecent(10).map(r => r.prompt)).toEqual(["batch-two", "batch-one"]);
	});
});
