/**
 * Resume must not pay one storage round trip per stored session.
 *
 * With the shared SQL store every per-file read is a WAN query; resolving one
 * resume key used to content-scan every file of the local bucket and then of
 * the whole store (3248 rows on backend.ai: ~19s in `createSessionManager`),
 * and `findSessionContinuation` scanned every sibling named after the target.
 * These tests count storage reads, not wall-clock time: a resolution among
 * many decoys must read each candidate's header through one batched call per
 * scope and content-scan only the files the key can name.
 */
import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { findSessionContinuation, resolveResumableSession } from "@oh-my-pi/pi-coding-agent/session/session-listing";
import { MemorySessionStorage, type SessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { __resetDirsFromEnvForTests, setAgentDir } from "@oh-my-pi/pi-utils";
import { getSessionsDir } from "@oh-my-pi/pi-utils/dirs";

/** MemorySessionStorage plus counters for the reads a resume performs. */
class CountingSessionStorage extends MemorySessionStorage {
	sliceReads = 0;
	batchReads = 0;

	override readTextSlices(file: string, prefixBytes: number, suffixBytes: number) {
		this.sliceReads++;
		return super.readTextSlices(file, prefixBytes, suffixBytes);
	}

	override readTextPrefixes(paths: readonly string[], prefixBytes: number) {
		this.batchReads++;
		return super.readTextPrefixes(paths, prefixBytes);
	}
}

/** A storage with the batched read removed: resolution must still work. */
class UnbatchedSessionStorage extends MemorySessionStorage {}
delete (UnbatchedSessionStorage.prototype as { readTextPrefixes?: unknown }).readTextPrefixes;

function sessionLine(id: string, created: string, extra: Record<string, unknown> = {}): string {
	return JSON.stringify({ type: "session", id, cwd: "/proj", timestamp: created, ...extra }) + "\n";
}

function messageLine(id: string, timestamp: string, role: "user" | "assistant", text: string): string {
	return (
		JSON.stringify({
			type: "message",
			id,
			timestamp,
			message: { role, content: [{ type: "text", text }] },
		}) + "\n"
	);
}

function sessionContent(id: string, created: string, extra: Record<string, unknown> = {}): string {
	return (
		sessionLine(id, created, extra) +
		messageLine("m1", created, "user", "hello") +
		messageLine("m2", created, "assistant", "hi")
	);
}

function sessionFileName(created: string, id: string): string {
	return created.replace(/:/g, "-").replace(/\./g, "-") + "_" + id + ".jsonl";
}

/** Writes numbered decoy sessions plus an optional highlighted entry into `dir`. */
async function seedDecoys(
	dir: string,
	count: number,
	storage: SessionStorage,
	named: Array<{ id: string; created: string; extra?: Record<string, unknown> }> = [],
): Promise<void> {
	await fsp.mkdir(dir, { recursive: true });
	for (let i = 0; i < count; i++) {
		const id = "d" + String(i).padStart(12, "0") + "-1111-2222-3333-444444444444";
		const created = "2026-11-02T09:00:00.000Z";
		storage.writeTextSync(path.join(dir, sessionFileName(created, id)), sessionContent(id, created));
	}
	for (const { id, created, extra } of named) {
		storage.writeTextSync(path.join(dir, sessionFileName(created, id)), sessionContent(id, created, extra));
	}
}

describe("resolveResumableSession storage reads", () => {
	let agentRoot: string;

	beforeEach(async () => {
		agentRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-batch-agent-"));
		setAgentDir(path.join(agentRoot, "agent"));
	});

	afterAll(async () => {
		__resetDirsFromEnvForTests();
		if (agentRoot) await fsp.rm(agentRoot, { recursive: true, force: true });
	});

	it("reads one batched header set instead of one content read per local session", async () => {
		const storage = new CountingSessionStorage();
		const sessionDir = path.join(agentRoot, "local-sessions");
		await seedDecoys(sessionDir, 60, storage, [
			{ id: "aa12ptarget-1111-2222-3333-444444444444", created: "2026-11-02T09:30:00.000Z" },
		]);

		const match = await resolveResumableSession("aa12ptarget", "/proj", sessionDir, storage);

		expect(match?.scope).toBe("local");
		expect(match?.session.id).toBe("aa12ptarget-1111-2222-3333-444444444444");
		// The key names the file, so no sibling header is read at all.
		expect(storage.sliceReads).toBeLessThanOrEqual(1);
		expect(storage.batchReads).toBe(0);
	});

	it("batches the global fallback scan instead of reading every stored session", async () => {
		const storage = new CountingSessionStorage();
		const globalBucket = path.join(getSessionsDir(), "-global-bucket");
		await seedDecoys(globalBucket, 60, storage, [
			{ id: "bb987target-1111-2222-3333-444444444444", created: "2026-11-02T09:30:00.000Z" },
		]);

		const match = await resolveResumableSession("bb987target", "/proj", undefined, storage);

		expect(match?.scope).toBe("global");
		expect(match?.session.id).toBe("bb987target-1111-2222-3333-444444444444");
		expect(storage.sliceReads).toBeLessThanOrEqual(2);
		expect(storage.batchReads).toBe(0);
	});

	it("still resolves when the storage has no batched header read", async () => {
		const storage = new UnbatchedSessionStorage();
		const sessionDir = path.join(agentRoot, "local-sessions");
		await seedDecoys(sessionDir, 10, storage, [
			{ id: "cc456target-1111-2222-3333-444444444444", created: "2026-11-02T09:30:00.000Z" },
		]);

		const match = await resolveResumableSession("cc456target", "/proj", sessionDir, storage);

		expect(match?.scope).toBe("local");
		expect(match?.session.id).toBe("cc456target-1111-2222-3333-444444444444");
	});
});

describe("findSessionContinuation storage reads", () => {
	it("scans only the siblings a continuation link names, not every later file", async () => {
		const storage = new CountingSessionStorage();
		const dir = path.join(os.tmpdir(), "omp-batch-continuation-" + process.pid);
		await fsp.mkdir(dir, { recursive: true });
		try {
			const rootId = "root12345-1111-2222-3333-444444444444";
			storage.writeTextSync(
				path.join(dir, sessionFileName("2026-11-02T08:00:00.000Z", rootId)),
				sessionContent(rootId, "2026-11-02T08:00:00.000Z"),
			);
			const later = 40;
			for (let i = 0; i < later; i++) {
				const id = "s" + String(i).padStart(12, "0") + "-1111-2222-3333-444444444444";
				storage.writeTextSync(
					path.join(dir, sessionFileName("2026-11-02T09:10:00.000Z", id)),
					sessionContent(id, "2026-11-02T09:10:00.000Z"),
				);
			}
			const childId = "child6789-1111-2222-3333-444444444444";
			storage.writeTextSync(
				path.join(dir, sessionFileName("2026-11-02T09:20:00.000Z", childId)),
				sessionLine(childId, "2026-11-02T09:20:00.000Z", { continuationOf: rootId }) +
					messageLine("m1", "2026-11-02T08:00:00.000Z", "user", "hello") +
					messageLine("m2", "2026-11-02T08:00:00.000Z", "assistant", "hi") +
					messageLine("m9", "2026-11-02T09:20:01.000Z", "assistant", "carried on"),
			);

			const continuation = await findSessionContinuation(
				path.join(dir, sessionFileName("2026-11-02T08:00:00.000Z", rootId)),
				storage,
			);

			expect(continuation?.session.id).toBe(childId);
			expect(storage.sliceReads).toBeLessThanOrEqual(6);
		} finally {
			await fsp.rm(dir, { recursive: true, force: true });
		}
	});
});
