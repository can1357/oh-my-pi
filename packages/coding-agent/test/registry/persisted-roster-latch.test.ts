import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { ensurePersistedRoster } from "@oh-my-pi/pi-coding-agent/registry/persisted-agents";
import { CURRENT_SESSION_VERSION } from "@oh-my-pi/pi-coding-agent/session/session-entries";
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

/** Directory a scan reads to list a root's transcripts (`<sessionFile>` minus `.jsonl`). */
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

function countReaddirs(readdirs: string[], dir: string): number {
	return readdirs.filter(target => target === dir).length;
}

/** Spy on `fs.promises.readdir`, recording each scanned directory. */
function spyOnReaddirs(readdirs: string[]): void {
	const realReaddir = fsp.readdir;
	vi.spyOn(fs.promises, "readdir").mockImplementation((async (target: fs.PathLike) => {
		readdirs.push(String(target));
		return realReaddir(target, { withFileTypes: true });
	}) as unknown as typeof fsp.readdir);
}

/** Spy on `fs.promises.stat`, failing `childFile` with a transient coded fault. */
function spyOnStatFault(childFile: string, code: string): void {
	const realStat = fsp.stat;
	vi.spyOn(fs.promises, "stat").mockImplementation((async (target: fs.PathLike) => {
		if (target === childFile) {
			throw Object.assign(new Error(`${code}: ${childFile}`), { code });
		}
		return realStat(target);
	}) as typeof fs.promises.stat);
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("persisted roster metadata fault settling", () => {
	it("settles an eager stat fault instead of leaving a rejecting promise pending", async () => {
		using tempDir = TempDir.createSync("@omp-roster-stat-fault-");
		const dir = tempDir.path();
		const rootFile = path.join(dir, "main.jsonl");
		const childFile = path.join(dir, "main", "Worker.jsonl");
		await Bun.write(rootFile, `${sessionHeader("main")}\n`);
		// The metadata read on this file streams many chunks while the stat fault
		// is immediate: the old code left the stat rejection unhandled for the
		// whole stream, which Bun reports (and can terminate on).
		await Bun.write(childFile, slowTranscript());
		spyOnStatFault(childFile, "EMFILE");
		const unhandled = captureUnhandledRejections();
		try {
			const registry = new AgentRegistry();
			const root = await ensurePersistedRoster(registry, rootFile);
			expect(root).toBe(rootFile);
		} finally {
			expect(unhandled()).toEqual([]);
		}
	}, 10_000);

	it("still degrades gracefully when the stream and the stat fail together", async () => {
		using tempDir = TempDir.createSync("@omp-roster-simultaneous-");
		const dir = tempDir.path();
		const rootFile = path.join(dir, "main.jsonl");
		const childFile = path.join(dir, "main", "Worker.jsonl");
		await Bun.write(rootFile, `${sessionHeader("main")}\n`);
		await Bun.write(childFile, `${sessionHeader("worker")}\n${sessionInitRecord()}\n`);
		spyOnStatFault(childFile, "EMFILE");
		// The stream-open error fires before the stat result is consumed: the
		// eager stat must already be settled so its fault is not abandoned.
		const realBunFile = Bun.file;
		vi.spyOn(Bun, "file").mockImplementation((target: string | URL | Uint8Array | ArrayBufferLike | number) => {
			if (target === childFile) {
				return {
					exists: async () => false,
					stream: () => {
						throw Object.assign(new Error("too many open files"), { code: "EMFILE" });
					},
				} as unknown as BunFile;
			}
			return realBunFile(target as string | URL);
		});
		const readdirs: string[] = [];
		spyOnReaddirs(readdirs);
		const unhandled = captureUnhandledRejections();
		try {
			const registry = new AgentRegistry();
			const first = await ensurePersistedRoster(registry, rootFile);
			expect(first).toBe(rootFile);
			// The failed scan dropped its latch, so a retry re-scans instead of
			// sticking to the degraded result.
			const second = await ensurePersistedRoster(registry, rootFile);
			expect(second).toBe(rootFile);
			expect(countReaddirs(readdirs, scanDir(rootFile))).toBe(2);
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
		const readdirs: string[] = [];
		spyOnReaddirs(readdirs);
		const registry = new AgentRegistry();
		const [first, second] = await Promise.all([
			ensurePersistedRoster(registry, rootFile),
			ensurePersistedRoster(registry, rootFile),
		]);
		expect(first).toBe(rootFile);
		expect(second).toBe(rootFile);
		expect(countReaddirs(readdirs, scanDir(rootFile))).toBe(1);
	});

	it("keeps distinct roots latched independently", async () => {
		using tempDir = TempDir.createSync("@omp-roster-two-roots-");
		const dir = tempDir.path();
		const rootA = path.join(dir, "a", "main.jsonl");
		const rootB = path.join(dir, "b", "main.jsonl");
		await Bun.write(rootA, `${sessionHeader("a")}\n`);
		await Bun.write(rootB, `${sessionHeader("b")}\n`);
		const readdirs: string[] = [];
		spyOnReaddirs(readdirs);
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
		expect(countReaddirs(readdirs, scanDir(rootA))).toBe(1);
		expect(countReaddirs(readdirs, scanDir(rootB))).toBe(1);
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
		const realStat = fsp.stat;
		const childBGate = Promise.withResolvers<void>();
		const releaseChildB = () => childBGate.resolve();
		vi.spyOn(fs.promises, "stat").mockImplementation((async (target: fs.PathLike) => {
			if (target === childB) await childBGate.promise;
			return realStat(target);
		}) as typeof fs.promises.stat);
		const readdirs: string[] = [];
		spyOnReaddirs(readdirs);
		const registry = new AgentRegistry();
		const pA = ensurePersistedRoster(registry, rootA);
		const pB = ensurePersistedRoster(registry, rootB);
		// Root A's scan (the first in the queue) registers the shared child; only
		// then does B's metadata read proceed, so B must observe A's ref.
		await pA;
		releaseChildB();
		await pB;
		// The later scan's registration is the current one: B's transcript, not A's.
		expect(registry.get("Worker")?.sessionFile).toBe(childB);
		expect(registry.get("Worker")?.status).toBe("parked");
		// B's latch settled with that result: a repeated call does not re-scan.
		await ensurePersistedRoster(registry, rootB);
		expect(countReaddirs(readdirs, scanDir(rootB))).toBe(1);
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
		spyOnStatFault(childA, "EACCES");
		const readdirs: string[] = [];
		spyOnReaddirs(readdirs);
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
		// A's failed scan dropped its latch: a retry re-scans A.
		await ensurePersistedRoster(registry, rootA);
		expect(countReaddirs(readdirs, scanDir(rootA))).toBe(2);
	});

	it("bounds remembered latches by evicting only settled ones", async () => {
		using tempDir = TempDir.createSync("@omp-roster-latch-bound-");
		const dir = tempDir.path();
		const rootFor = (index: number) => path.join(dir, `root-${index}`, "main.jsonl");
		const rootCount = MAX_PERSISTED_ROSTER_LATCHES + 1;
		const readdirs: string[] = [];
		spyOnReaddirs(readdirs);
		const registry = new AgentRegistry();
		const roots = Array.from({ length: rootCount }, (_, index) => rootFor(index));
		// The first root's scan streams slowly, so every latch is inserted
		// (unsettled) before the first scan settles: the bound overflow at the
		// 33rd insertion can only prune settled entries — there are none yet.
		await Promise.all(roots.map(root => Bun.write(root, root === roots[0] ? slowTranscript() : "")));
		const scans = await Promise.all(roots.map(root => ensurePersistedRoster(registry, root)));
		for (const root of scans) expect(root).toBeDefined();
		// All 33 scans were queued or in flight when the 33rd latch was inserted;
		// none was evicted, so root 0's settled latch still dedupes a repeat.
		await ensurePersistedRoster(registry, rootFor(0));
		expect(countReaddirs(readdirs, scanDir(rootFor(0)))).toBe(1);
		// A new root pushes the cache over its bound; only settled entries are
		// forgotten (oldest first), so roots 0 and 1 are evicted...
		await ensurePersistedRoster(registry, rootFor(rootCount));
		// ...a still-latched root does not re-scan...
		await ensurePersistedRoster(registry, rootFor(2));
		expect(countReaddirs(readdirs, scanDir(rootFor(2)))).toBe(1);
		// ...while a repeated call for an evicted root re-scans.
		await ensurePersistedRoster(registry, rootFor(0));
		expect(countReaddirs(readdirs, scanDir(rootFor(0)))).toBe(2);
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
		const readdirs: string[] = [];
		spyOnReaddirs(readdirs);
		const registry = new AgentRegistry();
		await ensurePersistedRoster(registry, rootA);
		expect(registry.get("Worker")?.sessionFile).toBe(childA);
		expect(countReaddirs(readdirs, scanDir(rootA))).toBe(1);
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
		expect(countReaddirs(readdirs, scanDir(rootA))).toBe(2);
		// A's restored latch is valid again: a repeated call does not re-scan.
		await ensurePersistedRoster(registry, rootA);
		expect(countReaddirs(readdirs, scanDir(rootA))).toBe(2);
		// B's latch was superseded by A's re-scan; revisiting B refreshes it.
		await ensurePersistedRoster(registry, rootB);
		expect(registry.get("Worker")?.sessionFile).toBe(childB);
		expect(countReaddirs(readdirs, scanDir(rootB))).toBe(2);
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
		const readdirs: string[] = [];
		spyOnReaddirs(readdirs);
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
		expect(countReaddirs(readdirs, scanDir(rootA))).toBe(2);
		expect(countReaddirs(readdirs, scanDir(rootB))).toBe(1);
		// B's latch is stale again (Worker1 moved back to A); revisiting B
		// refreshes it, still leaving Worker2 on A.
		await ensurePersistedRoster(registry, rootB);
		expect(registry.get("Worker1")?.sessionFile).toBe(childB1);
		expect(registry.get("Worker2")?.sessionFile).toBe(childA2);
		expect(countReaddirs(readdirs, scanDir(rootB))).toBe(2);
	}, 10_000);

	it("re-scans a root whose restored ref was released", async () => {
		using tempDir = TempDir.createSync("@omp-roster-released-");
		const dir = tempDir.path();
		const rootFile = path.join(dir, "main.jsonl");
		const childFile = path.join(dir, "main", "Worker.jsonl");
		await Bun.write(rootFile, `${sessionHeader("main")}\n`);
		await Bun.write(childFile, `${sessionHeader("worker")}\n${sessionInitRecord()}\n`);
		const readdirs: string[] = [];
		spyOnReaddirs(readdirs);
		const registry = new AgentRegistry();
		await ensurePersistedRoster(registry, rootFile);
		expect(registry.get("Worker")?.sessionFile).toBe(childFile);
		expect(countReaddirs(readdirs, scanDir(rootFile))).toBe(1);
		// A release removes the ref the latch restored; the next ensure sees the
		// missing ref and re-scans to restore it.
		expect(registry.unregister("Worker")).toBe(true);
		await ensurePersistedRoster(registry, rootFile);
		expect(registry.get("Worker")?.sessionFile).toBe(childFile);
		expect(countReaddirs(readdirs, scanDir(rootFile))).toBe(2);
	}, 10_000);

	it("keeps a settled latch valid for a tombstoned transcript", async () => {
		using tempDir = TempDir.createSync("@omp-roster-tombstone-");
		const dir = tempDir.path();
		const rootFile = path.join(dir, "main.jsonl");
		const childFile = path.join(dir, "main", "Worker.jsonl");
		await Bun.write(rootFile, `${sessionHeader("main")}\n`);
		await Bun.write(childFile, `${sessionHeader("worker")}\n${sessionInitRecord()}\n`);
		await Bun.write(`${childFile}.tombstone`, "");
		const readdirs: string[] = [];
		spyOnReaddirs(readdirs);
		const registry = new AgentRegistry();
		await ensurePersistedRoster(registry, rootFile);
		expect(registry.get("Worker")?.status).toBe("aborted");
		expect(registry.get("Worker")?.sessionFile).toBe(childFile);
		// The restored aborted ref still matches the latch token: no re-scan.
		await ensurePersistedRoster(registry, rootFile);
		expect(countReaddirs(readdirs, scanDir(rootFile))).toBe(1);
	}, 10_000);

	it("does not re-scan when a transcript file vanishes after its latch settled", async () => {
		using tempDir = TempDir.createSync("@omp-roster-vanished-");
		const dir = tempDir.path();
		const rootFile = path.join(dir, "main.jsonl");
		const childFile = path.join(dir, "main", "Worker.jsonl");
		await Bun.write(rootFile, `${sessionHeader("main")}\n`);
		await Bun.write(childFile, `${sessionHeader("worker")}\n${sessionInitRecord()}\n`);
		const readdirs: string[] = [];
		spyOnReaddirs(readdirs);
		const registry = new AgentRegistry();
		await ensurePersistedRoster(registry, rootFile);
		expect(registry.get("Worker")?.sessionFile).toBe(childFile);
		expect(countReaddirs(readdirs, scanDir(rootFile))).toBe(1);
		await fs.promises.rm(childFile);
		// The ref's id+file identity is intact even though the transcript is
		// gone; the settled latch stays valid and no re-scan runs.
		await ensurePersistedRoster(registry, rootFile);
		expect(registry.get("Worker")?.sessionFile).toBe(childFile);
		expect(countReaddirs(readdirs, scanDir(rootFile))).toBe(1);
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
		const realStat = fsp.stat;
		vi.spyOn(fs.promises, "stat").mockImplementation((async (target: fs.PathLike) => {
			if (target === childA && failChildA) {
				throw Object.assign(new Error(`EACCES: ${childA}`), { code: "EACCES" });
			}
			return realStat(target);
		}) as typeof fs.promises.stat);
		const readdirs: string[] = [];
		spyOnReaddirs(readdirs);
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
		expect(countReaddirs(readdirs, scanDir(rootA))).toBe(2);
		failChildA = false;
		await ensurePersistedRoster(registry, rootA);
		expect(registry.get("Worker")?.sessionFile).toBe(childA);
		expect(countReaddirs(readdirs, scanDir(rootA))).toBe(3);
	}, 10_000);
});
