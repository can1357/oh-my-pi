import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { ensurePersistedRoster } from "@oh-my-pi/pi-coding-agent/registry/persisted-agents";
import { CURRENT_SESSION_VERSION } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { FileSessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { TempDir } from "@oh-my-pi/pi-utils";
import type { BunFile } from "bun";

/** Latch-cache bound enforced by `ensurePersistedRoster` (see MAX_PERSISTED_ROSTER_LATCHES). */
const MAX_PERSISTED_ROSTER_LATCHES = 32;

function sessionHeader(id: string): string {
	return JSON.stringify({
		type: "session",
		version: CURRENT_SESSION_VERSION,
		id,
		timestamp: "2026-08-25T10:00:00.000Z",
		cwd: "/tmp",
	});
}

function sessionInitRecord(): string {
	return JSON.stringify({
		type: "session_init",
		id: "si",
		parentId: null,
		timestamp: "2026-08-25T10:00:01.000Z",
		systemPrompt: "review",
		task: "review the diff",
		tools: ["read"],
	});
}

/**
 * A transcript whose first record is one oversized line: a metadata read (capped
 * at MAX_METADATA_LINES records) still streams many chunks, so a stat rejection
 * that stayed pending would sit unhandled across several event-loop turns.
 */
function slowTranscript(): string {
	return `${JSON.stringify({
		type: "session",
		version: CURRENT_SESSION_VERSION,
		id: "slow",
		timestamp: "2026-08-25T10:00:00.000Z",
		cwd: "/tmp",
		pad: "x".repeat(8 * 1024 * 1024),
	})}\n`;
}

/**
 * A slow transcript that still registers: an oversized session record in the
 * prefix (so the capped metadata read streams many chunks) followed by a
 * `session_init`, which makes the file a complete, parkable transcript.
 */
function slowTranscriptWithInit(): string {
	return `${sessionHeader("slow")}\n${JSON.stringify({
		type: "session",
		version: CURRENT_SESSION_VERSION,
		id: "pad",
		timestamp: "2026-08-25T10:00:00.000Z",
		cwd: "/tmp",
		pad: "x".repeat(8 * 1024 * 1024),
	})}\n${sessionInitRecord()}\n`;
}

/** Directory a scan lists to find a root's transcripts (`<sessionFile>` minus `.jsonl`). */
function scanDir(sessionFile: string): string {
	return sessionFile.slice(0, -".jsonl".length);
}

/** Collect unhandled-rejection reports raised while the callback runs. */
function captureUnhandledRejections(): () => string[] {
	const reports: unknown[] = [];
	const listener = (reason: unknown) => {
		reports.push(reason);
	};
	process.on("unhandledRejection", listener);
	return () => {
		process.off("unhandledRejection", listener);
		return reports.map(String);
	};
}

function countScans(scans: string[], dir: string): number {
	return scans.filter(target => target === dir).length;
}

/**
 * Record each roster scan by the directory it lists. A scan finds a root's
 * transcripts through the session storage's `*.jsonl` listing, once per scan
 * whether or not the root has children: a latch that holds shows one listing,
 * a re-scan two or more.
 */
function recordScans(scans: string[]): void {
	const realListFilesSync = FileSessionStorage.prototype.listFilesSync;
	vi.spyOn(FileSessionStorage.prototype, "listFilesSync").mockImplementation(function (
		this: FileSessionStorage,
		dir: string,
		pattern: string,
	) {
		if (pattern === "*.jsonl") scans.push(dir);
		return realListFilesSync.call(this, dir, pattern);
	});
}

/**
 * Fail `childFile`'s stat, which the scan reads through the session storage,
 * with a transient coded fault while `armed()` holds. `fired` counts the
 * faults raised, so a test proves its fault reached the scan.
 */
function spyOnStatFault(childFile: string, code: string, armed: () => boolean = () => true): { fired: number } {
	const faults = { fired: 0 };
	const realStatSync = FileSessionStorage.prototype.statSync;
	vi.spyOn(FileSessionStorage.prototype, "statSync").mockImplementation(function (
		this: FileSessionStorage,
		target: string,
	) {
		if (target === childFile && armed()) {
			faults.fired++;
			throw Object.assign(new Error(`${code}: ${childFile}`), { code });
		}
		return realStatSync.call(this, target);
	});
	return faults;
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("persisted roster metadata fault settling", () => {
	it("settles a stat fault instead of leaving a rejecting promise pending", async () => {
		using tempDir = TempDir.createSync("@omp-roster-stat-fault-");
		const dir = tempDir.path();
		const rootFile = path.join(dir, "main.jsonl");
		const childFile = path.join(dir, "main", "Worker.jsonl");
		await Bun.write(rootFile, `${sessionHeader("main")}\n`);
		// The metadata read on this file streams many chunks while the stat fault
		// is immediate: a stat left pending beside the stream would hold its
		// rejection unhandled for the whole stream, which Bun reports (and can
		// terminate on).
		await Bun.write(childFile, slowTranscript());
		const statFault = spyOnStatFault(childFile, "EMFILE");
		const unhandled = captureUnhandledRejections();
		try {
			const registry = new AgentRegistry();
			const root = await ensurePersistedRoster(registry, rootFile);
			expect(root).toBe(rootFile);
			expect(statFault.fired).toBe(1);
		} finally {
			expect(unhandled()).toEqual([]);
		}
	}, 10_000);

	it("degrades gracefully and re-scans when a transcript stream fails to open", async () => {
		using tempDir = TempDir.createSync("@omp-roster-stream-fault-");
		const dir = tempDir.path();
		const rootFile = path.join(dir, "main.jsonl");
		const childFile = path.join(dir, "main", "Worker.jsonl");
		await Bun.write(rootFile, `${sessionHeader("main")}\n`);
		await Bun.write(childFile, `${sessionHeader("worker")}\n${sessionInitRecord()}\n`);
		// The scan reads the stat synchronously before it opens the stream, so a
		// stat fault stops the read before any stream exists (the test above).
		// Here the stat succeeds and the stream open fails.
		let streamFaults = 0;
		const realBunFile = Bun.file;
		vi.spyOn(Bun, "file").mockImplementation((target: string | URL | Uint8Array | ArrayBufferLike | number) => {
			if (target === childFile) {
				return {
					stream: () => {
						streamFaults++;
						throw Object.assign(new Error("too many open files"), { code: "EMFILE" });
					},
				} as unknown as BunFile;
			}
			return realBunFile(target as string | URL);
		});
		const scans: string[] = [];
		recordScans(scans);
		const unhandled = captureUnhandledRejections();
		try {
			const registry = new AgentRegistry();
			const first = await ensurePersistedRoster(registry, rootFile);
			expect(first).toBe(rootFile);
			// The failed scan dropped its latch, so a retry re-scans instead of
			// sticking to the degraded result.
			const second = await ensurePersistedRoster(registry, rootFile);
			expect(second).toBe(rootFile);
			expect(countScans(scans, scanDir(rootFile))).toBe(2);
			expect(streamFaults).toBe(2);
		} finally {
			expect(unhandled()).toEqual([]);
		}
	}, 10_000);
});

describe("persisted roster latch semantics", () => {
	it("shares one scan across concurrent same-root calls", async () => {
		using tempDir = TempDir.createSync("@omp-roster-single-flight-");
		const dir = tempDir.path();
		const rootFile = path.join(dir, "main.jsonl");
		await Bun.write(rootFile, `${sessionHeader("main")}\n`);
		const scans: string[] = [];
		recordScans(scans);
		const registry = new AgentRegistry();
		const [first, second] = await Promise.all([
			ensurePersistedRoster(registry, rootFile),
			ensurePersistedRoster(registry, rootFile),
		]);
		expect(first).toBe(rootFile);
		expect(second).toBe(rootFile);
		expect(countScans(scans, scanDir(rootFile))).toBe(1);
	});

	it("keeps distinct roots latched independently", async () => {
		using tempDir = TempDir.createSync("@omp-roster-two-roots-");
		const dir = tempDir.path();
		const rootA = path.join(dir, "a", "main.jsonl");
		const rootB = path.join(dir, "b", "main.jsonl");
		await Bun.write(rootA, `${sessionHeader("a")}\n`);
		await Bun.write(rootB, `${sessionHeader("b")}\n`);
		const scans: string[] = [];
		recordScans(scans);
		const registry = new AgentRegistry();
		const firstA = ensurePersistedRoster(registry, rootA);
		const firstB = ensurePersistedRoster(registry, rootB);
		// Root A's scan is still in flight when a second A call arrives; it must
		// join that scan (the single-slot design evicted A here and re-scanned).
		const secondA = ensurePersistedRoster(registry, rootA);
		const [ra1, rb1, ra2] = await Promise.all([firstA, firstB, secondA]);
		expect(ra1).toBe(rootA);
		expect(rb1).toBe(rootB);
		expect(ra2).toBe(rootA);
		expect(countScans(scans, scanDir(rootA))).toBe(1);
		expect(countScans(scans, scanDir(rootB))).toBe(1);
	});

	it("serializes scan bodies so a shared child basename is never latched-missed", async () => {
		using tempDir = TempDir.createSync("@omp-roster-shared-child-");
		const dir = tempDir.path();
		const rootA = path.join(dir, "a", "main.jsonl");
		const rootB = path.join(dir, "b", "main.jsonl");
		const childA = path.join(dir, "a", "main", "Worker.jsonl");
		const childB = path.join(dir, "b", "main", "Worker.jsonl");
		// Root A's child streams slowly: with interleaved scans, root B captures
		// the shared id as unregistered and stalls on its own metadata read until
		// A registers, then CAS-skips — a settled latch that never saw its own
		// transcript. The serialization tail queues B behind A instead, so B
		// observes A's registration and replaces it.
		await Bun.write(rootA, `${sessionHeader("a")}\n`);
		await Bun.write(rootB, `${sessionHeader("b")}\n`);
		await Bun.write(childA, slowTranscriptWithInit());
		await Bun.write(childB, `${sessionHeader("worker")}\n${sessionInitRecord()}\n`);
		// Hold B's metadata read at the transcript stream it awaits, which comes
		// after B has looked up the shared id and before it registers: an
		// interleaved B scan waits here with a stale lookup until A is done.
		const childBGate = Promise.withResolvers<void>();
		const releaseChildB = () => childBGate.resolve();
		let childBReads = 0;
		const realBunFile = Bun.file;
		vi.spyOn(Bun, "file").mockImplementation((target: string | URL | Uint8Array | ArrayBufferLike | number) => {
			if (target !== childB) return realBunFile(target as string | URL);
			return {
				stream: () => {
					childBReads++;
					const reader = realBunFile(childB).stream().getReader();
					return new ReadableStream<Uint8Array>({
						async pull(controller) {
							await childBGate.promise;
							const { done, value } = await reader.read();
							if (done) controller.close();
							else controller.enqueue(value);
						},
					});
				},
			} as unknown as BunFile;
		});
		const scans: string[] = [];
		recordScans(scans);
		const registry = new AgentRegistry();
		const pA = ensurePersistedRoster(registry, rootA);
		const pB = ensurePersistedRoster(registry, rootB);
		// Root A's scan (the first in the queue) registers the shared child; only
		// then does B's metadata read proceed, so B must observe A's ref.
		await pA;
		releaseChildB();
		await pB;
		// B's metadata read went through the held stream: the gate is on its path.
		expect(childBReads).toBe(1);
		// The later scan's registration is the current one: B's transcript, not A's.
		expect(registry.get("Worker")?.sessionFile).toBe(childB);
		expect(registry.get("Worker")?.status).toBe("parked");
		// B's latch settled with that result: a repeated call does not re-scan.
		await ensurePersistedRoster(registry, rootB);
		expect(countScans(scans, scanDir(rootB))).toBe(1);
	}, 10_000);

	it("keeps the scan queue moving after a failed root scan", async () => {
		using tempDir = TempDir.createSync("@omp-roster-queue-failure-");
		const dir = tempDir.path();
		const rootA = path.join(dir, "a", "main.jsonl");
		const rootB = path.join(dir, "b", "main.jsonl");
		const childA = path.join(dir, "a", "main", "Worker.jsonl");
		const childB = path.join(dir, "b", "main", "Worker.jsonl");
		await Bun.write(rootA, `${sessionHeader("a")}\n`);
		await Bun.write(rootB, `${sessionHeader("b")}\n`);
		await Bun.write(childA, `${sessionHeader("worker")}\n${sessionInitRecord()}\n`);
		await Bun.write(childB, `${sessionHeader("worker")}\n${sessionInitRecord()}\n`);
		const statFault = spyOnStatFault(childA, "EACCES");
		const scans: string[] = [];
		recordScans(scans);
		const registry = new AgentRegistry();
		const [ra, rb] = await Promise.all([
			ensurePersistedRoster(registry, rootA),
			ensurePersistedRoster(registry, rootB),
		]);
		expect(ra).toBe(rootA);
		expect(rb).toBe(rootB);
		// A's failed scan did not poison the queue: B's scan still ran and
		// registered its child.
		expect(registry.get("Worker")?.sessionFile).toBe(childB);
		// A's failed scan dropped its latch: a retry re-scans A, and its stat
		// faults again, so B's ref stays current — a scan that had swallowed the
		// fault would have restored A's transcript here.
		await ensurePersistedRoster(registry, rootA);
		expect(countScans(scans, scanDir(rootA))).toBe(2);
		expect(statFault.fired).toBe(2);
		expect(registry.get("Worker")?.sessionFile).toBe(childB);
	});

	it("bounds remembered latches by evicting only settled ones", async () => {
		using tempDir = TempDir.createSync("@omp-roster-latch-bound-");
		const dir = tempDir.path();
		const rootFor = (index: number) => path.join(dir, `root-${index}`, "main.jsonl");
		const rootCount = MAX_PERSISTED_ROSTER_LATCHES + 1;
		const scans: string[] = [];
		recordScans(scans);
		const registry = new AgentRegistry();
		const roots = Array.from({ length: rootCount }, (_, index) => rootFor(index));
		// The first root's scan streams slowly, so every latch is inserted
		// (unsettled) before the first scan settles: the bound overflow at the
		// 33rd insertion can only prune settled entries — there are none yet.
		await Promise.all(roots.map(root => Bun.write(root, root === roots[0] ? slowTranscript() : "")));
		const resolved = await Promise.all(roots.map(root => ensurePersistedRoster(registry, root)));
		for (const root of resolved) expect(root).toBeDefined();
		// All 33 scans were queued or in flight when the 33rd latch was inserted;
		// none was evicted, so root 0's settled latch still dedupes a repeat.
		await ensurePersistedRoster(registry, rootFor(0));
		expect(countScans(scans, scanDir(rootFor(0)))).toBe(1);
		// A new root pushes the cache over its bound; only settled entries are
		// forgotten (oldest first), so roots 0 and 1 are evicted...
		await ensurePersistedRoster(registry, rootFor(rootCount));
		// ...a still-latched root does not re-scan...
		await ensurePersistedRoster(registry, rootFor(2));
		expect(countScans(scans, scanDir(rootFor(2)))).toBe(1);
		// ...while a repeated call for an evicted root re-scans.
		await ensurePersistedRoster(registry, rootFor(0));
		expect(countScans(scans, scanDir(rootFor(0)))).toBe(2);
	}, 10_000);
	it("re-scans a root whose parked ref another root superseded (A→B→A)", async () => {
		using tempDir = TempDir.createSync("@omp-roster-supersede-");
		const dir = tempDir.path();
		const rootA = path.join(dir, "a", "main.jsonl");
		const rootB = path.join(dir, "b", "main.jsonl");
		const childA = path.join(dir, "a", "main", "Worker.jsonl");
		const childB = path.join(dir, "b", "main", "Worker.jsonl");
		await Bun.write(rootA, `${sessionHeader("a")}\n`);
		await Bun.write(rootB, `${sessionHeader("b")}\n`);
		await Bun.write(childA, `${sessionHeader("worker")}\n${sessionInitRecord()}\n`);
		await Bun.write(childB, `${sessionHeader("worker")}\n${sessionInitRecord()}\n`);
		const scans: string[] = [];
		recordScans(scans);
		const registry = new AgentRegistry();
		await ensurePersistedRoster(registry, rootA);
		expect(registry.get("Worker")?.sessionFile).toBe(childA);
		expect(countScans(scans, scanDir(rootA))).toBe(1);
		// Root B's scan replaces the shared id globally: the parked ref now
		// targets B's transcript.
		await ensurePersistedRoster(registry, rootB);
		expect(registry.get("Worker")?.sessionFile).toBe(childB);
		// Returning to root A must not early-return off A's settled latch: the
		// ref its scan restored no longer matches registry identity/session, so
		// A is re-scanned and its own transcript wins again — the session,
		// history, and messaging refs all target A's file.
		await ensurePersistedRoster(registry, rootA);
		expect(registry.get("Worker")?.sessionFile).toBe(childA);
		expect(registry.get("Worker")?.status).toBe("parked");
		expect(countScans(scans, scanDir(rootA))).toBe(2);
		// A's restored latch is valid again: a repeated call does not re-scan.
		await ensurePersistedRoster(registry, rootA);
		expect(countScans(scans, scanDir(rootA))).toBe(2);
		// B's latch was superseded by A's re-scan; revisiting B refreshes it.
		await ensurePersistedRoster(registry, rootB);
		expect(registry.get("Worker")?.sessionFile).toBe(childB);
		expect(countScans(scans, scanDir(rootB))).toBe(2);
	}, 10_000);

	it("refreshes only the superseded refs of a root (partial supersession)", async () => {
		using tempDir = TempDir.createSync("@omp-roster-partial-");
		const dir = tempDir.path();
		const rootA = path.join(dir, "a", "main.jsonl");
		const rootB = path.join(dir, "b", "main.jsonl");
		const childA1 = path.join(dir, "a", "main", "Worker1.jsonl");
		const childA2 = path.join(dir, "a", "main", "Worker2.jsonl");
		const childB1 = path.join(dir, "b", "main", "Worker1.jsonl");
		await Bun.write(rootA, `${sessionHeader("a")}\n`);
		await Bun.write(rootB, `${sessionHeader("b")}\n`);
		await Bun.write(childA1, `${sessionHeader("worker1")}\n${sessionInitRecord()}\n`);
		await Bun.write(childA2, `${sessionHeader("worker2")}\n${sessionInitRecord()}\n`);
		await Bun.write(childB1, `${sessionHeader("worker1")}\n${sessionInitRecord()}\n`);
		const scans: string[] = [];
		recordScans(scans);
		const registry = new AgentRegistry();
		await ensurePersistedRoster(registry, rootA);
		expect(registry.get("Worker1")?.sessionFile).toBe(childA1);
		expect(registry.get("Worker2")?.sessionFile).toBe(childA2);
		// B owns only Worker1: it replaces just that one; Worker2 stays A's.
		await ensurePersistedRoster(registry, rootB);
		expect(registry.get("Worker1")?.sessionFile).toBe(childB1);
		expect(registry.get("Worker2")?.sessionFile).toBe(childA2);
		// A's latch detects Worker1 moved; re-scanning restores Worker1 without
		// touching Worker2's still-valid ref.
		await ensurePersistedRoster(registry, rootA);
		expect(registry.get("Worker1")?.sessionFile).toBe(childA1);
		expect(registry.get("Worker2")?.sessionFile).toBe(childA2);
		expect(countScans(scans, scanDir(rootA))).toBe(2);
		expect(countScans(scans, scanDir(rootB))).toBe(1);
		// B's latch is stale again (Worker1 moved back to A); revisiting B
		// refreshes it, still leaving Worker2 on A.
		await ensurePersistedRoster(registry, rootB);
		expect(registry.get("Worker1")?.sessionFile).toBe(childB1);
		expect(registry.get("Worker2")?.sessionFile).toBe(childA2);
		expect(countScans(scans, scanDir(rootB))).toBe(2);
	}, 10_000);

	it("re-scans a root whose restored ref was released", async () => {
		using tempDir = TempDir.createSync("@omp-roster-released-");
		const dir = tempDir.path();
		const rootFile = path.join(dir, "main.jsonl");
		const childFile = path.join(dir, "main", "Worker.jsonl");
		await Bun.write(rootFile, `${sessionHeader("main")}\n`);
		await Bun.write(childFile, `${sessionHeader("worker")}\n${sessionInitRecord()}\n`);
		const scans: string[] = [];
		recordScans(scans);
		const registry = new AgentRegistry();
		await ensurePersistedRoster(registry, rootFile);
		expect(registry.get("Worker")?.sessionFile).toBe(childFile);
		expect(countScans(scans, scanDir(rootFile))).toBe(1);
		// A release removes the ref the latch restored; the next ensure sees the
		// missing ref and re-scans to restore it.
		expect(registry.unregister("Worker")).toBe(true);
		await ensurePersistedRoster(registry, rootFile);
		expect(registry.get("Worker")?.sessionFile).toBe(childFile);
		expect(countScans(scans, scanDir(rootFile))).toBe(2);
	}, 10_000);

	it("keeps a settled latch valid for a tombstoned transcript", async () => {
		using tempDir = TempDir.createSync("@omp-roster-tombstone-");
		const dir = tempDir.path();
		const rootFile = path.join(dir, "main.jsonl");
		const childFile = path.join(dir, "main", "Worker.jsonl");
		await Bun.write(rootFile, `${sessionHeader("main")}\n`);
		await Bun.write(childFile, `${sessionHeader("worker")}\n${sessionInitRecord()}\n`);
		await Bun.write(`${childFile}.tombstone`, "");
		const scans: string[] = [];
		recordScans(scans);
		const registry = new AgentRegistry();
		await ensurePersistedRoster(registry, rootFile);
		expect(registry.get("Worker")?.status).toBe("aborted");
		expect(registry.get("Worker")?.sessionFile).toBe(childFile);
		// The restored aborted ref still matches the latch token: no re-scan.
		await ensurePersistedRoster(registry, rootFile);
		expect(countScans(scans, scanDir(rootFile))).toBe(1);
	}, 10_000);

	it("does not re-scan when a transcript file vanishes after its latch settled", async () => {
		using tempDir = TempDir.createSync("@omp-roster-vanished-");
		const dir = tempDir.path();
		const rootFile = path.join(dir, "main.jsonl");
		const childFile = path.join(dir, "main", "Worker.jsonl");
		await Bun.write(rootFile, `${sessionHeader("main")}\n`);
		await Bun.write(childFile, `${sessionHeader("worker")}\n${sessionInitRecord()}\n`);
		const scans: string[] = [];
		recordScans(scans);
		const registry = new AgentRegistry();
		await ensurePersistedRoster(registry, rootFile);
		expect(registry.get("Worker")?.sessionFile).toBe(childFile);
		expect(countScans(scans, scanDir(rootFile))).toBe(1);
		await fs.promises.rm(childFile);
		// The ref's id+file identity is intact even though the transcript is
		// gone; the settled latch stays valid and no re-scan runs.
		await ensurePersistedRoster(registry, rootFile);
		expect(registry.get("Worker")?.sessionFile).toBe(childFile);
		expect(countScans(scans, scanDir(rootFile))).toBe(1);
	}, 10_000);

	it("retries a supersession refresh whose scan failed", async () => {
		using tempDir = TempDir.createSync("@omp-roster-refresh-failure-");
		const dir = tempDir.path();
		const rootA = path.join(dir, "a", "main.jsonl");
		const rootB = path.join(dir, "b", "main.jsonl");
		const childA = path.join(dir, "a", "main", "Worker.jsonl");
		const childB = path.join(dir, "b", "main", "Worker.jsonl");
		await Bun.write(rootA, `${sessionHeader("a")}\n`);
		await Bun.write(rootB, `${sessionHeader("b")}\n`);
		await Bun.write(childA, `${sessionHeader("worker")}\n${sessionInitRecord()}\n`);
		await Bun.write(childB, `${sessionHeader("worker")}\n${sessionInitRecord()}\n`);
		let failChildA = false;
		const statFault = spyOnStatFault(childA, "EACCES", () => failChildA);
		const scans: string[] = [];
		recordScans(scans);
		const registry = new AgentRegistry();
		await ensurePersistedRoster(registry, rootA);
		expect(registry.get("Worker")?.sessionFile).toBe(childA);
		await ensurePersistedRoster(registry, rootB);
		expect(registry.get("Worker")?.sessionFile).toBe(childB);
		// A's refresh scan faults on its child: the scan fails and drops the
		// latch, so B's ref stays current and the failure stays retryable.
		failChildA = true;
		await ensurePersistedRoster(registry, rootA);
		expect(registry.get("Worker")?.sessionFile).toBe(childB);
		expect(countScans(scans, scanDir(rootA))).toBe(2);
		expect(statFault.fired).toBe(1);
		failChildA = false;
		await ensurePersistedRoster(registry, rootA);
		expect(registry.get("Worker")?.sessionFile).toBe(childA);
		expect(countScans(scans, scanDir(rootA))).toBe(3);
	}, 10_000);
});
