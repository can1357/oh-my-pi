/**
 * gc of user-undo branch tails: SessionManager.pruneUserUndoTails.
 *
 * Topology under test (built directly on the journal):
 *
 *   u1 a1 u2 a2          <- undo #1 drops (u2,a2)   [marker m1, anchor a1]
 *   u3 a3                <- undo #2 drops (u3,a3)   [marker m2, anchor m1]
 *   u4 a4                <- active tail
 *
 * prune(keep=1) must remove ONLY the m1 tail, scrub m1's details (the
 * dropped-prompts list is the last surviving copy of retracted content),
 * keep the m2 tail redoable, and never touch the active path.
 */
import { describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";

const realReadFileSync = fs.readFileSync;

import * as os from "node:os";
import * as path from "node:path";
import type { Message } from "@oh-my-pi/pi-ai";
import { exportFromFile } from "@oh-my-pi/pi-coding-agent/export/html/index";
import {
	isProcessInstanceAlive,
	ownerClaimIsLive,
	parsePsLstart,
	processStartToken,
	readOwnerClaims,
	readSessionOwnerPids,
	SessionManager,
} from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { FileSessionStorage, type WriteTextAtomicOptions } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { tryAcquireFileLock } from "@oh-my-pi/pi-utils";

const SECRET_TAIL_1 = "MARKER-TAIL-ONE-5";
const SECRET_TAIL_2 = "MARKER-TAIL-TWO-8";

function userMessage(text: string): Message {
	return { role: "user", content: [{ type: "text", text }], timestamp: Date.now() };
}

function assistantMessage(text: string): Message {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic",
		provider: "anthropic",
		model: "test-model",
		stopReason: "stop",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 },
		},
		timestamp: Date.now(),
	};
}

interface Topology {
	manager: SessionManager;
	m1: string;
	m2: string;
	tailOneIds: string[];
	tailTwoIds: string[];
	activeIds: string[];
}

function buildTopology(): Topology {
	const manager = SessionManager.inMemory();
	manager.appendMessage(userMessage("u1"));
	const a1 = manager.appendMessage(assistantMessage("a1"));
	const u2 = manager.appendMessage(userMessage(SECRET_TAIL_1));
	const a2 = manager.appendMessage(assistantMessage("a2-response"));

	// undo #1: branch before u2; anchor is a1.
	const m1 = manager.branchWithSummary(a1, "", {
		kind: "user-undo",
		undoOf: a2,
		steps: 1,
		droppedPrompts: `- ${SECRET_TAIL_1}`,
	});

	const u3 = manager.appendMessage(userMessage(SECRET_TAIL_2));
	const a3 = manager.appendMessage(assistantMessage("a3-response"));

	// undo #2: branch before u3; anchor is m1 itself (last entry before u3).
	const m2 = manager.branchWithSummary(m1, "", {
		kind: "user-undo",
		undoOf: a3,
		steps: 1,
		droppedPrompts: `- ${SECRET_TAIL_2}`,
	});

	manager.appendMessage(userMessage("u4"));
	manager.appendMessage(assistantMessage("a4"));
	const activeIds = manager.getBranch().map(entry => entry.id);
	return { manager, m1, m2, tailOneIds: [u2, a2], tailTwoIds: [u3, a3], activeIds };
}

describe("SessionManager.pruneUserUndoTails", () => {
	it("keep=1 prunes only the older tail and scrubs its marker", async () => {
		const { manager, m1, m2, tailOneIds, tailTwoIds } = buildTopology();

		const result = await manager.pruneUserUndoTails(1, true);

		expect(result.markers).toBe(1);
		expect(result.removed).toBeGreaterThanOrEqual(2);
		for (const id of tailOneIds) expect(manager.hasEntry(id)).toBe(false);
		for (const id of tailTwoIds) expect(manager.hasEntry(id)).toBe(true);

		const entries = manager.getEntries();
		const prunedMarker = entries.find(entry => entry.id === m1) as { details?: Record<string, unknown> };
		expect(prunedMarker.details?.droppedPrompts).toBeUndefined();
		expect(prunedMarker.details?.undoOf).toBeUndefined();
		expect(typeof prunedMarker.details?.prunedAt).toBe("string");

		const keptMarker = entries.find(entry => entry.id === m2) as { details?: Record<string, unknown> };
		expect(keptMarker.details?.droppedPrompts).toBe(`- ${SECRET_TAIL_2}`);
		expect(manager.hasEntry(keptMarker.details?.undoOf as string)).toBe(true);
	});

	it("never touches the active path", async () => {
		const { manager, activeIds } = buildTopology();
		const before = manager.getBranch().map(entry => entry.id);

		await manager.pruneUserUndoTails(1, true);

		const after = manager.getBranch().map(entry => entry.id);
		expect(after).toEqual(before);
		for (const id of activeIds) expect(manager.hasEntry(id)).toBe(true);
	});

	it("dry run computes the same counts without mutating", async () => {
		const { manager, tailOneIds } = buildTopology();
		const entriesBefore = manager.getEntries().length;

		const result = await manager.pruneUserUndoTails(1, false);

		expect(result.markers).toBe(1);
		expect(manager.getEntries().length).toBe(entriesBefore);
		for (const id of tailOneIds) expect(manager.hasEntry(id)).toBe(true);
	});

	it("keep=0 prunes both tails; newest undo becomes unredoable", async () => {
		const { manager, m2, tailOneIds, tailTwoIds } = buildTopology();

		const result = await manager.pruneUserUndoTails(0, true);

		expect(result.markers).toBe(2);
		for (const id of [...tailOneIds, ...tailTwoIds]) expect(manager.hasEntry(id)).toBe(false);
		const marker = manager.getEntries().find(entry => entry.id === m2) as { details?: Record<string, unknown> };
		expect(manager.hasEntry(marker.details?.undoOf as string)).toBe(false);
		expect(marker.details?.undoOf).toBeUndefined();
	});

	it("fewer markers than keep is a no-op", async () => {
		const manager = SessionManager.inMemory();
		manager.appendMessage(userMessage("only"));
		manager.branchWithSummary((manager.getBranch().at(-1) as { id: string }).id, "", {
			kind: "user-undo",
			undoOf: null,
		});

		const result = await manager.pruneUserUndoTails(1, true);

		expect(result).toEqual({ markers: 0, removed: 0 });
	});

	it("a newer undo nested inside an older tail survives pruning of the older marker", async () => {
		// undo, redo back into the tail, undo again, then move the active
		// leaf elsewhere: m2 (newest) lives inside m1's tail and must stay
		// fully redoable while m1's tail is pruned.
		const manager = SessionManager.inMemory();
		manager.appendMessage(userMessage("u1"));
		const a1 = manager.appendMessage(assistantMessage("a1"));
		manager.appendMessage(userMessage(SECRET_TAIL_1));
		const a2 = manager.appendMessage(assistantMessage("a2-response"));
		const m1 = manager.branchWithSummary(a1, "", { kind: "user-undo", undoOf: a2, steps: 1, droppedPrompts: "" });
		// redo: branch back to the a2 tip (marker m2 = user-redo, not pruned
		// material), then continue inside the restored tail.
		const redo = manager.branchWithSummary(a2, "", { kind: "user-redo", redoOf: m1 });
		const u5 = manager.appendMessage(userMessage("late-in-tail"));
		const a5 = manager.appendMessage(assistantMessage("a5-response"));
		// undo again from inside the tail: m2's tail includes u5/a5 and the
		// redo marker entry itself.
		const m2 = manager.branchWithSummary(redo, "", { kind: "user-undo", undoOf: a5, steps: 1, droppedPrompts: "" });
		// tree-switch away: active path continues from a1, markers go off-branch.
		manager.branchWithSummary(a1, "", { kind: "manual", note: "switched away" });
		manager.appendMessage(userMessage("fresh"));
		manager.appendMessage(assistantMessage("fresh-reply"));

		const result = await manager.pruneUserUndoTails(1, true);

		// Only m1 is older than the newest marker. m2's ancestor spine runs
		// through m1's tail, so the older prune degrades to a scrub: the tail
		// survives instead of orphaning the retained marker.
		expect(result.markers).toBe(1);
		expect(result.removed).toBe(0);
		for (const kept of [redo, u5, a5, m2, a2]) expect(manager.hasEntry(kept)).toBe(true);
		// m2 stays redoable: its undoOf target survived.
		const m2Entry = manager.getEntries().find(entry => entry.id === m2) as
			| { details?: { undoOf?: string } }
			| undefined;
		expect(manager.hasEntry(m2Entry?.details?.undoOf ?? "")).toBe(true);
		// The second undo's own tail must NOT survive as garbage either when
		// it is the pruned one: run again with keep=0 semantics covered by the
		// scrub rule instead; here just confirm idempotence.
		const again = await manager.pruneUserUndoTails(1, true);
		expect(again.markers).toBe(0);
	});

	it("a second run after apply is a no-op (pruned markers are excluded)", async () => {
		const { manager } = await buildTopology();
		const first = await manager.pruneUserUndoTails(1, true);
		expect(first.markers).toBeGreaterThanOrEqual(1);

		const second = await manager.pruneUserUndoTails(1, true);
		expect(second.markers).toBe(0);
		expect(second.removed).toBe(0);

		// The scrubbed marker keeps its kind but no longer claims an undoOf.
		const scrubbed = manager
			.getEntries()
			.find(
				entry =>
					entry.type === "branch_summary" &&
					(entry as { details?: { kind?: string } }).details?.kind === "user-undo",
			);
		expect(scrubbed).toBeDefined();
		expect((scrubbed as { details?: { undoOf?: string | null; prunedAt?: string } }).details?.undoOf).toBeFalsy();
		expect((scrubbed as { details?: { prunedAt?: string } }).details?.prunedAt).toBeTruthy();
	});
	it("close() releases the journal lock before the owner sidecar claim", async () => {
		// Pre-fix ordering: close() unregistered the owner sidecar and awaited
		// the sidecar tail BEFORE scheduling #closeWriterHandle on the disk
		// chain. With the disk chain busy, a concurrent `omp gc
		// --undo-tails --apply` in that window saw the session as unowned,
		// opened it, and failed its prune against the still-held journal
		// lock. The claim must not disappear until the lock is free.
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-close-order-"));
		const gate = Promise.withResolvers<void>();
		let parked = false;
		class GatedStorage extends FileSessionStorage {
			override async writeTextAtomic(
				fpath: string,
				content: string,
				options?: WriteTextAtomicOptions,
			): Promise<void> {
				if (parked && fpath.endsWith(".jsonl")) await gate.promise;
				return super.writeTextAtomic(fpath, content, options);
			}
		}
		try {
			const sessionFile = path.join(tempDir, "close-order.jsonl");
			const manager = SessionManager.create(tempDir, tempDir, new GatedStorage());
			await manager.setSessionFile(sessionFile);
			manager.appendMessage(userMessage("u1"));

			// Occupy the disk chain with a parked rewrite, then start close().
			parked = true;
			const rewrite = manager.rewriteEntries();
			{
				const { promise, resolve } = Promise.withResolvers<void>();
				setTimeout(resolve, 25);
				await promise;
			}
			const closing = manager.close();

			// If the claim vanishes while the parked rewrite still holds the
			// journal lock, the lock must ALREADY be free — pre-fix it is not.
			let sawClaimDrop = false;
			for (let i = 0; i < 60; i++) {
				const { promise, resolve } = Promise.withResolvers<void>();
				setTimeout(resolve, 5);
				await promise;
				const pids = await readSessionOwnerPids(sessionFile);
				if (!pids.includes(process.pid)) {
					sawClaimDrop = true;
					const lock = tryAcquireFileLock(sessionFile);
					expect(lock?.acquired).toBe(true);
					lock?.release();
					break;
				}
			}
			// Post-fix the claim CANNOT drop while the disk chain is parked
			// (close() awaits the writer close before unregistering), so
			// seeing it drop here is itself the bug being guarded against.
			gate.resolve();
			await rewrite.catch(() => undefined);
			await closing;

			const finalPids = await readSessionOwnerPids(sessionFile);
			expect(finalPids.includes(process.pid)).toBe(false);
			const finalLock = tryAcquireFileLock(sessionFile);
			expect(finalLock?.acquired).toBe(true);
			finalLock?.release();
			// Post-fix the claim cannot drop while the disk chain is parked.
			expect(sawClaimDrop).toBe(false);
		} finally {
			// A failed expect above throws before the gate opens; resolve it
			// here so the parked rewrite/close fail fast instead of hanging on
			// the suite timeout.
			gate.resolve();
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});
	it("close() releases the writer lock and owner claim after a latched disk failure", async () => {
		// Pre-fix: with #diskFailure latched by an earlier failed rewrite,
		// #scheduleDiskWork rejected before running the close callback, so
		// close() exited without closing the writer (journal lock held) or
		// unregistering the owner sidecar — the session stayed pinned as a
		// live owner for undo-tail gc until process exit.
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-close-failure-"));
		const sessionFile = path.join(tempDir, "close-failure.jsonl");
		let failWrites = false;
		class FailingStorage extends FileSessionStorage {
			override async writeTextAtomic(
				fpath: string,
				content: string,
				options?: WriteTextAtomicOptions,
			): Promise<void> {
				if (failWrites && fpath.endsWith(".jsonl")) throw new Error("synthetic disk failure");
				return super.writeTextAtomic(fpath, content, options);
			}
		}
		try {
			const manager = SessionManager.create(tempDir, tempDir, new FailingStorage());
			await manager.setSessionFile(sessionFile);
			manager.appendMessage(userMessage("u1"));

			failWrites = true;
			await manager.rewriteEntries().catch(() => undefined);
			failWrites = false;

			let closeThrew = false;
			try {
				await manager.close();
			} catch {
				closeThrew = true;
			}
			// The latched persistence error still surfaces...
			expect(closeThrew).toBe(true);
			// ...but the resources are released: no owner claim, journal lock free.
			const pids = await readSessionOwnerPids(sessionFile);
			expect(pids.includes(process.pid)).toBe(false);
			const lock = tryAcquireFileLock(sessionFile);
			expect(lock?.acquired).toBe(true);
			lock?.release();
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});
	it("read-only consumers (export/share) claim no owner sidecar", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-readonly-open-"));
		try {
			const sessionFile = path.join(tempDir, "readonly.jsonl");
			const writer = SessionManager.create(tempDir, tempDir);
			await writer.setSessionFile(sessionFile);
			writer.appendMessage(userMessage("u1"));
			await writer.close();

			// exportFromFile is a pure read-only consumer: opening the session
			// must not append an .owner sidecar claim (read-only dirs would
			// throw SessionFileLockError, and a retained live-pid claim makes
			// undo-tail gc skip the session in long-lived callers).
			await exportFromFile(sessionFile, { outputPath: path.join(tempDir, "out.html") });
			const pids = await readSessionOwnerPids(sessionFile);
			expect(pids.includes(process.pid)).toBe(false);
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});
	it("prune-marker liveness binds pid to the process start identity", () => {
		// A recycled pid is alive but is NOT the pruner that recorded the
		// marker: stale-detection must treat it as dead so a crashed gc's
		// leftover marker cannot block opens until the timeout.
		const token = processStartToken(process.pid);
		expect(token).toBeDefined();
		expect(isProcessInstanceAlive(process.pid, token)).toBe(true);
		expect(isProcessInstanceAlive(process.pid, "0")).toBe(false);
		// Legacy markers (and non-Linux hosts) carry no token: pid-only
		// liveness, matching the previous behavior.
		expect(isProcessInstanceAlive(process.pid, undefined)).toBe(true);
		const dead = Bun.spawnSync(["/usr/bin/env", "true"]);
		expect(dead.pid).toBeGreaterThan(0);
		expect(isProcessInstanceAlive(dead.pid, token)).toBe(false);
	});

	it("start identity falls back to ps lstart when /proc is unavailable", () => {
		// Non-Linux POSIX hosts have no /proc/<pid>/stat; the token must
		// still bind claims to the process launch (ps-reported start time)
		// instead of degrading to pid-only liveness, where a recycled pid
		// blocks undo-tail gc indefinitely.
		const readSpy = vi.spyOn(fs, "readFileSync").mockImplementation(((p: fs.PathOrFileDescriptor, ...rest: []) => {
			if (typeof p === "string" && p.startsWith("/proc/")) throw new Error("ENOENT: no procfs");
			return realReadFileSync(p, ...rest);
		}) as typeof fs.readFileSync);
		const token = processStartToken(process.pid);
		expect(token).toBeDefined();
		expect(token).toMatch(/\d{4}/); // ps lstart carries the year
		expect(isProcessInstanceAlive(process.pid, token)).toBe(true);
		expect(isProcessInstanceAlive(process.pid, "Wed Apr  1 00:00:00 1970")).toBe(false);
		// Provider mismatch (ps claim vs /proc ticks or vice versa) fails
		// closed: the encodings are incomparable, never "different launch".
		expect(isProcessInstanceAlive(process.pid, "12345")).toBe(true);
		readSpy.mockRestore();
		// parsePsLstart normalizes ps whitespace padding into a stable token.
		expect(parsePsLstart("  Tue Aug  25 08:00:00 2026\n")).toBe("Tue Aug 25 08:00:00 2026");
		expect(parsePsLstart("   \n")).toBeUndefined();
	});

	it("title-entry fallback failure diverges the journal so the next append rewrites fully", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-title-contention-"));
		// Failable storage: after the journal is durable, the title
		// side-write and the fenced full-rewrite fallback both fail — the
		// same catch path lock contention takes (SessionFileLockError from
		// the publish claim).
		let failing = false;
		class FailingTitleStorage extends FileSessionStorage {
			override async updateSessionTitle(fpath: string, update: never): Promise<void> {
				if (failing) throw new Error("title side-write contention");
				await super.updateSessionTitle(fpath, update);
			}
			override async writeTextAtomic(fpath: string, content: string): Promise<void> {
				if (failing) throw new Error("publish contention");
				await super.writeTextAtomic(fpath, content);
			}
		}
		try {
			const manager = SessionManager.create(dir, dir, new FailingTitleStorage());
			await manager.setSessionFile(path.join(dir, "title-contention.jsonl"));
			manager.appendMessage(userMessage("u1"));
			manager.appendMessage(assistantMessage("a1"));
			await manager.ensureOnDisk();
			const sessionFile = path.join(dir, "title-contention.jsonl");

			failing = true;
			let titleError: unknown;
			try {
				await manager.setSessionName("contended-title");
			} catch (error) {
				titleError = error;
			}
			expect(titleError).toBeInstanceOf(Error);
			failing = false;

			// The title entry IS in memory; the durable journal lacks it.
			// The next append must notice the divergence and rewrite the
			// whole file instead of appending one line whose parentId
			// references the missing title entry.
			manager.appendMessage(userMessage("u2"));
			manager.appendMessage(assistantMessage("a2"));
			const lines = fs
				.readFileSync(sessionFile, "utf-8")
				.split("\n")
				.filter(line => line.trim().length > 0);
			const entries = lines.map(
				line => JSON.parse(line) as { id?: string; parentId?: string | null; type?: string; title?: string },
			);
			expect(entries.some(entry => entry.type === "title_change" && entry.title === "contended-title")).toBe(true);
			const ids = new Set(entries.map(entry => entry.id).filter(Boolean));
			for (const entry of entries) {
				if (entry.parentId != null) expect(ids.has(entry.parentId)).toBe(true);
			}
			await manager.close();
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("owner claims bind to the process start identity", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-owner-token-"));
		try {
			const sidecar = path.join(dir, "claims.jsonl.owner");
			const token = processStartToken(process.pid);
			expect(token).toBeDefined();
			// A recycled pid: live process, wrong launch.
			fs.writeFileSync(sidecar, `${process.pid} 0\n`, { mode: 0o600 });
			const recycled = await readOwnerClaims(path.join(dir, "claims.jsonl"));
			const recycledEntry = recycled.get(process.pid);
			expect(recycledEntry?.count).toBe(1);
			expect(ownerClaimIsLive(recycledEntry!)).toBe(false);
			// The actual launch: alive.
			fs.writeFileSync(sidecar, `${process.pid} ${token}\n`, { mode: 0o600 });
			const live = await readOwnerClaims(path.join(dir, "claims.jsonl"));
			expect(ownerClaimIsLive(live.get(process.pid)!)).toBe(true);
			// Legacy pid-only rows stay conservative.
			fs.writeFileSync(sidecar, `${process.pid}\n`, { mode: 0o600 });
			const legacy = await readOwnerClaims(path.join(dir, "claims.jsonl"));
			const legacyEntry = legacy.get(process.pid);
			expect(legacyEntry?.legacyCount).toBe(1);
			expect(ownerClaimIsLive(legacyEntry!)).toBe(true);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
	it("resuming a session whose claim release is still queued re-registers it", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-claim-reregister-"));
		try {
			const fileA = path.join(dir, "a.jsonl");
			const fileB = path.join(dir, "b.jsonl");
			const manager = SessionManager.create(dir, dir);
			await manager.setSessionFile(fileA);
			manager.appendMessage(userMessage("u1"));
			manager.appendMessage(assistantMessage("a1"));

			// Switch away (queues A's claim removal on the sidecar tail,
			// unawaited) and immediately resume A — the guard in
			// #registerOwnerSidecar must not mistake the queued-away claim
			// for durable ownership.
			await manager.setSessionFile(fileB);
			await manager.setSessionFile(fileA);
			await Bun.sleep(50);

			// A must still carry this manager's claim once the tail drains.
			const claims = await readOwnerClaims(fileA);
			const own = claims.get(process.pid);
			expect(own?.count).toBeGreaterThanOrEqual(1);
			await manager.close();
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
