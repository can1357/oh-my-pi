import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Mnemopi } from "@oh-my-pi/pi-mnemopi/core/memory";
import { ALLOWED_DELTA_TABLES, DeltaSync, SyncCheckpoint } from "@oh-my-pi/pi-mnemopi/core/streaming";

const roots: string[] = [];

function tempRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "mnemopi-c25-delta-"));
	roots.push(root);
	return root;
}

function seededMemory(): { memory: Mnemopi; root: string } {
	const root = tempRoot();
	const memory = new Mnemopi({ sessionId: "s1", dbPath: join(root, "mnemopi.db") });
	memory.remember("Alice prefers Vim", { source: "pref", importance: 0.7 });
	memory.remember("Bob owns the auth module", { source: "fact", importance: 0.8 });
	return { memory, root };
}

afterEach(() => {
	for (;;) {
		const root = roots.pop();
		if (root === undefined) break;
		rmSync(root, { recursive: true, force: true });
	}
});

describe("C25 DeltaSync table allowlist", () => {
	it("keeps the public table allowlist explicit", () => {
		expect(ALLOWED_DELTA_TABLES).toBeInstanceOf(Set);
		expect([...ALLOWED_DELTA_TABLES].sort()).toEqual(["episodic_memory", "working_memory"]);
	});

	it("accepts allowed tables and rejects unknown, injected, and non-string table values", () => {
		const { memory, root } = seededMemory();
		try {
			const sync = new DeltaSync(memory, join(root, "sync"));
			expect(sync.computeDelta("peer-a", "working_memory").length).toBeGreaterThanOrEqual(2);
			expect(sync.computeDelta("peer-a", "episodic_memory")).toEqual([]);

			for (const table of [
				"some_other_table",
				"working_memory; DROP TABLE episodic_memory; --",
				null,
				42,
				["working_memory"],
			]) {
				expect(() => sync.computeDelta("peer-a", table as never)).toThrow(/allowlist/);
				expect(() => sync.applyDelta("peer-a", [], table as never)).toThrow(/allowlist/);
			}

			const row = memory.conn
				.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'episodic_memory'")
				.get();
			expect(() => sync.syncTo("peer-a", "bogus" as never)).toThrow(/allowlist/);
			expect(() => sync.syncFrom("peer-a", [{ id: "x" }], "bogus" as never)).toThrow(/allowlist/);

			expect(row).not.toBeNull();
		} finally {
			memory.close();
		}
	});

	it("rejects string-object allowlist bypasses", () => {
		const { memory, root } = seededMemory();
		try {
			const sync = new DeltaSync(memory, join(root, "sync"));
			const disguised = new String("working_memory") as unknown;
			expect(() => sync.computeDelta("peer-a", disguised as never)).toThrow(/allowlist/);
			expect(() => sync.applyDelta("peer-a", [], disguised as never)).toThrow(/allowlist/);
		} finally {
			memory.close();
		}
	});
});

describe("C25 DeltaSync column allowlist", () => {
	it("filters unknown and malicious columns while applying valid inserts", () => {
		const { memory, root } = seededMemory();
		try {
			const sync = new DeltaSync(memory, join(root, "sync"));
			const stats = sync.applyDelta("peer-a", [
				{
					id: "new-row-1",
					content: "legit content",
					source: "test",
					timestamp: "2026-05-11T00:00:00",
					session_id: "attacker-session-claim",
					importance: 0.5,
					"foo); DROP TABLE episodic_memory; --": "evil",
					totally_made_up_column: "garbage",
				},
			]);
			expect(stats.inserted).toBe(1);
			expect(stats.filtered_keys).toBeGreaterThanOrEqual(2);

			const row = memory.conn
				.query("SELECT content, session_id FROM working_memory WHERE id = ?")
				.get("new-row-1") as { content: string; session_id: string } | null;
			expect(row?.content).toBe("legit content");
			expect(row?.session_id).not.toBe("attacker-session-claim");
			expect(
				memory.conn.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'episodic_memory'").get(),
			).not.toBeNull();
		} finally {
			memory.close();
		}
	});

	it("filters unknown and reserved columns on update", () => {
		const { memory, root } = seededMemory();
		try {
			const sync = new DeltaSync(memory, join(root, "sync"));
			sync.applyDelta("peer-a", [
				{
					id: "upd-row-1",
					content: "initial content",
					source: "test",
					timestamp: "2026-05-11T00:00:00",
					importance: 0.5,
				},
			]);

			const stats = sync.applyDelta("peer-a", [
				{
					id: "upd-row-1",
					content: "updated content",
					timestamp: "2099-01-01T00:00:00",
					created_at: "1970-01-01T00:00:00",
					session_id: "attacker-session",
					superseded_by: "fake-replacement",
					made_up_column: "filtered",
				},
			]);
			expect(stats.updated).toBe(1);
			expect(stats.filtered_keys).toBeGreaterThanOrEqual(5);

			const row = memory.conn
				.query("SELECT content, timestamp, session_id, superseded_by FROM working_memory WHERE id = ?")
				.get("upd-row-1") as Record<string, unknown> | null;
			expect(row?.content).toBe("updated content");
			expect(String(row?.timestamp)).not.toContain("2099");
			expect(row?.session_id).not.toBe("attacker-session");
			expect(row?.superseded_by).toBeNull();
		} finally {
			memory.close();
		}
	});

	it("qualifies writes to main tables so temp shadow tables cannot intercept delta application", () => {
		const { memory, root } = seededMemory();
		try {
			const sync = new DeltaSync(memory, join(root, "sync"));
			memory.conn.run("CREATE TEMP TABLE working_memory (id TEXT, content TEXT)");
			try {
				const stats = sync.applyDelta("peer-x", [
					{
						id: "shadow-test-row",
						content: "should land in main, not temp",
						source: "test",
						timestamp: "2026-05-11T00:00:00",
						importance: 0.5,
					},
				]);
				expect(stats.inserted).toBe(1);
				expect(
					(
						memory.conn.query("SELECT content FROM main.working_memory WHERE id = ?").get("shadow-test-row") as {
							content: string;
						} | null
					)?.content,
				).toContain("should land in main");
				expect(
					(
						memory.conn.query("SELECT COUNT(*) AS total FROM temp.working_memory").get() as {
							total: number;
						}
					).total,
				).toBe(0);
			} finally {
				memory.conn.run("DROP TABLE temp.working_memory");
			}
		} finally {
			memory.close();
		}
	});
});

describe("C25 DeltaSync checkpoint compatibility", () => {
	it("scopes checkpoints by peer and table", () => {
		const { memory, root } = seededMemory();
		try {
			const dir = join(root, "sync");
			const sync = new DeltaSync(memory, dir);
			sync.setCheckpoint(
				"peer-x",
				new SyncCheckpoint({ peerId: "peer-x", lastSyncAt: "2026-01-01T00:00:00", lastRowid: 100 }),
				"working_memory",
			);
			sync.setCheckpoint(
				"peer-x",
				new SyncCheckpoint({ peerId: "peer-x", lastSyncAt: "2026-01-02T00:00:00", lastRowid: 5 }),
				"episodic_memory",
			);

			expect(sync.getCheckpoint("peer-x", "working_memory")?.lastRowid).toBe(100);
			expect(sync.getCheckpoint("peer-x", "episodic_memory")?.lastRowid).toBe(5);
			const sync2 = new DeltaSync(memory, dir);
			expect(sync2.getCheckpoint("peer-x", "working_memory")?.lastRowid).toBe(100);
			expect(sync2.getCheckpoint("peer-x", "episodic_memory")?.lastRowid).toBe(5);
		} finally {
			memory.close();
		}
	});

	it("loads legacy per-peer checkpoint files as working-memory checkpoints", () => {
		const { memory, root } = seededMemory();
		try {
			const dir = join(root, "sync");
			new DeltaSync(memory, dir);
			writeFileSync(
				join(dir, "legacy-peer.json"),
				JSON.stringify({
					peer_id: "legacy-peer",
					last_sync_at: "2026-01-01T00:00:00",
					last_rowid: 42,
				}),
			);
			const sync = new DeltaSync(memory, dir);
			expect(sync.getCheckpoint("legacy-peer", "working_memory")?.lastRowid).toBe(42);
			expect(sync.getCheckpoint("legacy-peer", "episodic_memory")).toBeNull();
		} finally {
			memory.close();
		}
	});
});
