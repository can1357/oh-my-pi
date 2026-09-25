import { describe, expect, it } from "bun:test";
import {
	IndexedSessionStorage,
	type SessionStorageBackend,
	type SessionStorageIndexEntry,
} from "@oh-my-pi/pi-coding-agent/session/indexed-session-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";

/**
 * Backend that accepts every lookup but fails the fire-and-forget publish.
 * `IndexedSessionStorage.writeTextSync` records this failure in `#firstDrainError`
 * and surfaces it only when `drain()` rejects — the Redis/SQL headless condition
 * behind upstream thread 3979817568.
 */
class FailingPublishBackend implements SessionStorageBackend {
	readonly failure = new Error("backend publish failed");

	init(): Promise<void> {
		return Promise.resolve();
	}

	loadIndex(): Promise<Iterable<SessionStorageIndexEntry>> {
		return Promise.resolve([]);
	}

	readFull(): Promise<string | null> {
		return Promise.resolve(null);
	}

	readSlices(): Promise<[string, string]> {
		return Promise.resolve(["", ""]);
	}

	writeFull(): Promise<void> {
		return Promise.reject(this.failure);
	}

	append(): Promise<void> {
		return Promise.resolve();
	}

	updateSessionTitle(): Promise<void> {
		return Promise.resolve();
	}

	truncate(): Promise<void> {
		return Promise.resolve();
	}

	remove(): Promise<void> {
		return Promise.resolve();
	}

	move(): Promise<void> {
		return Promise.resolve();
	}
}

async function createManagerWithFailingPublish(): Promise<{
	backend: FailingPublishBackend;
	storage: IndexedSessionStorage;
	manager: SessionManager;
}> {
	const backend = new FailingPublishBackend();
	const storage = new IndexedSessionStorage(backend);
	await storage.initialize();
	const manager = SessionManager.create("/cwd", "/sessions", storage);
	return { backend, storage, manager };
}

describe("SessionManager persistence latch on drain-only failures", () => {
	it("latches a close() drain failure and notifies observers before rejecting", async () => {
		const { backend, storage, manager } = await createManagerWithFailingPublish();

		const observed: Error[] = [];
		manager.onPersistenceError(error => observed.push(error));

		// A real fire-and-forget publish recorded by `writeTextSync`; its rejection
		// stays invisible until `close()` drains the storage.
		storage.writeTextSync("/sessions/headless.jsonl", '{"type":"session"}\n');

		await expect(manager.close()).rejects.toBe(backend.failure);
		expect(observed).toEqual([backend.failure]);
	});

	it("latches a flush() drain failure and notifies observers before rejecting", async () => {
		const { backend, storage, manager } = await createManagerWithFailingPublish();

		const observed: Error[] = [];
		manager.onPersistenceError(error => observed.push(error));

		storage.writeTextSync("/sessions/headless.jsonl", '{"type":"session"}\n');

		await expect(manager.flush()).rejects.toBe(backend.failure);
		expect(observed).toEqual([backend.failure]);
	});
});
