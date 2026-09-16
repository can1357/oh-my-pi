import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initBeam } from "@oh-my-pi/pi-mnemopi/core/beam";
import { DeltaSync, EventType, MemoryEvent, MemoryStream, SyncCheckpoint } from "@oh-my-pi/pi-mnemopi/core/streaming";

describe("MemoryEvent", () => {
	it("serializes and restores Python-shaped events", () => {
		const event = new MemoryEvent({
			event_type: EventType.MEMORY_ADDED,
			memory_id: "mem_123",
			session_id: "sess",
			content: "Test",
			importance: 0.7,
		});
		expect(event.toDict().event_type).toBe("MEMORY_ADDED");
		expect(JSON.parse(event.toJSON()).memory_id).toBe("mem_123");
		const restored = MemoryEvent.fromDict({
			event_type: "MEMORY_RECALLED",
			memory_id: "mem_456",
			timestamp: "2026-01-01T00:00:00",
			content: "Recalled",
		});
		expect(restored.eventType).toBe(EventType.MEMORY_RECALLED);
		expect(restored.memoryId).toBe("mem_456");
	});
});

describe("MemoryStream", () => {
	it("invokes typed and any callbacks while isolating exceptions", () => {
		const stream = new MemoryStream(10);
		const calls: string[] = [];
		stream.on(EventType.MEMORY_ADDED, () => {
			throw new Error("boom");
		});
		stream.on(EventType.MEMORY_ADDED, event => calls.push(event.memoryId));
		stream.onAny(event => calls.push(`any:${event.memoryId}`));
		stream.emit(new MemoryEvent({ event_type: EventType.MEMORY_ADDED, memory_id: "a" }));
		expect(calls).toEqual(["a", "any:a"]);
	});

	it("keeps a bounded filterable buffer", () => {
		const stream = new MemoryStream(3);
		stream.emit(new MemoryEvent({ event_type: EventType.MEMORY_ADDED, memory_id: "old" }));
		const since = new Date().toISOString();
		stream.emit(new MemoryEvent({ event_type: EventType.MEMORY_RECALLED, memory_id: "b" }));
		stream.emit(new MemoryEvent({ event_type: EventType.MEMORY_ADDED, memory_id: "c" }));
		stream.emit(new MemoryEvent({ event_type: EventType.MEMORY_ADDED, memory_id: "d" }));
		expect(stream.getBuffer().map(event => event.memoryId)).toEqual(["b", "c", "d"]);
		expect(stream.getBuffer([EventType.MEMORY_ADDED], since).map(event => event.memoryId)).toEqual(["c", "d"]);
		stream.clearBuffer();
		expect(stream.getBuffer()).toHaveLength(0);
	});

	it("feeds async listeners with type filtering", async () => {
		const stream = new MemoryStream();
		const iterator = stream.listen([EventType.MEMORY_RECALLED]);
		const next = iterator.next();
		stream.emit(new MemoryEvent({ event_type: EventType.MEMORY_ADDED, memory_id: "skip" }));
		stream.emit(new MemoryEvent({ event_type: EventType.MEMORY_RECALLED, memory_id: "hit" }));
		await expect(next).resolves.toMatchObject({ value: { memoryId: "hit" }, done: false });
		await iterator.return();
	});
});

describe("DeltaSync", () => {
	it("computes, applies, and persists checkpoints for allowed tables", () => {
		const root = mkdtempSync(join(tmpdir(), "mnemopi-stream-"));
		const db = new Database(":memory:");
		try {
			initBeam(db);
			db.run(
				"INSERT INTO working_memory (id, content, source, timestamp, session_id, importance) VALUES (?, ?, ?, ?, ?, ?)",
				["wm1", "Memory 1", "test", "2026-01-01T00:00:00", "s", 0.5],
			);
			const sync = new DeltaSync({ db }, root);
			const delta = sync.computeDelta("peer", "working_memory");
			expect(delta).toHaveLength(1);
			const stats = sync.applyDelta(
				"peer",
				[{ id: "wm2", content: "Imported", source: "remote", importance: 0.9 }],
				"working_memory",
			);
			expect(stats.inserted).toBe(1);
			expect(sync.getCheckpoint("peer")?.peerId).toBe("peer");
			const reloaded = new DeltaSync({ db }, root);
			expect(reloaded.getCheckpoint("peer")?.peerId).toBe("peer");
		} finally {
			db.close();
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("preserves persisted watermarks across empty and older batches and advances on applied rows", () => {
		const root = mkdtempSync(join(tmpdir(), "mnemopi-stream-"));
		const db = new Database(":memory:");
		try {
			initBeam(db);
			const sync = new DeltaSync({ db }, root);
			sync.saveCheckpoint(new SyncCheckpoint({ peerId: "peer", lastRowid: 100 }));
			sync.saveCheckpoint(new SyncCheckpoint({ peerId: "peer", lastRowid: 500 }), "episodic_memory");
			sync.applyDelta("peer", []);
			expect(new DeltaSync({ db }, root).getCheckpoint("peer")?.lastRowid).toBe(100);

			expect(sync.applyDelta("peer", [{ id: "old", content: "Older", rowid: 50 }]).inserted).toBe(1);
			expect(sync.getCheckpoint("peer")?.lastRowid).toBe(100);

			expect(sync.applyDelta("peer", [{ id: "new", content: "Newer", rowid: 120 }]).inserted).toBe(1);
			expect(sync.getCheckpoint("peer")?.lastRowid).toBe(120);
			expect(sync.applyDelta("peer", [{ id: "old", content: "Updated", rowid: 130 }]).updated).toBe(1);
			expect(new DeltaSync({ db }, root).getCheckpoint("peer")?.lastRowid).toBe(130);
			expect(sync.getCheckpoint("peer", "episodic_memory")?.lastRowid).toBe(500);
		} finally {
			db.close();
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("does not advance checkpoints for skipped rows", () => {
		const root = mkdtempSync(join(tmpdir(), "mnemopi-stream-"));
		const db = new Database(":memory:");
		try {
			initBeam(db);
			const sync = new DeltaSync({ db }, root);
			sync.applyDelta("peer", [{ id: "existing", content: "Original", rowid: 100 }]);
			const stats = sync.applyDelta("peer", [
				{ id: "", content: "Invalid id", rowid: 200 },
				{ id: "missing-content", rowid: 300 },
				{ id: "existing", rowid: 400 },
			]);
			expect(stats.skipped).toBe(3);
			expect(sync.getCheckpoint("peer")?.lastRowid).toBe(100);
			sync.applyDelta("peer", [
				{ id: "accepted", content: "Accepted", rowid: 150 },
				{ id: "still-missing-content", rowid: 500 },
			]);
			expect(new DeltaSync({ db }, root).getCheckpoint("peer")?.lastRowid).toBe(150);
		} finally {
			db.close();
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("ignores invalid rowids without rejecting otherwise applicable rows", () => {
		const root = mkdtempSync(join(tmpdir(), "mnemopi-stream-"));
		const db = new Database(":memory:");
		try {
			initBeam(db);
			const sync = new DeltaSync({ db }, root);
			const invalidRowids = [undefined, "200", NaN, Infinity, -Infinity, 200.5, Number.MAX_SAFE_INTEGER + 1, -1];
			for (const [index, rowid] of invalidRowids.entries()) {
				expect(sync.applyDelta("peer", [{ id: `invalid-${index}`, content: "Applied", rowid }]).inserted).toBe(1);
				expect(sync.getCheckpoint("peer")?.lastRowid).toBe(0);
			}
		} finally {
			db.close();
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("serializes checkpoints", () => {
		const checkpoint = new SyncCheckpoint({
			peer_id: "p1",
			last_sync_at: "2026-01-01T00:00:00",
			last_rowid: 42,
		});
		expect(JSON.parse(checkpoint.toJson()).last_rowid).toBe(42);
	});
});
