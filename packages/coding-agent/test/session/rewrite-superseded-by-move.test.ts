import { expect, it, vi } from "bun:test";
import { SQL } from "bun";
import * as fs from "node:fs";
import * as path from "node:path";
import { SessionManager, type SessionPersistenceNotice } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	FileSessionStorage,
	type SessionStorageWriteOptions,
	SessionWriteConflictError,
	type WriteTextAtomicOptions,
} from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { SqlSessionStorage, type SqlSessionStorageClient } from "@oh-my-pi/pi-coding-agent/session/sql-session-storage";
import { TempDir } from "@oh-my-pi/pi-utils";

/** File storage whose next atomic write fails once; `onReadAfterFailure` runs before the first read after it. */
class StorageFailingOneAtomicWrite extends FileSessionStorage {
	armed = false;
	failed = false;
	onReadAfterFailure: (() => Promise<void>) | undefined;

	override async writeTextAtomic(file: string, body: string, options?: WriteTextAtomicOptions): Promise<void> {
		if (this.armed && !this.failed) {
			this.failed = true;
			throw new Error("atomic write denied");
		}
		return super.writeTextAtomic(file, body, options);
	}

	override async readText(file: string): Promise<string> {
		const run = this.failed ? this.onReadAfterFailure : undefined;
		if (run) {
			this.onReadAfterFailure = undefined;
			await run();
		}
		return super.readText(file);
	}
}

// A rewrite whose own write failed is settled like a superseded one: a write
// that ran meanwhile and saved its change keeps it, and nothing is restored.
it("keeps a rewrite whose own write failed when a write that ran meanwhile saved its change", async () => {
	using tempDir = TempDir.createSync("@omp-rewrite-own-failure-");
	const storage = new StorageFailingOneAtomicWrite();
	const manager = SessionManager.create(tempDir.path(), path.join(tempDir.path(), "sessions"), storage);
	manager.onPersistenceError(() => {});
	try {
		manager.appendMessage({ role: "user", content: "a turn worth saving", timestamp: Date.now() });
		manager.appendCustomEntry("marker", { state: "before" });
		await manager.ensureOnDisk();
		await manager.flush();
		const marker = manager.getEntries().find(entry => entry.type === "custom" && entry.customType === "marker");
		if (marker?.type !== "custom") throw new Error("Expected the marker entry");
		marker.data = { state: "after" };
		let raced = false;
		storage.onReadAfterFailure = async () => {
			raced = true;
			manager.appendCustomEntry("successor", {});
			await manager.flush().catch(() => {});
		};
		storage.armed = true;
		let restored = false;
		const outcome = await manager
			.rewriteEntries({
				restore: () => {
					marker.data = { state: "before" };
					restored = true;
				},
			})
			.then(
				() => "kept",
				() => "failed",
			);

		expect(storage.failed).toBe(true);
		expect(raced).toBe(true);
		expect(outcome).toBe("kept");
		expect(restored).toBe(false);
		const file = manager.getSessionFile();
		if (!file) throw new Error("Expected a persisted session");
		const onDisk = fs.readFileSync(file, "utf8");
		expect(onDisk).toContain('"state":"after"');
		expect(onDisk).toContain('"customType":"successor"');
		// The write that saved it recovered storage: the failed write's error is not left
		// behind to refuse the next flush or rewrite.
		await manager.flush();
		marker.data = { state: "later" };
		await manager.rewriteEntries();
		expect(fs.readFileSync(file, "utf8")).toContain('"state":"later"');
	} finally {
		manager.seal();
		await manager.close().catch(() => {});
	}
});

// A rewrite a latched failure refused before its turn is settled the same way:
// an append retrying the full write saves the change before the verdict.
for (const depth of [0, 1, 2, 3, 4, 5]) {
	it(`keeps a rewrite a latched failure refused when an append ${depth} microtasks later saved its change`, async () => {
		using tempDir = TempDir.createSync("@omp-rewrite-latched-");
		const storage = new StorageFailingOneAtomicWrite();
		const manager = SessionManager.create(tempDir.path(), path.join(tempDir.path(), "sessions"), storage);
		manager.onPersistenceError(() => {});
		try {
			manager.appendMessage({ role: "user", content: "a turn worth saving", timestamp: Date.now() });
			manager.appendCustomEntry("marker", { state: "before" });
			await manager.ensureOnDisk();
			await manager.flush();
			// Latch a write failure.
			storage.armed = true;
			await manager.rewriteEntries().catch(() => {});
			expect(storage.failed).toBe(true);
			const marker = manager.getEntries().find(entry => entry.type === "custom" && entry.customType === "marker");
			if (marker?.type !== "custom") throw new Error("Expected the marker entry");
			marker.data = { state: "after" };
			let restored = false;
			const rewrite = manager
				.rewriteEntries({
					restore: () => {
						marker.data = { state: "before" };
						restored = true;
					},
				})
				.then(
					() => "kept",
					() => "failed",
				);
			let racing = Promise.resolve();
			for (let step = 0; step < depth; step++) racing = racing.then(() => {});
			const appended = racing.then(() => manager.appendCustomEntry("successor", {}));
			const outcome = await rewrite;
			await appended;
			await manager.flush().catch(() => {});
			const file = manager.getSessionFile();
			if (!file) throw new Error("Expected a persisted session");
			const onDisk = fs.readFileSync(file, "utf8");
			// What the caller is told matches what storage holds.
			if (outcome === "kept") {
				expect(restored).toBe(false);
				expect(onDisk).toContain('"state":"after"');
			} else {
				expect(restored).toBe(true);
				expect(onDisk).not.toContain('"state":"after"');
			}
			expect(onDisk).toContain('"customType":"successor"');
		} finally {
			manager.seal();
			await manager.close().catch(() => {});
		}
	});
}

/**
 * File storage over which another writer takes the session's file while a
 * full rewrite of it is on its way. The asynchronous rewrite of `held.file`
 * waits until `held.go` resolves and then meets the other writer's change;
 * from `takeOver()` on, every synchronous full write of that file meets it
 * too, so the session's next write gives the file up and moves the session.
 */
class StorageTakenOverMidRewrite extends FileSessionStorage {
	#takenOver?: string;
	/** From when it is set, every synchronous full write of a file the other writer did not take fails. */
	failSyncWrites = false;
	held?: {
		file: string;
		reached: PromiseWithResolvers<void>;
		go: PromiseWithResolvers<void>;
		/** How the held write ends: it meets the other writer's change, or it goes on and its commit guard refuses to publish. */
		ends?: "conflict" | "commit-guard";
	};

	takeOver(file: string): void {
		this.#takenOver = path.resolve(file);
	}

	override writeTextSync(file: string, body: string, options?: SessionStorageWriteOptions): void {
		if (this.#takenOver === path.resolve(file)) {
			const expected = options?.expectedSize ?? 0;
			throw new SessionWriteConflictError(file, expected, expected + 1);
		}
		if (this.failSyncWrites)
			throw Object.assign(new Error(`EACCES: permission denied, open '${file}'`), { code: "EACCES" });
		super.writeTextSync(file, body, options);
	}

	override async writeTextAtomic(file: string, body: string, options?: WriteTextAtomicOptions): Promise<void> {
		const held = this.held;
		if (held && path.resolve(file) === path.resolve(held.file)) {
			this.held = undefined;
			held.reached.resolve();
			await held.go.promise;
			if (held.ends === "commit-guard") return super.writeTextAtomic(file, body, options);
			const expected = options?.expectedSize ?? 0;
			throw new SessionWriteConflictError(file, expected, expected + 1);
		}
		await super.writeTextAtomic(file, body, options);
	}
}

it("keeps a rewrite that a write moving the session superseded, instead of reporting it failed", async () => {
	using tempDir = TempDir.createSync("@omp-rewrite-superseded-");
	const storage = new StorageTakenOverMidRewrite();
	const manager = SessionManager.create(tempDir.path(), path.join(tempDir.path(), "sessions"), storage);
	const notices: SessionPersistenceNotice[] = [];
	manager.onPersistenceNotice(notice => notices.push(notice));
	try {
		manager.appendMessage({ role: "user", content: "a turn worth saving", timestamp: Date.now() });
		manager.appendCustomEntry("marker", { state: "before" });
		await manager.ensureOnDisk();
		await manager.flush();
		const original = manager.getSessionFile();
		if (!original) throw new Error("Expected a persisted session");

		// An in-place change announced through `rewriteEntries()`, as compaction makes.
		const marker = manager.getEntries().find(entry => entry.type === "custom" && entry.customType === "marker");
		if (marker?.type !== "custom") throw new Error("Expected the marker entry");
		marker.data = { state: "after" };
		const held = { file: original, reached: Promise.withResolvers<void>(), go: Promise.withResolvers<void>() };
		storage.held = held;
		const rewrite = manager.rewriteEntries().then(
			() => "kept",
			(error: unknown) => (error instanceof Error ? error.message : String(error)),
		);
		await held.reached.promise;

		// Another writer takes the file. The session's next entry lands while
		// the rewrite is on its way, so a synchronous rewrite writes it: that
		// meets the other writer, moves the session to a new file and
		// publishes the whole transcript there.
		storage.takeOver(original);
		manager.appendCustomEntry("concurrent", {});
		held.go.resolve();

		expect(await rewrite).toBe("kept");
		const moved = manager.getSessionFile();
		if (!moved) throw new Error("Expected the session to have a file");
		expect(notices.map(notice => [notice.reason, notice.from, notice.to])).toEqual([["contested", original, moved]]);
		const onDisk = fs.readFileSync(moved, "utf8");
		expect(onDisk).toContain('"state":"after"');
		expect(onDisk).toContain('"customType":"concurrent"');
	} finally {
		manager.seal();
		await manager.close().catch(() => {});
	}
});

// The successor that superseded the rewrite must itself have published the
// transcript: one that failed published nothing, and the rewrite writes
// nothing of its own, so the failure reaches its caller (prune, snapshot
// restore and the like restore their change on it).
for (const [successor, moves, ends] of [
	["a synchronous rewrite of the same file that fails", false, "conflict"],
	["a synchronous rewrite that moves the session and fails to write the new file", true, "conflict"],
	["a synchronous rewrite that fails, and its own write returns with nothing published", false, "commit-guard"],
] as const) {
	it(`reports the rewrite failed when ${successor} superseded it`, async () => {
		using tempDir = TempDir.createSync("@omp-rewrite-superseded-failed-");
		const storage = new StorageTakenOverMidRewrite();
		const manager = SessionManager.create(tempDir.path(), path.join(tempDir.path(), "sessions"), storage);
		const notices: SessionPersistenceNotice[] = [];
		manager.onPersistenceNotice(notice => notices.push(notice));
		manager.onPersistenceError(() => {});
		try {
			manager.appendMessage({ role: "user", content: "a turn worth saving", timestamp: Date.now() });
			manager.appendCustomEntry("marker", { state: "before" });
			await manager.ensureOnDisk();
			await manager.flush();
			const original = manager.getSessionFile();
			if (!original) throw new Error("Expected a persisted session");
			const marker = manager.getEntries().find(entry => entry.type === "custom" && entry.customType === "marker");
			if (marker?.type !== "custom") throw new Error("Expected the marker entry");
			marker.data = { state: "after" };
			const held = {
				file: original,
				reached: Promise.withResolvers<void>(),
				go: Promise.withResolvers<void>(),
				ends,
			};
			storage.held = held;
			const rewrite = manager.rewriteEntries().then(
				() => "kept",
				() => "failed",
			);
			await held.reached.promise;

			if (moves) storage.takeOver(original);
			storage.failSyncWrites = true;
			manager.appendCustomEntry("concurrent", {});
			held.go.resolve();

			expect(await rewrite).toBe("failed");
			expect(notices.map(notice => notice.reason)).toEqual(moves ? ["contested"] : []);
			// Nothing published the change: the original file still holds the old state.
			expect(fs.readFileSync(original, "utf8")).toContain('"state":"before"');
		} finally {
			storage.failSyncWrites = false;
			manager.seal();
			await manager.close().catch(() => {});
		}
	});
}

// What the caller is told matches what storage holds, whichever write saved
// it; and after a rejection the next write replaces the file with what memory
// holds once the caller restored its change.
for (const [what, mode, expected] of [
	["its successor failed, even though storage recovered before it settled", "recovered", "failed"],
	["a durable successor saved it, though the session was then sealed", "sealed", "kept"],
	["the session was sealed before any write saved it", "sealed-first", "failed"],
] as const) {
	it(`reports a superseded rewrite ${expected} when ${what}`, async () => {
		using tempDir = TempDir.createSync("@omp-rewrite-superseded-kept-");
		const storage = new StorageTakenOverMidRewrite();
		const manager = SessionManager.create(tempDir.path(), path.join(tempDir.path(), "sessions"), storage);
		manager.onPersistenceError(() => {});
		try {
			manager.appendMessage({ role: "user", content: "a turn worth saving", timestamp: Date.now() });
			manager.appendCustomEntry("marker", { state: "before" });
			await manager.ensureOnDisk();
			await manager.flush();
			const original = manager.getSessionFile();
			if (!original) throw new Error("Expected a persisted session");
			const marker = manager.getEntries().find(entry => entry.type === "custom" && entry.customType === "marker");
			if (marker?.type !== "custom") throw new Error("Expected the marker entry");
			marker.data = { state: "after" };
			const held = { file: original, reached: Promise.withResolvers<void>(), go: Promise.withResolvers<void>() };
			storage.held = held;
			const rewrite = manager.rewriteEntries().then(
				() => "kept",
				() => "failed",
			);
			await held.reached.promise;

			if (mode === "recovered") {
				storage.failSyncWrites = true;
				manager.appendCustomEntry("concurrent", {});
				storage.failSyncWrites = false;
			} else if (mode === "sealed") {
				manager.appendCustomEntry("concurrent", {});
				manager.seal();
			} else {
				manager.seal();
			}
			held.go.resolve();

			expect(await rewrite).toBe(expected);
			const onDisk = fs.readFileSync(original, "utf8");
			expect(onDisk.includes('"state":"after"')).toBe(expected === "kept");
			if (mode === "recovered") {
				// The caller restores its change; the next write saves memory as it now is.
				marker.data = { state: "before" };
				manager.appendCustomEntry("after-restore", {});
				await manager.flush().catch(() => {});
				const healed = fs.readFileSync(manager.getSessionFile() ?? original, "utf8");
				expect(healed).toContain('"state":"before"');
				expect(healed).not.toContain('"state":"after"');
				expect(healed).toContain('"customType":"after-restore"');
			}
		} finally {
			storage.failSyncWrites = false;
			manager.seal();
			await manager.close().catch(() => {});
		}
	});
}

it("reports a header change's rewrite failed when its successor failed, though an earlier body is durable", async () => {
	using tempDir = TempDir.createSync("@omp-rewrite-superseded-header-");
	const storage = new StorageTakenOverMidRewrite();
	const manager = SessionManager.create(tempDir.path(), path.join(tempDir.path(), "sessions"), storage);
	manager.onPersistenceError(() => {});
	try {
		manager.appendMessage({ role: "user", content: "a turn worth saving", timestamp: Date.now() });
		await manager.ensureOnDisk();
		await manager.flush();
		const original = manager.getSessionFile();
		if (!original) throw new Error("Expected a persisted session");
		const held = { file: original, reached: Promise.withResolvers<void>(), go: Promise.withResolvers<void>() };
		storage.held = held;
		const change = manager.setTaskPromptCacheKey("UNSAVED-KEY").then(
			() => "kept",
			() => "failed",
		);
		await held.reached.promise;
		storage.failSyncWrites = true;
		manager.appendCustomEntry("concurrent", {});
		storage.failSyncWrites = false;
		held.go.resolve();

		expect(await change).toBe("failed");
		expect(fs.readFileSync(original, "utf8")).not.toContain("UNSAVED-KEY");
	} finally {
		storage.failSyncWrites = false;
		manager.seal();
		await manager.close().catch(() => {});
	}
});

// A write that runs after the verdict but before the caller could restore must
// not save the unsaved change: the restore runs inside the verdict.
for (const depth of [0, 1, 2, 4, 8, 16]) {
	it(`restores an unsaved change before any write can run, with an append ${depth} microtasks after the verdict`, async () => {
		using tempDir = TempDir.createSync("@omp-rewrite-superseded-restore-");
		const storage = new StorageTakenOverMidRewrite();
		const manager = SessionManager.create(tempDir.path(), path.join(tempDir.path(), "sessions"), storage);
		manager.onPersistenceError(() => {});
		try {
			manager.appendMessage({ role: "user", content: "a turn worth saving", timestamp: Date.now() });
			manager.appendCustomEntry("marker", { state: "before" });
			await manager.ensureOnDisk();
			await manager.flush();
			const original = manager.getSessionFile();
			if (!original) throw new Error("Expected a persisted session");
			const marker = manager.getEntries().find(entry => entry.type === "custom" && entry.customType === "marker");
			if (marker?.type !== "custom") throw new Error("Expected the marker entry");
			marker.data = { state: "after" };
			const held = { file: original, reached: Promise.withResolvers<void>(), go: Promise.withResolvers<void>() };
			storage.held = held;
			let restored = false;
			const rewrite = manager
				.rewriteEntries({
					restore: () => {
						marker.data = { state: "before" };
						restored = true;
						// Storage recovers at the verdict, and an append racing the caller lands
						// `depth` microtasks after it: that append's write succeeds.
						storage.failSyncWrites = false;
						let racing = Promise.resolve();
						for (let step = 0; step < depth; step++) racing = racing.then(() => {});
						void racing.then(() => manager.appendCustomEntry("racing", {}));
					},
				})
				.then(
					() => "kept",
					() => "failed",
				);
			await held.reached.promise;
			// The successor fails, and storage stays failing until the verdict is in.
			storage.failSyncWrites = true;
			manager.appendCustomEntry("concurrent", {});
			held.go.resolve();

			expect(await rewrite).toBe("failed");
			expect(restored).toBe(true);
			manager.appendCustomEntry("after-verdict", {});
			await manager.flush().catch(() => {});
			const onDisk = fs.readFileSync(manager.getSessionFile() ?? original, "utf8");
			expect(onDisk).not.toContain('"state":"after"');
			expect(onDisk).toContain('"customType":"racing"');
			expect(onDisk).toContain('"customType":"after-verdict"');
		} finally {
			storage.failSyncWrites = false;
			manager.seal();
			await manager.close().catch(() => {});
		}
	});
}

it("reports why a rewrite failed when its caller's restore throws", async () => {
	using tempDir = TempDir.createSync("@omp-rewrite-superseded-restore-throws-");
	const storage = new StorageTakenOverMidRewrite();
	const manager = SessionManager.create(tempDir.path(), path.join(tempDir.path(), "sessions"), storage);
	manager.onPersistenceError(() => {});
	try {
		manager.appendMessage({ role: "user", content: "a turn worth saving", timestamp: Date.now() });
		manager.appendCustomEntry("marker", { state: "before" });
		await manager.ensureOnDisk();
		await manager.flush();
		const original = manager.getSessionFile();
		if (!original) throw new Error("Expected a persisted session");
		const marker = manager.getEntries().find(entry => entry.type === "custom" && entry.customType === "marker");
		if (marker?.type !== "custom") throw new Error("Expected the marker entry");
		marker.data = { state: "after" };
		const held = { file: original, reached: Promise.withResolvers<void>(), go: Promise.withResolvers<void>() };
		storage.held = held;
		const rewrite = manager.rewriteEntries({
			restore: () => {
				storage.failSyncWrites = false;
				throw new Error("restore broke");
			},
		});
		const settled = rewrite.then(
			() => undefined,
			(error: unknown) => error,
		);
		await held.reached.promise;
		// The successor fails, and storage stays failing until the verdict is in.
		storage.failSyncWrites = true;
		manager.appendCustomEntry("concurrent", {});
		held.go.resolve();

		const error = await settled;
		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).not.toContain("restore broke");
	} finally {
		storage.failSyncWrites = false;
		manager.seal();
		await manager.close().catch(() => {});
	}
});

it("reports a rewrite failed when the session is sealed before its turn on the disk chain", async () => {
	using tempDir = TempDir.createSync("@omp-rewrite-superseded-queued-");
	const manager = SessionManager.create(
		tempDir.path(),
		path.join(tempDir.path(), "sessions"),
		new FileSessionStorage(),
	);
	try {
		manager.appendMessage({ role: "user", content: "a turn worth saving", timestamp: Date.now() });
		manager.appendCustomEntry("marker", { state: "before" });
		await manager.ensureOnDisk();
		await manager.flush();
		const file = manager.getSessionFile();
		if (!file) throw new Error("Expected a persisted session");
		const marker = manager.getEntries().find(entry => entry.type === "custom" && entry.customType === "marker");
		if (marker?.type !== "custom") throw new Error("Expected the marker entry");
		marker.data = { state: "after" };
		const rewrite = manager.rewriteEntries().then(
			() => "kept",
			() => "failed",
		);
		manager.seal();
		expect(await rewrite).toBe("failed");
		expect(fs.readFileSync(file, "utf8")).toContain('"state":"before"');
	} finally {
		manager.seal();
		await manager.close().catch(() => {});
	}
});

/** SQLite client whose next content update waits for `held.go`, then fails. */
class HeldSqlClient implements SqlSessionStorageClient {
	readonly options: SqlSessionStorageClient["options"];
	held?: { reached: PromiseWithResolvers<void>; go: PromiseWithResolvers<void> };
	constructor(readonly client: InstanceType<typeof SQL>) {
		this.options = client.options;
	}
	unsafe(query: string, values?: unknown[]) {
		const held = this.held;
		if (held && query.startsWith("UPDATE omp_session_files SET content")) {
			this.held = undefined;
			held.reached.resolve();
			return held.go.promise.then(() => this.client.unsafe("SELECT missing_column FROM omp_session_files"));
		}
		return this.client.unsafe(query, values);
	}
	transaction(callback: (transaction: SqlSessionStorageClient) => Promise<void>) {
		return this.client.transaction(transaction => callback(transaction));
	}
}

it("keeps a rewrite whose successor's outcome is overtaken by a newer write that persists it", async () => {
	using tempDir = TempDir.createSync("@omp-rewrite-superseded-sql-");
	const client = new SQL(`sqlite://${path.join(tempDir.path(), "sessions.db")}`);
	const held = new HeldSqlClient(client);
	const storage = await SqlSessionStorage.create({ client: held });
	const manager = SessionManager.create(tempDir.path(), path.join(tempDir.path(), "sessions"), storage);
	manager.onPersistenceError(() => {});
	try {
		manager.appendMessage({ role: "user", content: "a turn worth saving", timestamp: Date.now() });
		manager.appendCustomEntry("marker", { state: "before" });
		await manager.ensureOnDisk();
		await manager.flush();
		const file = manager.getSessionFile();
		if (!file) throw new Error("Expected a persisted session");
		const marker = manager.getEntries().find(entry => entry.type === "custom" && entry.customType === "marker");
		if (marker?.type !== "custom") throw new Error("Expected the marker entry");
		marker.data = { state: "after" };
		const gate = { reached: Promise.withResolvers<void>(), go: Promise.withResolvers<void>() };
		held.held = gate;
		const rewrite = manager.rewriteEntries().then(
			() => "kept",
			() => "failed",
		);
		await gate.reached.promise;
		// The first successor's publish is still unconfirmed when the rewrite fails;
		// a newer one lands while the rewrite waits on it, and persists the change.
		manager.appendCustomEntry("first-successor", {});
		const readText = storage.readText.bind(storage);
		let armed = true;
		vi.spyOn(storage, "readText").mockImplementation(async target => {
			const text = await readText(target);
			if (armed) {
				armed = false;
				queueMicrotask(() => queueMicrotask(() => manager.appendCustomEntry("latest-successor", {})));
			}
			return text;
		});
		gate.go.resolve();

		expect(await rewrite).toBe("kept");
		await storage.drain().catch(() => {});
		const rows = await client.unsafe("SELECT content FROM omp_session_files WHERE path = ?", [file]);
		const onDisk = String(rows[0]?.content);
		expect(onDisk).toContain('"state":"after"');
		expect(onDisk).toContain('"customType":"latest-successor"');
	} finally {
		vi.restoreAllMocks();
		manager.seal();
		await manager.close().catch(() => {});
		await client.end();
	}
});
