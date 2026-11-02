import { expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { SessionManager, type SessionPersistenceNotice } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	FileSessionStorage,
	type SessionStorageWriteOptions,
	SessionWriteConflictError,
	type WriteTextAtomicOptions,
} from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { TempDir } from "@oh-my-pi/pi-utils";

/**
 * File storage over which another writer takes the session's file while a
 * full rewrite of it is on its way. The asynchronous rewrite of `held.file`
 * waits until `held.go` resolves and then meets the other writer's change;
 * from `takeOver()` on, every synchronous full write of that file meets it
 * too, so the session's next write gives the file up and moves the session.
 */
class StorageTakenOverMidRewrite extends FileSessionStorage {
	#takenOver?: string;
	held?: { file: string; reached: PromiseWithResolvers<void>; go: PromiseWithResolvers<void> };

	takeOver(file: string): void {
		this.#takenOver = path.resolve(file);
	}

	override writeTextSync(file: string, body: string, options?: SessionStorageWriteOptions): void {
		if (this.#takenOver === path.resolve(file)) {
			const expected = options?.expectedSize ?? 0;
			throw new SessionWriteConflictError(file, expected, expected + 1);
		}
		super.writeTextSync(file, body, options);
	}

	override async writeTextAtomic(file: string, body: string, options?: WriteTextAtomicOptions): Promise<void> {
		const held = this.held;
		if (held && path.resolve(file) === path.resolve(held.file)) {
			this.held = undefined;
			held.reached.resolve();
			await held.go.promise;
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
		expect(notices.map(notice => [notice.reason, notice.from, notice.to])).toEqual([["contested", original, moved]]);
		const onDisk = fs.readFileSync(moved ?? "", "utf8");
		expect(onDisk).toContain('"state":"after"');
		expect(onDisk).toContain('"customType":"concurrent"');
	} finally {
		manager.seal();
		await manager.close().catch(() => {});
	}
});
