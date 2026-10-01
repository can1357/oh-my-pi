import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, readdirSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ConflictLedger } from "@oh-my-pi/pi-coding-agent/dakera/conflicts";

describe("ConflictLedger", () => {
	let dir: string;

	afterEach(() => {
		if (dir) rmSync(dir, { recursive: true, force: true });
	});

	const scratchFile = (): string => {
		dir = mkdtempSync(path.join(os.tmpdir(), "dakera-conflicts-"));
		return path.join(dir, "omp.conflicts.json");
	};

	it("round-trips records through flush and load", async () => {
		const file = scratchFile();
		const at = new Date().toISOString();
		const ledger = await ConflictLedger.load(file);
		ledger.record("old-1", { supersededBy: "new-1", at, near: 0.6 });
		await ledger.flush();

		const reloaded = await ConflictLedger.load(file);
		expect(reloaded.get("old-1")).toEqual({ supersededBy: "new-1", at, near: 0.6 });
		expect(reloaded.get("missing")).toBeUndefined();
	});

	it("starts empty when the file does not exist", async () => {
		const file = scratchFile();
		const ledger = await ConflictLedger.load(file);
		expect(readdirSync(dir)).toHaveLength(0);
		expect(ledger.get("anything")).toBeUndefined();
	});

	// An id marked outdated more than 90 days ago is noise: the near-duplicate
	// row it pointed at has long been restated or compacted by then. Overflow
	// drops the oldest-marked ids first.
	it("drops entries idle longer than 90 days and caps the ledger at 10k ids", async () => {
		const file = scratchFile();
		const staleAt = new Date(Date.now() - 91 * 86_400_000).toISOString();
		const freshAt = new Date(Date.now() - 10 * 86_400_000).toISOString();
		const bulkAt = new Date(Date.now() - 20 * 86_400_000).toISOString();
		const seed = await ConflictLedger.load(file);
		seed.record("stale", { supersededBy: "x", at: staleAt, near: 0.6 });
		seed.record("fresh", { supersededBy: "y", at: freshAt, near: 0.5 });
		for (let i = 0; i < 10_005; i++) {
			seed.record(`cap-${i}`, { supersededBy: "z", at: bulkAt, near: 0.4 });
		}
		await seed.flush();

		const reloaded = await ConflictLedger.load(file);
		expect(reloaded.get("stale")).toBeUndefined();
		expect(reloaded.get("fresh")).toBeDefined();
		// The cap evicts the OLDEST-marked ids: among the equal-timestamp bulk
		// rows that is insertion order, so cap-0.. must go and the tail stays.
		expect(reloaded.get("cap-0")).toBeUndefined();
		expect(reloaded.get("cap-5")).toBeUndefined();
		expect(reloaded.get("cap-6")).toBeDefined();
		expect(reloaded.get("cap-10004")).toBeDefined();
	});

	it("upserts by old id, keeping the newest record", async () => {
		const file = scratchFile();
		const ledger = await ConflictLedger.load(file);
		ledger.record("old-1", { supersededBy: "new-1", at: new Date(Date.now() - 3_600_000).toISOString(), near: 0.6 });
		ledger.record("old-1", { supersededBy: "new-2", at: new Date().toISOString(), near: 0.7 });
		expect(ledger.get("old-1")?.supersededBy).toBe("new-2");
		expect(ledger.get("old-1")?.near).toBe(0.7);
	});
});
