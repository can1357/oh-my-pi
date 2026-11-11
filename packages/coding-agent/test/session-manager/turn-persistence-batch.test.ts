import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import {
	IndexedSessionStorage,
	type SessionStorageBackend,
	type SessionStorageIndexEntry,
} from "@oh-my-pi/pi-coding-agent/session/indexed-session-storage";
import {
	SessionManager,
	SessionPersistenceIndeterminateError,
} from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { SessionWriteConflictError } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { becomesCollectible } from "../../../tui/test/gc";
import { makeAssistantMessage } from "./helpers";

interface HeldIndexedStorageHarness {
	files: Map<string, string>;
	storage: IndexedSessionStorage;
	holdAppends(): () => void;
	failNextAppend(error?: Error): void;
	holdRewrites(options?: { ackError?: Error; afterLand?: boolean }): { entered: Promise<void>; release(): void };
	holdAtomicReturn(): { entered: Promise<void>; release(): void };
	holdReadText(): { entered: Promise<void>; release(): void };
	getWriteFullCalls(): number;
	resetWriteFullCalls(): void;
}

async function createHeldIndexedStorage(): Promise<HeldIndexedStorageHarness> {
	const files = new Map<string, string>();
	const mtimes = new Map<string, number>();
	let mtime = 1;
	let writeFullCalls = 0;
	let holdGate: PromiseWithResolvers<void> | undefined;
	let nextAppendError: Error | undefined;
	let rewriteHold:
		| {
				entered: PromiseWithResolvers<void>;
				gate: PromiseWithResolvers<void>;
				ackError?: Error;
				afterLand?: boolean;
		  }
		| undefined;
	let atomicReturnHold: { entered: PromiseWithResolvers<void>; gate: PromiseWithResolvers<void> } | undefined;
	let readTextHold: { entered: PromiseWithResolvers<void>; gate: PromiseWithResolvers<void> } | undefined;

	const backend: SessionStorageBackend = {
		async init(): Promise<void> {},
		async loadIndex(): Promise<SessionStorageIndexEntry[]> {
			return Array.from(files.entries(), ([filePath, content]) => ({
				path: filePath,
				size: Buffer.byteLength(content, "utf8"),
				mtimeMs: mtimes.get(filePath) ?? 0,
			}));
		},
		async readFull(filePath: string): Promise<string | null> {
			return files.get(filePath) ?? null;
		},
		async readSlices(filePath: string, prefixBytes: number, suffixBytes: number): Promise<[string, string]> {
			const bytes = Buffer.from(files.get(filePath) ?? "", "utf8");
			return [
				bytes.subarray(0, prefixBytes).toString("utf8"),
				suffixBytes > 0 ? bytes.subarray(Math.max(0, bytes.length - suffixBytes)).toString("utf8") : "",
			];
		},
		async append(filePath: string, line: string): Promise<void> {
			if (holdGate) {
				await holdGate.promise;
			}
			if (nextAppendError) {
				const error = nextAppendError;
				nextAppendError = undefined;
				throw error;
			}
			files.set(filePath, (files.get(filePath) ?? "") + line);
			mtimes.set(filePath, mtime++);
		},
		async writeFull(
			filePath: string,
			content: string,
			mtimeMs: number,
			_title?: unknown,
			expectedSize?: number | null,
		): Promise<void> {
			writeFullCalls++;
			let ackError: Error | undefined;
			const activeHold = rewriteHold;
			if (activeHold && !activeHold.afterLand) {
				activeHold.entered.resolve();
				await activeHold.gate.promise;
				ackError = activeHold.ackError;
				activeHold.ackError = undefined;
			}
			const current = files.get(filePath) ?? null;
			const actualSize = current === null ? null : Buffer.byteLength(current, "utf8");
			if (expectedSize !== undefined && actualSize !== expectedSize) {
				throw new SessionWriteConflictError(filePath, expectedSize, actualSize);
			}
			files.set(filePath, content);
			mtimes.set(filePath, mtimeMs);
			if (activeHold?.afterLand) {
				activeHold.entered.resolve();
				await activeHold.gate.promise;
				ackError = activeHold.ackError;
				activeHold.ackError = undefined;
			}
			if (ackError) throw ackError;
		},
		async updateSessionTitle(filePath: string, _title: unknown, mtimeMs: number): Promise<void> {
			mtimes.set(filePath, mtimeMs);
		},
		async truncate(filePath: string, mtimeMs: number): Promise<void> {
			files.set(filePath, "");
			mtimes.set(filePath, mtimeMs);
		},
		async remove(paths: string[]): Promise<void> {
			for (const filePath of paths) {
				files.delete(filePath);
				mtimes.delete(filePath);
			}
		},
		async move(src: string, dst: string, mtimeMs: number): Promise<void> {
			const content = files.get(src);
			if (content === undefined) throw new Error(`ENOENT: ${src}`);
			files.delete(src);
			files.set(dst, content);
			mtimes.set(dst, mtimeMs);
		},
	};

	const storage = new IndexedSessionStorage(backend);
	await storage.initialize();
	const origWriteTextAtomic = storage.writeTextAtomic.bind(storage);
	storage.writeTextAtomic = async (filePath, content, options) => {
		await origWriteTextAtomic(filePath, content, options);
		if (atomicReturnHold) {
			const activeHold = atomicReturnHold;
			atomicReturnHold = undefined;
			activeHold.entered.resolve();
			await activeHold.gate.promise;
		}
	};
	const origReadText = storage.readText.bind(storage);
	storage.readText = async filePath => {
		const content = await origReadText(filePath);
		if (readTextHold) {
			const activeHold = readTextHold;
			readTextHold = undefined;
			activeHold.entered.resolve();
			await activeHold.gate.promise;
		}
		return content;
	};

	return {
		files,
		storage,
		holdAppends(): () => void {
			const gate = Promise.withResolvers<void>();
			holdGate = gate;
			return () => {
				if (holdGate === gate) holdGate = undefined;
				gate.resolve();
			};
		},
		failNextAppend(error = new Error("Simulated backend append failure")): void {
			nextAppendError = error;
		},
		holdRewrites(options?: { ackError?: Error; afterLand?: boolean }): { entered: Promise<void>; release(): void } {
			const entered = Promise.withResolvers<void>();
			const gate = Promise.withResolvers<void>();
			const state = { entered, gate, ackError: options?.ackError, afterLand: options?.afterLand };
			rewriteHold = state;
			return {
				entered: entered.promise,
				release(): void {
					if (rewriteHold === state) rewriteHold = undefined;
					gate.resolve();
				},
			};
		},
		holdAtomicReturn(): { entered: Promise<void>; release(): void } {
			const entered = Promise.withResolvers<void>();
			const gate = Promise.withResolvers<void>();
			const state = { entered, gate };
			atomicReturnHold = state;
			return {
				entered: entered.promise,
				release(): void {
					if (atomicReturnHold === state) atomicReturnHold = undefined;
					gate.resolve();
				},
			};
		},
		holdReadText(): { entered: Promise<void>; release(): void } {
			const entered = Promise.withResolvers<void>();
			const gate = Promise.withResolvers<void>();
			const state = { entered, gate };
			readTextHold = state;
			return {
				entered: entered.promise,
				release(): void {
					if (readTextHold === state) readTextHold = undefined;
					gate.resolve();
				},
			};
		},
		getWriteFullCalls(): number {
			return writeFullCalls;
		},
		resetWriteFullCalls(): void {
			writeFullCalls = 0;
		},
	};
}

describe("SessionManager turn persistence batching with IndexedSessionStorage", () => {
	it("preserves in-flight append confirmations across a rejected header rewrite so recovery succeeds", async () => {
		const { files, storage, holdAppends } = await createHeldIndexedStorage();
		const manager = SessionManager.create("/cwd", "/sessions/indexed", storage);

		const seedId = manager.appendMessage(makeAssistantMessage());
		await manager.flush();
		await storage.drain();
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("Expected session file");

		const sizeBeforeAppend = Buffer.byteLength(files.get(sessionFile) ?? "", "utf8");
		expect(manager.captureState().expectedDiskSize).toBe(sizeBeforeAppend);

		// 1. Start a batched hot append whose backend publish stays in flight while the
		//    local IndexedSessionStorage index advances synchronously.
		const releaseAppends = holdAppends();
		const [pendingId1, pendingId2] = manager.withAppendBatch(() => [
			manager.appendMessage({ role: "user", content: "in-flight-1", timestamp: 1001 }),
			manager.appendMessage({ role: "user", content: "in-flight-2", timestamp: 1002 }),
		]);

		// 2. Overlap a workspace header change (sets #rewriteRequired = true and schedules #rewriteAtomically).
		const workspaceChange = manager.addWorkspaceDirectory("/extra/workspace");

		// 3. Before the pending append or atomic rewrite settles, another append triggers
		//    #rewriteSynchronously(), which increments #diskEpoch and fails its queue-time
		//    size check against the optimistic index.
		const overlappingId = manager.appendMessage({ role: "user", content: "overlapping-turn", timestamp: 1003 });

		// 4. Let the held appends finish confirming on the backend.
		releaseAppends();
		await workspaceChange.catch(() => {});
		await manager.flush().catch(() => {});
		await storage.drain().catch(() => {});

		const sizeAfterConfirmedAppends = Buffer.byteLength(files.get(sessionFile) ?? "", "utf8");
		// Regression failure mode: bumping #diskEpoch before the rejected #rewriteSynchronously()
		// discarded the pending append confirmations, stranding expectedDiskSize at sizeBeforeAppend.
		expect(sizeAfterConfirmedAppends).toBeGreaterThan(sizeBeforeAppend);
		expect(manager.captureState().expectedDiskSize).toBe(sizeAfterConfirmedAppends);

		// 5. Subsequent append triggers recovery rewrite with matching expectedSize and persists all turns.
		const recoveryId = manager.appendMessage({ role: "user", content: "recovery-turn", timestamp: 1004 });
		await manager.flush();
		await storage.drain();
		await manager.close();

		const reopened = await SessionManager.open(sessionFile, "/sessions/indexed", storage);
		expect(reopened.getAdditionalDirectories()).toEqual([path.resolve("/extra/workspace")]);
		expect(reopened.getBranch().map(entry => entry.id)).toEqual([
			seedId,
			pendingId1,
			pendingId2,
			overlappingId,
			recoveryId,
		]);
		await reopened.close();
	});

	it("preserves pending batched and single append confirmations when restoreState restores the same journal before confirmation settles", async () => {
		const { files, storage, holdAppends } = await createHeldIndexedStorage();
		const manager = SessionManager.create("/cwd", "/sessions/indexed", storage);

		const seedId = manager.appendMessage(makeAssistantMessage());
		await manager.flush();
		await storage.drain();
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("Expected session file");

		const sizeBeforeAppend = Buffer.byteLength(files.get(sessionFile) ?? "", "utf8");
		const releaseAppends = holdAppends();

		const [batchId1, batchId2] = manager.withAppendBatch(() => [
			manager.appendMessage({ role: "user", content: "batch-1", timestamp: 2001 }),
			manager.appendMessage({ role: "user", content: "batch-2", timestamp: 2002 }),
		]);
		const singleId = manager.appendMessage({ role: "user", content: "single-3", timestamp: 2003 });

		// Snapshot includes the unconfirmed entries while expectedDiskSize is still pre-append.
		const snapshot = manager.captureState();
		expect(snapshot.expectedDiskSize).toBe(sizeBeforeAppend);

		// Restoring the unchanged journal before confirmations arrive must not invalidate
		// in-flight confirmations, or later header/recovery rewrites fail their size CAS permanently.
		manager.restoreState(snapshot);
		releaseAppends();
		await manager.flush();
		await storage.drain();

		const confirmedSize = Buffer.byteLength(files.get(sessionFile) ?? "", "utf8");
		expect(confirmedSize).toBeGreaterThan(sizeBeforeAppend);
		expect(manager.captureState().expectedDiskSize).toBe(confirmedSize);

		await manager.addWorkspaceDirectory("/extra/after-restore");
		const nextTurnId = manager.appendMessage({ role: "user", content: "post-restore-turn", timestamp: 2004 });
		await manager.flush();
		await storage.drain();
		await manager.close();

		const reopened = await SessionManager.open(sessionFile, "/sessions/indexed", storage);
		expect(reopened.getAdditionalDirectories()).toEqual([path.resolve("/extra/after-restore")]);
		expect(reopened.getBranch().map(entry => entry.id)).toEqual([seedId, batchId1, batchId2, singleId, nextTurnId]);
		await reopened.close();
	});

	it("preserves confirmed durable size when pending appends settle between captureState and restoreState on the same journal", async () => {
		const { files, storage, holdAppends } = await createHeldIndexedStorage();
		const manager = SessionManager.create("/cwd", "/sessions/indexed", storage);

		const seedId = manager.appendMessage(makeAssistantMessage());
		await manager.flush();
		await storage.drain();
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("Expected session file");

		const sizeBeforeAppend = Buffer.byteLength(files.get(sessionFile) ?? "", "utf8");
		const releaseAppends = holdAppends();

		const [batchId1, batchId2] = manager.withAppendBatch(() => [
			manager.appendMessage({ role: "user", content: "between-batch-1", timestamp: 3001 }),
			manager.appendMessage({ role: "user", content: "between-batch-2", timestamp: 3002 }),
		]);
		const singleId = manager.appendMessage({ role: "user", content: "between-single-3", timestamp: 3003 });

		const snapshot = manager.captureState();
		expect(snapshot.expectedDiskSize).toBe(sizeBeforeAppend);

		// Confirmations settle BEFORE restoreState runs; restoring the unchanged snapshot must not
		// roll expectedDiskSize back to snapshot.expectedDiskSize behind the confirmed backend bytes.
		releaseAppends();
		await manager.flush();
		await storage.drain();
		const confirmedSize = Buffer.byteLength(files.get(sessionFile) ?? "", "utf8");
		expect(confirmedSize).toBeGreaterThan(sizeBeforeAppend);

		manager.restoreState(snapshot);
		expect(manager.captureState().expectedDiskSize).toBe(confirmedSize);

		await manager.addWorkspaceDirectory("/extra/settled-between");
		const nextTurnId = manager.appendMessage({
			role: "user",
			content: "turn-after-settled-restore",
			timestamp: 3004,
		});
		await manager.flush();
		await storage.drain();
		await manager.close();

		const reopened = await SessionManager.open(sessionFile, "/sessions/indexed", storage);
		expect(reopened.getAdditionalDirectories()).toEqual([path.resolve("/extra/settled-between")]);
		expect(reopened.getBranch().map(entry => entry.id)).toEqual([seedId, batchId1, batchId2, singleId, nextTurnId]);
		await reopened.close();
	});

	it("reconciles durable size and rewrites cleanly when restoreState rolls back entries appended after captureState", async () => {
		const { storage, holdAppends } = await createHeldIndexedStorage();
		const manager = SessionManager.create("/cwd", "/sessions/indexed", storage);

		const seedId = manager.appendMessage(makeAssistantMessage());
		await manager.flush();
		await storage.drain();
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("Expected session file");

		const snapshot = manager.captureState();
		const releaseAppends = holdAppends();

		// Queue an append after captureState(), then roll in-memory state back before it confirms.
		manager.appendMessage({ role: "user", content: "rolled-back-turn", timestamp: 4001 });
		manager.restoreState(snapshot);

		releaseAppends();
		await manager.addWorkspaceDirectory("/extra/rolled-back");
		const survivingId = manager.appendMessage({ role: "user", content: "surviving-turn", timestamp: 4002 });
		await manager.flush();
		await storage.drain();
		await manager.close();

		const reopened = await SessionManager.open(sessionFile, "/sessions/indexed", storage);
		expect(reopened.getAdditionalDirectories()).toEqual([path.resolve("/extra/rolled-back")]);
		expect(reopened.getBranch().map(entry => entry.id)).toEqual([seedId, survivingId]);
		await reopened.close();
	});

	it("advances post-rewrite durable size when setSessionName is queued behind rewriteEntries", async () => {
		const { files, storage, holdRewrites } = await createHeldIndexedStorage();
		const manager = SessionManager.create("/cwd", "/sessions/indexed", storage);

		const seedId = manager.appendMessage(makeAssistantMessage());
		await manager.flush();
		await storage.drain();
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("Expected session file");

		const rewriteGate = holdRewrites();
		const rewritePromise = manager.rewriteEntries();
		await rewriteGate.entered;

		// Queue setSessionName while rewriteEntries has already serialized the pre-rename body
		// and is awaiting backend writeFull: the rewrite will supersede the pre-rewrite durability
		// cell before the title append executes on #diskTail.
		const renamePromise = manager.setSessionName("Renamed Title", "user");
		rewriteGate.release();
		await Promise.all([rewritePromise, renamePromise]);
		await storage.drain();

		const sizeAfterRename = Buffer.byteLength(files.get(sessionFile) ?? "", "utf8");
		expect(manager.captureState().expectedDiskSize).toBe(sizeAfterRename);

		await manager.addWorkspaceDirectory("/extra/after-queued-rename");
		const postRenameTurnId = manager.appendMessage({
			role: "user",
			content: "turn-after-queued-rename",
			timestamp: 5001,
		});
		await manager.flush();
		await storage.drain();
		await manager.close();

		const reopened = await SessionManager.open(sessionFile, "/sessions/indexed", storage);
		expect(reopened.getSessionName()).toBe("Renamed Title");
		expect(reopened.getAdditionalDirectories()).toEqual([path.resolve("/extra/after-queued-rename")]);
		const branch = reopened.getBranch();
		expect(branch.map(entry => entry.type)).toEqual(["message", "title_change", "message"]);
		expect([branch[0]?.id, branch[2]?.id]).toEqual([seedId, postRenameTurnId]);
		await reopened.close();
	});

	it("keeps the hot append path active across a no-op same-journal restoreState while an append is unconfirmed", async () => {
		const { files, storage, holdAppends, getWriteFullCalls, resetWriteFullCalls } = await createHeldIndexedStorage();
		const manager = SessionManager.create("/cwd", "/sessions/indexed", storage);

		const seedId = manager.appendMessage(makeAssistantMessage());
		await manager.flush();
		await storage.drain();
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("Expected session file");
		resetWriteFullCalls();

		const releaseAppends = holdAppends();
		const firstTurnId = manager.appendMessage({
			role: "user",
			content: "unconfirmed-before-restore",
			timestamp: 6001,
		});

		const snapshot = manager.captureState();
		manager.restoreState(snapshot);

		// Appending immediately before firstTurnId confirms must stay on the open hot-path writer;
		// treating healthy #diskFailure (undefined) as diverged forced a cold rewrite against the
		// pre-append size token, failing the optimistic index CAS and dropping secondTurnId.
		const secondTurnId = manager.appendMessage({
			role: "user",
			content: "immediate-after-noop-restore",
			timestamp: 6002,
		});
		expect(getWriteFullCalls()).toBe(0);

		releaseAppends();
		await manager.flush();
		await storage.drain();
		expect(getWriteFullCalls()).toBe(0);
		expect(manager.captureState().expectedDiskSize).toBe(Buffer.byteLength(files.get(sessionFile) ?? "", "utf8"));
		await manager.close();

		const reopened = await SessionManager.open(sessionFile, "/sessions/indexed", storage);
		expect(reopened.getBranch().map(entry => entry.id)).toEqual([seedId, firstTurnId, secondTurnId]);
		await reopened.close();
	});

	it("retains a pending branched-session full publish across restoreState(A) -> restoreState(B) before confirmation", async () => {
		const { files, storage, holdRewrites, getWriteFullCalls, resetWriteFullCalls } = await createHeldIndexedStorage();
		const manager = SessionManager.create("/cwd", "/sessions/indexed", storage);

		const seedId = manager.appendMessage(makeAssistantMessage());
		await manager.flush();
		await storage.drain();
		const sessionFileA = manager.getSessionFile();
		if (!sessionFileA) throw new Error("Expected initial session file");
		const snapA = manager.captureState();
		resetWriteFullCalls();

		const rewriteGate = holdRewrites();
		const branchedFile = manager.createBranchedSession(seedId);
		if (!branchedFile) throw new Error("Expected branched session file");
		await rewriteGate.entered;

		const snapB = manager.captureState();
		expect(snapB.expectedDiskSize).toBeNull();
		expect(snapB.onDisk).toBe(false);

		manager.restoreState(snapA);
		manager.restoreState(snapB);

		rewriteGate.release();
		await manager.flush();
		await storage.drain();

		const branchedSize = Buffer.byteLength(files.get(branchedFile) ?? "", "utf8");
		const confirmedB = manager.captureState();
		expect(confirmedB.expectedDiskSize).toBe(branchedSize);
		expect(confirmedB.onDisk).toBe(true);
		expect(getWriteFullCalls()).toBe(1);

		const postRestoreTurnId = manager.appendMessage({
			role: "user",
			content: "turn-after-branched-restore-before-confirm",
			timestamp: 7001,
		});
		await manager.flush();
		await storage.drain();
		expect(getWriteFullCalls()).toBe(1);
		await manager.close();

		const reopened = await SessionManager.open(branchedFile, "/sessions/indexed", storage);
		expect(reopened.getBranch().map(entry => entry.id)).toEqual([seedId, postRestoreTurnId]);
		await reopened.close();
	});

	it("reconciles confirmed durable size when a pending branched-session full publish settles while another journal is restored", async () => {
		const { files, storage, holdRewrites, getWriteFullCalls, resetWriteFullCalls } = await createHeldIndexedStorage();
		const manager = SessionManager.create("/cwd", "/sessions/indexed", storage);

		const seedId = manager.appendMessage(makeAssistantMessage());
		await manager.flush();
		await storage.drain();
		const sessionFileA = manager.getSessionFile();
		if (!sessionFileA) throw new Error("Expected initial session file");
		const sizeA = Buffer.byteLength(files.get(sessionFileA) ?? "", "utf8");
		const snapA = manager.captureState();
		resetWriteFullCalls();

		const rewriteGate = holdRewrites();
		const branchedFile = manager.createBranchedSession(seedId);
		if (!branchedFile) throw new Error("Expected branched session file");
		await rewriteGate.entered;

		const snapB = manager.captureState();
		expect(snapB.expectedDiskSize).toBeNull();

		manager.restoreState(snapA);
		rewriteGate.release();
		await storage.drain();

		// Confirming B in the background must neither switch away from A nor alter A's durable size.
		expect(manager.getSessionFile()).toBe(sessionFileA);
		expect(manager.captureState().expectedDiskSize).toBe(sizeA);

		manager.restoreState(snapB);
		const branchedSize = Buffer.byteLength(files.get(branchedFile) ?? "", "utf8");
		const restoredB = manager.captureState();
		expect(restoredB.expectedDiskSize).toBe(branchedSize);
		expect(restoredB.onDisk).toBe(true);
		expect(getWriteFullCalls()).toBe(1);

		const postRestoreTurnId = manager.appendMessage({
			role: "user",
			content: "turn-after-branched-confirmed-in-background",
			timestamp: 7002,
		});
		await manager.flush();
		await storage.drain();
		expect(getWriteFullCalls()).toBe(1);
		await manager.close();

		const reopenedB = await SessionManager.open(branchedFile, "/sessions/indexed", storage);
		expect(reopenedB.getBranch().map(entry => entry.id)).toEqual([seedId, postRestoreTurnId]);
		await reopenedB.close();

		const reopenedA = await SessionManager.open(sessionFileA, "/sessions/indexed", storage);
		expect(reopenedA.getBranch().map(entry => entry.id)).toEqual([seedId]);
		await reopenedA.close();
	});

	function appendObservedLargeEntry(manager: SessionManager, tag: string): { entryId: string; ref: WeakRef<object> } {
		const id = manager.appendMessage({
			role: "user",
			content: `${tag}-${"x".repeat(64 * 1024)}`,
			timestamp: 8001,
		});
		const entry = manager.getEntry(id);
		if (!entry) throw new Error("Expected appended entry");
		return { entryId: id, ref: new WeakRef(entry) };
	}

	it("releases prior transcript entries after full rewrites followed by newSession()", async () => {
		const { storage } = await createHeldIndexedStorage();
		const manager = SessionManager.create("/cwd", "/sessions/indexed", storage);

		manager.appendMessage(makeAssistantMessage());
		await manager.flush();
		await storage.drain();
		const { ref: atomicRewriteEntryRef } = appendObservedLargeEntry(manager, "atomic-rewrite");
		await manager.flush();
		await storage.drain();
		await manager.rewriteEntries();
		await storage.drain();

		await manager.newSession();
		await storage.drain();
		expect(await becomesCollectible(atomicRewriteEntryRef)).toBe(true);

		const { entryId: branchLeafId, ref: deferredPublishEntryRef } = appendObservedLargeEntry(
			manager,
			"deferred-publish",
		);
		await manager.flush();
		await storage.drain();
		manager.createBranchedSession(branchLeafId);
		await storage.drain();

		await manager.newSession();
		await storage.drain();
		expect(await becomesCollectible(deferredPublishEntryRef)).toBe(true);

		await manager.close();
	});

	it("persists a message racing an unconfirmed initial branch publish across snapshot restore and background confirmation", async () => {
		const { files, storage, holdRewrites } = await createHeldIndexedStorage();
		const manager = SessionManager.create("/cwd", "/sessions/indexed", storage);

		const seedId = manager.appendMessage(makeAssistantMessage());
		await manager.flush();
		await storage.drain();
		const snapA = manager.captureState();

		const rewriteGate = holdRewrites();
		const branchedFile = manager.createBranchedSession(seedId);
		if (!branchedFile) throw new Error("Expected branched session file");
		await rewriteGate.entered;

		const racingId = manager.appendMessage({
			role: "user",
			content: "raced-unconfirmed-branch-publish",
			timestamp: 9001,
		});
		const snapB = manager.captureState();

		manager.restoreState(snapA);
		rewriteGate.release();
		await storage.drain();

		const seedOnlyBytes = Buffer.byteLength(files.get(branchedFile) ?? "", "utf8");
		expect(files.get(branchedFile)).not.toContain("raced-unconfirmed-branch-publish");

		manager.restoreState(snapB);
		const restoredB = manager.captureState();
		expect(restoredB.expectedDiskSize).toBe(seedOnlyBytes);
		expect(restoredB.onDisk).toBe(false);
		expect(restoredB.needsRewrite).toBe(true);

		await manager.flush();
		await storage.drain();
		expect(files.get(branchedFile)).toContain("raced-unconfirmed-branch-publish");

		const followUpId = manager.appendMessage({
			role: "user",
			content: "after-restored-raced-branch-flush",
			timestamp: 9002,
		});
		await manager.flush();
		await storage.drain();
		await manager.close();

		const reopened = await SessionManager.open(branchedFile, "/sessions/indexed", storage);
		expect(reopened.getBranch().map(entry => entry.id)).toEqual([seedId, racingId, followUpId]);
		await reopened.close();
	});

	it("marks canceled unawaited setSessionName writes divergent across restoreState round-trips", async () => {
		const { files, storage } = await createHeldIndexedStorage();
		const manager = SessionManager.create("/cwd", "/sessions/indexed", storage);

		const seedId = manager.appendMessage(makeAssistantMessage());
		await manager.flush();
		await storage.drain();
		const snapA = manager.captureState();

		const branchedFile = manager.createBranchedSession(seedId);
		if (!branchedFile) throw new Error("Expected branched session file");
		await manager.flush();
		await storage.drain();

		const renamePromise = manager.setSessionName("Queued Branch Title", "user");
		const snapB = manager.captureState();
		expect(snapB.onDisk).toBe(true);

		manager.restoreState(snapA);
		manager.restoreState(snapB);
		const restoredB = manager.captureState();
		expect(restoredB.onDisk).toBe(false);
		expect(restoredB.needsRewrite).toBe(true);

		await renamePromise;
		await manager.flush();
		await storage.drain();
		expect(files.get(branchedFile)).toContain("Queued Branch Title");

		const followUpId = manager.appendMessage({
			role: "user",
			content: "turn-after-canceled-rename-restore",
			timestamp: 9003,
		});
		await manager.flush();
		await storage.drain();
		await manager.close();

		const reopened = await SessionManager.open(branchedFile, "/sessions/indexed", storage);
		expect(reopened.getSessionName()).toBe("Queued Branch Title");
		const branch = reopened.getBranch();
		expect(branch.map(entry => entry.type)).toEqual(["message", "title_change", "message"]);
		expect([branch[0]?.id, branch[2]?.id]).toEqual([seedId, followUpId]);
		await reopened.close();
	});

	it("preserves newer durability cells and pending hot appends when a superseded header rewrite finishes stale readback", async () => {
		const { files, storage, holdAppends, holdAtomicReturn, holdReadText } = await createHeldIndexedStorage();
		const manager = SessionManager.create("/cwd", "/sessions/indexed", storage);

		const seedId = manager.appendMessage(makeAssistantMessage());
		await manager.flush();
		await storage.drain();
		const snapA = manager.captureState();

		const branchedFile = manager.createBranchedSession(seedId);
		if (!branchedFile) throw new Error("Expected branched session file");
		await manager.flush();
		await storage.drain();
		await manager.setTaskPromptCacheKey("cache-key-aaaa");
		await storage.drain();

		const atomicReturnGate = holdAtomicReturn();
		const headerRewrite = manager.setTaskPromptCacheKey("cache-key-bbbb");
		const snapB = manager.captureState();
		await atomicReturnGate.entered;

		// Bump diskEpoch without touching B's cell so #runFencedAtomicRewrite enters stale readText().
		manager.restoreState(snapA);
		const readGate = holdReadText();
		atomicReturnGate.release();
		await readGate.entered;

		// Restore B, supersede its cell via flushSync(), and issue a hot append on the replacement cell
		// before the stale readback returns the pre-append body.
		manager.restoreState(snapB);
		manager.flushSync();
		await storage.drain();
		await Promise.resolve();
		expect(manager.captureState().onDisk).toBe(true);

		const releaseAppend = holdAppends();
		const hotAppendId = manager.appendMessage({
			role: "user",
			content: "hot-append-on-replacement-cell",
			timestamp: 9101,
		});

		readGate.release();
		await headerRewrite;

		releaseAppend();
		await manager.flush();
		await storage.drain();

		const sizeAfterHotAppend = Buffer.byteLength(files.get(branchedFile) ?? "", "utf8");
		expect(manager.captureState().expectedDiskSize).toBe(sizeAfterHotAppend);

		await manager.addWorkspaceDirectory("/extra-root-after-stale-readback");
		await manager.setSessionName("Title After Stale Readback", "user");
		const followUpId = manager.appendMessage({
			role: "user",
			content: "turn-after-header-updates",
			timestamp: 9102,
		});
		await manager.flush();
		await storage.drain();
		expect(manager.captureState().expectedDiskSize).toBe(Buffer.byteLength(files.get(branchedFile) ?? "", "utf8"));
		await manager.close();

		const reopened = await SessionManager.open(branchedFile, "/sessions/indexed", storage);
		expect(reopened.getAdditionalDirectories()).toEqual([path.resolve("/extra-root-after-stale-readback")]);
		expect(reopened.getSessionName()).toBe("Title After Stale Readback");
		const branch = reopened.getBranch();
		expect(branch.map(entry => entry.type)).toEqual(["message", "message", "title_change", "message"]);
		expect([branch[0]?.id, branch[1]?.id, branch[3]?.id]).toEqual([seedId, hotAppendId, followUpId]);
		await reopened.close();
	});

	it("preserves an unconfirmed flushSync publish on the same cell when a stale rewrite readback resolves first", async () => {
		const { files, storage, holdRewrites, holdAtomicReturn, holdReadText } = await createHeldIndexedStorage();
		const manager = SessionManager.create("/cwd", "/sessions/indexed", storage);

		const seedId = manager.appendMessage(makeAssistantMessage());
		await manager.flush();
		await storage.drain();
		const snapA = manager.captureState();

		const branchedFile = manager.createBranchedSession(seedId);
		if (!branchedFile) throw new Error("Expected branched session file");
		await manager.flush();
		await storage.drain();
		await manager.setTaskPromptCacheKey("cache-key-aaaa");
		await storage.drain();

		const atomicReturnGate = holdAtomicReturn();
		const headerRewrite = manager.setTaskPromptCacheKey("cache-key-bbbb");
		const snapB = manager.captureState();
		await atomicReturnGate.entered;

		manager.restoreState(snapA);
		const readGate = holdReadText();
		atomicReturnGate.release();
		await readGate.entered;

		// Queue an unconfirmed flushSync() on B's cell (advancing deferredPublishGen while superseded is still false).
		manager.restoreState(snapB);
		const syncRewriteGate = holdRewrites();
		manager.flushSync();
		await syncRewriteGate.entered;
		expect(manager.captureState().onDisk).toBe(false);

		// Let stale readback finish before flushSync's deferred publish confirms.
		readGate.release();
		await headerRewrite;

		syncRewriteGate.release();
		await manager.flush();
		await storage.drain();
		expect(manager.captureState().onDisk).toBe(true);
		expect(manager.captureState().needsRewrite).toBe(false);
		expect(manager.captureState().expectedDiskSize).toBe(Buffer.byteLength(files.get(branchedFile) ?? "", "utf8"));

		const followUpId = manager.appendMessage({
			role: "user",
			content: "turn-after-unconfirmed-flushsync-race",
			timestamp: 9103,
		});
		await manager.flush();
		await storage.drain();
		await manager.close();

		const reopened = await SessionManager.open(branchedFile, "/sessions/indexed", storage);
		expect(reopened.getBranch().map(entry => entry.id)).toEqual([seedId, followUpId]);
		await reopened.close();
	});

	it("reconciles a size-changing rewriteEntries publish after a queued setSessionName is canceled by a fenced append", async () => {
		const { files, storage, holdAtomicReturn } = await createHeldIndexedStorage();
		const manager = SessionManager.create("/cwd", "/sessions/indexed", storage);

		const seedId = manager.appendMessage(makeAssistantMessage());
		await manager.flush();
		await storage.drain();
		const mutableId = manager.appendMessage({
			role: "user",
			content: "initial-short-content",
			timestamp: 9201,
		});
		await manager.flush();
		await storage.drain();

		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("Expected session file");

		const mutableEntry = manager.getEntry(mutableId);
		if (!mutableEntry || mutableEntry.type !== "message" || mutableEntry.message.role !== "user") {
			throw new Error("Expected mutable user message entry");
		}
		const expandedText = `expanded-content-${"x".repeat(512)}`;
		mutableEntry.message.content = expandedText;

		const atomicReturnGate = holdAtomicReturn();
		const rewritePromise = manager.rewriteEntries();
		await atomicReturnGate.entered;

		// Queue setSessionName() behind the pending rewrite, then issue a fenced append that bumps
		// diskEpoch (canceling the queued title task before it touches storage) and hits the size check.
		const titlePromise = manager.setSessionName("Title Queued Behind Rewrite", "user");
		const racingMsgId = manager.appendMessage({
			role: "user",
			content: "turn-during-pending-rewrite-and-title",
			timestamp: 9202,
		});

		atomicReturnGate.release();
		await Promise.all([rewritePromise, titlePromise, manager.flush()]);
		await storage.drain();

		const postFlushSnap = manager.captureState();
		expect(postFlushSnap.onDisk).toBe(true);
		expect(postFlushSnap.needsRewrite).toBe(false);
		expect(postFlushSnap.expectedDiskSize).toBe(Buffer.byteLength(files.get(sessionFile) ?? "", "utf8"));

		const followUpId = manager.appendMessage({
			role: "user",
			content: "turn-after-reconciled-rewrite",
			timestamp: 9203,
		});
		await manager.addWorkspaceDirectory("/extra-root-after-rewrite-reconcile");
		await manager.flush();
		await storage.drain();
		expect(manager.captureState().expectedDiskSize).toBe(Buffer.byteLength(files.get(sessionFile) ?? "", "utf8"));
		await manager.close();

		const reopened = await SessionManager.open(sessionFile, "/sessions/indexed", storage);
		expect(reopened.getSessionName()).toBe("Title Queued Behind Rewrite");
		expect(reopened.getAdditionalDirectories()).toEqual([path.resolve("/extra-root-after-rewrite-reconcile")]);
		const branch = reopened.getBranch();
		expect(branch.map(entry => entry.type)).toEqual(["message", "message", "title_change", "message", "message"]);
		expect([branch[0]?.id, branch[1]?.id, branch[3]?.id, branch[4]?.id]).toEqual([
			seedId,
			mutableId,
			racingMsgId,
			followUpId,
		]);
		const reopenedMutable = branch[1];
		expect(
			reopenedMutable?.type === "message" && reopenedMutable.message.role === "user"
				? reopenedMutable.message.content
				: undefined,
		).toBe(expandedText);
		await reopened.close();
	});

	it("reconciles an unacknowledged rewriteEntries publish when a restored header rewrite is guard-abandoned after a fenced append", async () => {
		const { files, storage, holdRewrites } = await createHeldIndexedStorage();
		const manager = SessionManager.create("/cwd", "/sessions/indexed", storage);

		manager.appendMessage(makeAssistantMessage());
		await manager.flush();
		await storage.drain();
		const otherSnap = manager.captureState();

		await manager.newSession();
		const seedId = manager.appendMessage(makeAssistantMessage());
		await manager.flush();
		await storage.drain();
		const mutableId = manager.appendMessage({
			role: "user",
			content: "initial-short-body",
			timestamp: 9301,
		});
		await manager.flush();
		await storage.drain();

		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("Expected session file");

		const mutableEntry = manager.getEntry(mutableId);
		if (!mutableEntry || mutableEntry.type !== "message" || mutableEntry.message.role !== "user") {
			throw new Error("Expected mutable user message entry");
		}
		const expandedText = `expanded-body-${"y".repeat(512)}`;
		mutableEntry.message.content = expandedText;

		let atomicCalls = 0;
		const secondAtomicEntered = Promise.withResolvers<void>();
		const prevWriteTextAtomic = storage.writeTextAtomic.bind(storage);
		storage.writeTextAtomic = async (filePath, content, options) => {
			atomicCalls++;
			if (atomicCalls === 2) {
				secondAtomicEntered.resolve();
			}
			await prevWriteTextAtomic(filePath, content, options);
		};

		const rewriteGate = holdRewrites();
		const op1 = manager.rewriteEntries();
		await rewriteGate.entered;

		// Snapshot and round-trip through another journal while op1 is unacknowledged,
		// then start a header rewrite (op2) that parks on awaitPath inside writeTextAtomic.
		const snapA = manager.captureState();
		manager.restoreState(otherSnap);
		manager.restoreState(snapA);

		const op2 = manager.addWorkspaceDirectory("/extra-root-abandoned-at-guard");
		await secondAtomicEntered.promise;

		// Synchronous append during op2's fence bumps diskEpoch (so op2 abandons at its
		// post-awaitPath commitGuard) and hits the size check against op1's index entry.
		const racingMsgId = manager.appendMessage({
			role: "user",
			content: "turn-canceling-parked-header-rewrite",
			timestamp: 9302,
		});

		rewriteGate.release();
		await Promise.all([op1, op2, manager.flush()]);
		await storage.drain();

		expect(atomicCalls).toBe(2);
		const postFlushSnap = manager.captureState();
		expect(postFlushSnap.onDisk).toBe(true);
		expect(postFlushSnap.needsRewrite).toBe(false);
		expect(postFlushSnap.expectedDiskSize).toBe(Buffer.byteLength(files.get(sessionFile) ?? "", "utf8"));

		const followUpId = manager.appendMessage({
			role: "user",
			content: "turn-after-guard-abandoned-rewrite",
			timestamp: 9303,
		});
		await manager.addWorkspaceDirectory("/extra-root-after-guard-abandoned-rewrite");
		await manager.flush();
		await storage.drain();
		expect(manager.captureState().expectedDiskSize).toBe(Buffer.byteLength(files.get(sessionFile) ?? "", "utf8"));
		await manager.close();

		const reopened = await SessionManager.open(sessionFile, "/sessions/indexed", storage);
		expect(reopened.getAdditionalDirectories()).toEqual([
			path.resolve("/extra-root-abandoned-at-guard"),
			path.resolve("/extra-root-after-guard-abandoned-rewrite"),
		]);
		const branch = reopened.getBranch();
		expect(branch.map(entry => entry.id)).toEqual([seedId, mutableId, racingMsgId, followUpId]);
		const reopenedMutable = branch[1];
		expect(
			reopenedMutable?.type === "message" && reopenedMutable.message.role === "user"
				? reopenedMutable.message.content
				: undefined,
		).toBe(expandedText);
		await reopened.close();
	});

	it("preserves batched appends when a workspace change and synchronous append race rewriteEntries completion", async () => {
		const { files, storage, holdRewrites, holdAtomicReturn } = await createHeldIndexedStorage();
		const manager = SessionManager.create("/cwd", "/sessions/indexed", storage);

		const seedId = manager.appendMessage(makeAssistantMessage());
		await manager.flush();
		await storage.drain();
		const mutableId = manager.appendMessage({
			role: "user",
			content: "initial-body-before-completion-race",
			timestamp: 9401,
		});
		await manager.flush();
		await storage.drain();

		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("Expected session file");

		const mutableEntry = manager.getEntry(mutableId);
		if (!mutableEntry || mutableEntry.type !== "message" || mutableEntry.message.role !== "user") {
			throw new Error("Expected mutable user message entry");
		}
		const expandedText = `expanded-completion-race-${"z".repeat(256)}`;
		mutableEntry.message.content = expandedText;

		const atomicReturnGate = holdAtomicReturn();
		const rewritePromise = manager.rewriteEntries();
		await atomicReturnGate.entered;

		// Hold the upcoming deferred sync publish on the backend while letting
		// rewriteEntries()'s writeTextAtomic finish.
		const deferredPublishGate = holdRewrites();
		atomicReturnGate.release();
		// Step to the microtask right after #runFencedAtomicRewrite records the
		// full rewrite (where #rewriteAtomically's post-await continuation used to
		// run a microtask later and clobber hot-path flags).
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();

		const wsPromise = manager.addWorkspaceDirectory("/ws-during-rewrite-completion");
		const syncMsgId = manager.appendMessage({
			role: "user",
			content: "sync-msg-queueing-deferred-publish",
			timestamp: 9402,
		});
		await deferredPublishGate.entered;
		await Promise.resolve();

		// Staged batch lands while the deferred full publish is still unconfirmed.
		let batchMsgA = "";
		let batchMsgB = "";
		manager.withAppendBatch(() => {
			batchMsgA = manager.appendMessage({
				role: "user",
				content: "batched-during-unconfirmed-deferred-publish-a",
				timestamp: 9403,
			});
			batchMsgB = manager.appendMessage({
				role: "user",
				content: "batched-during-unconfirmed-deferred-publish-b",
				timestamp: 9404,
			});
		});

		deferredPublishGate.release();
		await Promise.all([rewritePromise, wsPromise, manager.flush()]);
		await storage.drain();

		const postDrainErrors: Error[] = [];
		manager.onPersistenceError(err => postDrainErrors.push(err));

		const postRaceSnap = manager.captureState();
		expect(postRaceSnap.onDisk).toBe(true);
		expect(postRaceSnap.needsRewrite).toBe(false);
		expect(postRaceSnap.expectedDiskSize).toBe(Buffer.byteLength(files.get(sessionFile) ?? "", "utf8"));

		await manager.addWorkspaceDirectory("/ws-after-deferred-confirm");
		await manager.setSessionName("Title After Deferred Confirm", "user");
		const followUpId = manager.appendMessage({
			role: "user",
			content: "turn-after-deferred-confirm",
			timestamp: 9405,
		});
		await manager.flush();
		await storage.drain();

		expect(postDrainErrors).toEqual([]);
		expect(manager.captureState().expectedDiskSize).toBe(Buffer.byteLength(files.get(sessionFile) ?? "", "utf8"));
		await manager.close();

		const reopened = await SessionManager.open(sessionFile, "/sessions/indexed", storage);
		expect(reopened.getSessionName()).toBe("Title After Deferred Confirm");
		expect(reopened.getAdditionalDirectories()).toEqual([
			path.resolve("/ws-during-rewrite-completion"),
			path.resolve("/ws-after-deferred-confirm"),
		]);
		const branch = reopened.getBranch();
		expect(branch.map(entry => entry.type)).toEqual([
			"message",
			"message",
			"message",
			"message",
			"message",
			"title_change",
			"message",
		]);
		expect([branch[0]?.id, branch[1]?.id, branch[2]?.id, branch[3]?.id, branch[4]?.id, branch[6]?.id]).toEqual([
			seedId,
			mutableId,
			syncMsgId,
			batchMsgA,
			batchMsgB,
			followUpId,
		]);
		const reopenedMutable = branch[1];
		expect(
			reopenedMutable?.type === "message" && reopenedMutable.message.role === "user"
				? reopenedMutable.message.content
				: undefined,
		).toBe(expandedText);
		await reopened.close();
	});

	it("keeps rewriteRequired set when addWorkspaceDirectory races an in-flight rewriteEntries publish", async () => {
		const { files, storage, holdRewrites } = await createHeldIndexedStorage();
		const manager = SessionManager.create("/cwd", "/sessions/indexed", storage);
		const persistenceErrors: Error[] = [];
		manager.onPersistenceError(err => persistenceErrors.push(err));

		const seedId = manager.appendMessage(makeAssistantMessage());
		await manager.flush();
		await storage.drain();

		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("Expected session file");

		const rewriteGate = holdRewrites();
		const rewritePromise = manager.rewriteEntries();
		await rewriteGate.entered;

		// Mutate header during in-flight #writeBodyAtomic without bumping diskEpoch.
		const wsPromise = manager.addWorkspaceDirectory("/ws-during-inflight-rewrite");

		rewriteGate.release();
		await rewritePromise;

		// rewriteEntries() serialized before /ws-during-inflight-rewrite was added,
		// so needsRewrite must remain true until the queued header rewrite commits.
		expect(manager.captureState().needsRewrite).toBe(true);

		const postRewriteMsgId = manager.appendMessage({
			role: "user",
			content: "turn-immediately-after-inflight-header-change",
			timestamp: 9501,
		});
		await Promise.all([wsPromise, manager.flush()]);
		await storage.drain();

		expect(persistenceErrors).toEqual([]);
		expect(manager.captureState().expectedDiskSize).toBe(Buffer.byteLength(files.get(sessionFile) ?? "", "utf8"));
		await manager.close();

		const reopened = await SessionManager.open(sessionFile, "/sessions/indexed", storage);
		expect(reopened.getAdditionalDirectories()).toEqual([path.resolve("/ws-during-inflight-rewrite")]);
		expect(reopened.getBranch().map(entry => entry.id)).toEqual([seedId, postRewriteMsgId]);
		await reopened.close();
	});

	it("skips hot title append when self-conflict recovery already published the title entry", async () => {
		const { files, storage, holdRewrites } = await createHeldIndexedStorage();
		const manager = SessionManager.create("/cwd", "/sessions/indexed", storage);

		const firstPublishGate = holdRewrites();
		const firstAssistantId = manager.appendMessage(makeAssistantMessage());
		await firstPublishGate.entered;

		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("Expected session file");

		// Racing message before the initial deferred publish confirms triggers a queue-time
		// self-conflict while deferredPublishGen > 0.
		const secondMsgId = manager.appendMessage({
			role: "user",
			content: "before-initial-publish-confirms",
			timestamp: 9601,
		});

		const titlePromise = manager.setSessionName("Recovered Title", "user");
		const titleEntry = manager.getEntries().find(entry => entry.type === "title_change");
		if (!titleEntry) throw new Error("Expected title_change entry in journal");

		// Release the initial publish and capture the self-conflict recovery publish, which
		// already serializes [firstAssistantId, secondMsgId, titleEntry.id] + title slot.
		const recoveryPublishGate = holdRewrites();
		firstPublishGate.release();
		await recoveryPublishGate.entered;

		recoveryPublishGate.release();
		while (!manager.captureState().onDisk) {
			await Promise.resolve();
		}

		// Messages arriving right as recovery marks the file current (and across the
		// post-settlement resume window) must remain the active leaf rather than having a
		// duplicate title_change physically appended after them.
		const thirdMsgId = manager.appendMessage({
			role: "user",
			content: "message-as-recovery-marks-current",
			timestamp: 9602,
		});
		await Promise.resolve();
		await Promise.resolve();
		const fourthMsgId = manager.appendMessage({
			role: "user",
			content: "message-during-post-settlement-window",
			timestamp: 9603,
		});

		await Promise.all([titlePromise, manager.flush()]);
		await storage.drain();

		const rawContent = files.get(sessionFile) ?? "";
		const persistedIds = rawContent
			.trim()
			.split("\n")
			.slice(2)
			.map(line => (JSON.parse(line) as { id: string }).id);
		expect(persistedIds).toEqual([firstAssistantId, secondMsgId, titleEntry.id, thirdMsgId, fourthMsgId]);

		const listed = await SessionManager.list("/cwd", "/sessions/indexed", storage);
		expect(listed.find(item => item.path === sessionFile)?.title).toBe("Recovered Title");
		await manager.close();

		const reopened = await SessionManager.open(sessionFile, "/sessions/indexed", storage);
		expect(reopened.getSessionName()).toBe("Recovered Title");
		expect(reopened.getLeafId()).toBe(fourthMsgId);
		expect(reopened.getBranch().map(entry => entry.id)).toEqual([
			firstAssistantId,
			secondMsgId,
			titleEntry.id,
			thirdMsgId,
			fourthMsgId,
		]);
		await reopened.close();
	});

	it("skips a queued second hot title append when an earlier title task falls back to an atomic rewrite", async () => {
		const { files, storage } = await createHeldIndexedStorage();
		const manager = SessionManager.create("/cwd", "/sessions/indexed", storage);

		const seedId = manager.appendMessage(makeAssistantMessage());
		await manager.flush();
		await storage.drain();

		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("Expected session file");

		let failNextTitleOverlay = true;
		const prevUpdateSessionTitle = storage.updateSessionTitle.bind(storage);
		storage.updateSessionTitle = async (filePath, update) => {
			if (failNextTitleOverlay) {
				failNextTitleOverlay = false;
				throw new Error("Simulated title slot overlay failure");
			}
			await prevUpdateSessionTitle(filePath, update);
		};

		const firstRename = manager.setSessionName("First Title", "user");
		const secondRename = manager.setSessionName("Second Title", "user");
		const titleIds = manager
			.getEntries()
			.filter(entry => entry.type === "title_change")
			.map(entry => entry.id);
		expect(titleIds).toHaveLength(2);

		await Promise.all([firstRename, secondRename]);
		const postRenameMsgId = manager.appendMessage({
			role: "user",
			content: "turn-after-concurrent-renames",
			timestamp: 9701,
		});
		await manager.flush();
		await storage.drain();

		const rawContent = files.get(sessionFile) ?? "";
		const persistedIds = rawContent
			.trim()
			.split("\n")
			.slice(2)
			.map(line => (JSON.parse(line) as { id: string }).id);
		expect(persistedIds).toEqual([seedId, titleIds[0]!, titleIds[1]!, postRenameMsgId]);
		await manager.close();

		const reopened = await SessionManager.open(sessionFile, "/sessions/indexed", storage);
		expect(reopened.getSessionName()).toBe("Second Title");
		expect(reopened.getLeafId()).toBe(postRenameMsgId);
		expect(reopened.getBranch().map(entry => entry.id)).toEqual([
			seedId,
			titleIds[0]!,
			titleIds[1]!,
			postRenameMsgId,
		]);
		await reopened.close();
	});

	it("reconciles a landed rewriteEntries publish when its backend ack rejects and a restored header rewrite fails in awaitPath", async () => {
		const { files, storage, holdRewrites } = await createHeldIndexedStorage();
		const manager = SessionManager.create("/cwd", "/sessions/indexed", storage);

		manager.appendMessage(makeAssistantMessage());
		await manager.flush();
		await storage.drain();
		const otherSnap = manager.captureState();

		await manager.newSession();
		const seedId = manager.appendMessage(makeAssistantMessage());
		await manager.flush();
		await storage.drain();
		const mutableId = manager.appendMessage({
			role: "user",
			content: "pre-ack-loss-short-body",
			timestamp: 9801,
		});
		await manager.flush();
		await storage.drain();

		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("Expected session file");

		const preRewriteBytes = Buffer.byteLength(files.get(sessionFile) ?? "", "utf8");
		const mutableEntry = manager.getEntry(mutableId);
		if (!mutableEntry || mutableEntry.type !== "message" || mutableEntry.message.role !== "user") {
			throw new Error("Expected mutable user message entry");
		}
		const expandedText = `expanded-ack-loss-body-${"w".repeat(512)}`;
		mutableEntry.message.content = expandedText;

		let atomicCalls = 0;
		const secondAtomicEntered = Promise.withResolvers<void>();
		const prevWriteTextAtomic = storage.writeTextAtomic.bind(storage);
		storage.writeTextAtomic = async (filePath, content, options) => {
			atomicCalls++;
			if (atomicCalls === 2) {
				secondAtomicEntered.resolve();
			}
			await prevWriteTextAtomic(filePath, content, options);
		};

		// op1 lands its expanded body in backend files, then rejects its writeFull acknowledgement.
		const rewriteGate = holdRewrites({ ackError: new Error("lost writeFull acknowledgement") });
		const op1 = manager.rewriteEntries();
		await rewriteGate.entered;

		// Round-trip snapshots while op1 is in flight and start op2, which parks on #awaitPath
		// inside writeTextAtomic and inherits op1's uncaught path rejection before reaching onCommit.
		const snapA = manager.captureState();
		manager.restoreState(otherSnap);
		manager.restoreState(snapA);

		const op2 = manager.addWorkspaceDirectory("/ws-rejected-in-await-path");
		await secondAtomicEntered.promise;

		rewriteGate.release();
		await op1;
		await expect(op2).rejects.toThrow("lost writeFull acknowledgement");
		await storage.drain();

		const landedOp1Bytes = Buffer.byteLength(files.get(sessionFile) ?? "", "utf8");
		expect(landedOp1Bytes).toBeGreaterThan(preRewriteBytes);
		// op2 never committed, so op1's stale readback reconciliation must advance expectedDiskSize
		// to landedOp1Bytes rather than leaving it stuck at preRewriteBytes.
		expect(manager.captureState().expectedDiskSize).toBe(landedOp1Bytes);

		const recoveryTurnId = manager.appendMessage({
			role: "user",
			content: "turn-after-predecessor-failure-reconcile",
			timestamp: 9802,
		});
		await manager.flush();
		await storage.drain();

		expect(manager.captureState().onDisk).toBe(true);
		expect(manager.captureState().needsRewrite).toBe(false);
		expect(manager.captureState().expectedDiskSize).toBe(Buffer.byteLength(files.get(sessionFile) ?? "", "utf8"));
		await manager.close();

		const reopened = await SessionManager.open(sessionFile, "/sessions/indexed", storage);
		expect(reopened.getAdditionalDirectories()).toEqual([path.resolve("/ws-rejected-in-await-path")]);
		const branch = reopened.getBranch();
		expect(branch.map(entry => entry.id)).toEqual([seedId, mutableId, recoveryTurnId]);
		const reopenedMutable = branch[1];
		expect(
			reopenedMutable?.type === "message" && reopenedMutable.message.role === "user"
				? reopenedMutable.message.content
				: undefined,
		).toBe(expandedText);
		await reopened.close();
	});

	it("reconciles a landed recoverPersistenceFromCurrentState rewrite after an earlier append failure when raced before ack completion", async () => {
		const { files, storage, failNextAppend, holdRewrites } = await createHeldIndexedStorage();
		const manager = SessionManager.create("/cwd", "/sessions/indexed", storage);

		const seedId = manager.appendMessage(makeAssistantMessage());
		await manager.flush();
		await storage.drain();

		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("Expected session file");

		const preFailureBytes = Buffer.byteLength(files.get(sessionFile) ?? "", "utf8");

		failNextAppend(new Error("transient append outage"));
		const failedMsgId = manager.appendMessage({
			role: "user",
			content: "turn-whose-hot-append-failed",
			timestamp: 9901,
		});
		await expect(manager.flush()).rejects.toThrow("transient append outage");
		expect(manager.captureState().expectedDiskSize).toBe(preFailureBytes);

		// Start authoritative repair; hold after the replacement body [seedId, failedMsgId]
		// lands in backend storage, before writeFull's acknowledgement completes.
		const repairAckGate = holdRewrites({ afterLand: true });
		const repair = manager.recoverPersistenceFromCurrentState();
		await repairAckGate.entered;

		const landedRepairBytes = Buffer.byteLength(files.get(sessionFile) ?? "", "utf8");
		expect(landedRepairBytes).toBeGreaterThan(preFailureBytes);

		// Racing message bumps the epoch and self-conflicts against landedRepairBytes while
		// expectedDiskSize is still preFailureBytes.
		const racingMsgId = manager.appendMessage({
			role: "user",
			content: "turn-arriving-before-repair-ack-completes",
			timestamp: 9902,
		});

		repairAckGate.release();
		await expect(repair).rejects.toBeInstanceOf(SessionPersistenceIndeterminateError);
		await storage.drain();

		// Verified full-publish readback supersedes the pre-snapshot append failure and
		// advances expectedDiskSize to landedRepairBytes so subsequent recovery turns succeed.
		expect(manager.captureState().expectedDiskSize).toBe(landedRepairBytes);
		expect(manager.captureState().onDisk).toBe(false);
		expect(manager.captureState().needsRewrite).toBe(true);

		const recoveryTurnId = manager.appendMessage({
			role: "user",
			content: "subsequent-recovery-turn",
			timestamp: 9903,
		});
		await manager.flush();
		await storage.drain();

		expect(manager.captureState().onDisk).toBe(true);
		expect(manager.captureState().needsRewrite).toBe(false);
		expect(manager.captureState().expectedDiskSize).toBe(Buffer.byteLength(files.get(sessionFile) ?? "", "utf8"));
		await manager.close();

		const reopened = await SessionManager.open(sessionFile, "/sessions/indexed", storage);
		expect(reopened.getBranch().map(entry => entry.id)).toEqual([seedId, failedMsgId, racingMsgId, recoveryTurnId]);
		await reopened.close();
	});

	it("reconciles a landed title-fallback rewrite after a hot title append failure when raced by a message", async () => {
		const { files, storage, failNextAppend, holdRewrites } = await createHeldIndexedStorage();
		const manager = SessionManager.create("/cwd", "/sessions/indexed", storage);

		const seedId = manager.appendMessage(makeAssistantMessage());
		await manager.flush();
		await storage.drain();

		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("Expected session file");

		failNextAppend(new Error("transient title append outage"));
		const fallbackAckGate = holdRewrites({ afterLand: true });
		const titlePromise = manager.setSessionName("Recovered After Title Append Failure", "user");
		const titleEntry = manager.getEntries().find(entry => entry.type === "title_change");
		if (!titleEntry) throw new Error("Expected title_change entry in journal");

		await fallbackAckGate.entered;

		const racingMsgId = manager.appendMessage({
			role: "user",
			content: "turn-arriving-before-title-fallback-ack",
			timestamp: 9951,
		});

		fallbackAckGate.release();
		await Promise.all([titlePromise, manager.flush()]);
		await storage.drain();

		expect(manager.captureState().onDisk).toBe(true);
		expect(manager.captureState().needsRewrite).toBe(false);
		expect(manager.captureState().expectedDiskSize).toBe(Buffer.byteLength(files.get(sessionFile) ?? "", "utf8"));
		await manager.close();

		const reopened = await SessionManager.open(sessionFile, "/sessions/indexed", storage);
		expect(reopened.getSessionName()).toBe("Recovered After Title Append Failure");
		expect(reopened.getBranch().map(entry => entry.id)).toEqual([seedId, titleEntry.id, racingMsgId]);
		await reopened.close();
	});
});
