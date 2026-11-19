/**
 * `flush()` must never call anything that re-acquires
 * `#withAtomicPersistenceLock` while it is itself running under that lock.
 * `appendEntriesAtomically()` holds the lock for its whole duration (via
 * `#withAtomicPersistenceLock`) and calls `flush()` as part of that; if
 * `flush()` then calls `recoverPersistenceFromCurrentState()` (a second
 * `#withAtomicPersistenceLock` acquisition) before the outer call has
 * returned, the outer turn can never resolve because it is waiting on the
 * inner one, and the inner one can never get a turn because the outer one
 * has not released the lock -- a straightforward reentrant deadlock, not a
 * race that resolves on its own.
 *
 * This only requires: `#diskFailure` becomes true strictly between
 * `flush()`'s writer-flush step and the point after its `drain()` call
 * settles, without either of those two steps' own awaited promises
 * rejecting. A backend that reports an out-of-band durability failure via
 * the writer's `onError` hook -- independent of any specific `flush()` or
 * `drain()` call's own promise -- produces exactly that shape. The fake
 * storage below drives that ordering with explicit gates (resolved once
 * `drain()` is actually entered, then released once the failure has fired)
 * instead of a guessed wall-clock delay.
 */

import { describe, expect, it } from "bun:test";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	SessionWriteConflictError,
	type SessionStorage,
	type SessionStorageStat,
	type SessionStorageWriteOptions,
	type SessionStorageWriter,
	type WriteTextAtomicOptions,
} from "@oh-my-pi/pi-coding-agent/session/session-storage";

/**
 * Minimal in-memory `SessionStorage` whose `openWriter()` captures the
 * manager's `onError` hook so a test can fire it deterministically, and
 * whose `drain()` exposes a gate so a test can hold it open until the
 * failure has fired -- decoupled from every other method's own promise,
 * matching the interface's `onError` option (a background failure reported
 * out-of-band, not through the call whose result observed it).
 */
class BackgroundFailureStorage implements SessionStorage {
	readonly #files = new Map<string, string>();
	#onError: ((err: Error) => void) | undefined;
	readonly #drainEntered = Promise.withResolvers<void>();
	readonly #drainRelease = Promise.withResolvers<void>();
	readonly drainEntered = this.#drainEntered.promise;

	fireBackgroundFailure(): void {
		this.#onError?.(new Error("background durability failure"));
	}

	releaseDrain(): void {
		this.#drainRelease.resolve();
	}

	ensureDirSync(): void {}

	existsSync(path: string): boolean {
		return this.#files.has(path);
	}

	writeTextSync(path: string, content: string, options?: SessionStorageWriteOptions): void {
		const actualSize = this.#files.has(path) ? Buffer.byteLength(this.#files.get(path) ?? "", "utf8") : null;
		if (options?.expectedSize !== undefined && actualSize !== options.expectedSize) {
			throw new SessionWriteConflictError(path, options.expectedSize, actualSize);
		}
		this.#files.set(path, content);
	}

	async updateSessionTitle(): Promise<void> {}

	statSync(path: string): SessionStorageStat {
		const content = this.#files.get(path);
		if (content === undefined) throw new Error(`File not found: ${path}`);
		return { size: Buffer.byteLength(content, "utf8"), mtimeMs: Date.now(), mtime: new Date() };
	}

	listFilesSync(): string[] {
		return [];
	}

	async exists(path: string): Promise<boolean> {
		return this.existsSync(path);
	}

	async readText(path: string): Promise<string> {
		const content = this.#files.get(path);
		if (content === undefined) throw new Error(`File not found: ${path}`);
		return content;
	}

	async readTextSlices(path: string): Promise<[string, string]> {
		return [this.#files.get(path) ?? "", ""];
	}

	async writeText(path: string, content: string): Promise<void> {
		this.writeTextSync(path, content);
	}

	async writeTextAtomic(path: string, content: string, options?: WriteTextAtomicOptions): Promise<void> {
		if (options?.commitGuard && !options.commitGuard()) return;
		this.writeTextSync(path, content, { expectedSize: options?.expectedSize });
	}

	async rename(path: string, nextPath: string): Promise<void> {
		const content = this.#files.get(path);
		if (content === undefined) throw new Error(`File not found: ${path}`);
		this.#files.delete(path);
		this.#files.set(nextPath, content);
	}

	async unlink(path: string): Promise<void> {
		this.#files.delete(path);
	}

	async deleteSessionWithArtifacts(): Promise<void> {}

	openWriter(_path: string, options?: { flags?: "a" | "w"; onError?: (err: Error) => void }): SessionStorageWriter {
		this.#onError = options?.onError;
		let closed = false;
		return {
			appendSync: () => {},
			append: async () => {},
			flush: async () => {},
			isOpen: () => !closed,
			close: async () => {
				closed = true;
			},
			getError: () => undefined,
		};
	}

	async drain(): Promise<void> {
		this.#drainEntered.resolve();
		await this.#drainRelease.promise;
	}
}

function assistantMessage(text: string) {
	return {
		role: "assistant" as const,
		provider: "anthropic",
		model: "claude-3-7-sonnet",
		content: [{ type: "text" as const, text }],
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { total: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		},
		api: "anthropic-messages" as const,
		stopReason: "stop" as const,
		timestamp: Date.now(),
	};
}

/**
 * A genuine reentrant-lock deadlock never settles, by construction -- no
 * amount of waiting resolves a promise cycle where each side awaits the
 * other's turn. Draining a bounded number of microtask turns distinguishes
 * that from ordinary async resolution without guessing at a wall-clock
 * delay: the passing path below settles within a handful of turns, and a
 * deadlocked one is still pending after every turn in the budget.
 */
async function settlesWithinMicrotaskBudget(promise: Promise<unknown>, turns: number): Promise<boolean> {
	let settled = false;
	void promise.then(
		() => {
			settled = true;
		},
		() => {
			settled = true;
		},
	);
	for (let i = 0; i < turns && !settled; i++) await Promise.resolve();
	return settled;
}

describe("SessionManager.flush() and the atomic persistence lock", () => {
	it("does not deadlock a concurrent appendEntriesAtomically() when a disk failure lands mid-drain", async () => {
		const storage = new BackgroundFailureStorage();
		const manager = SessionManager.create("/cwd", "/sessions/proj", storage);

		// Materialize the file (non-deferred write) so it is fully current.
		manager.appendMessage(assistantMessage("first"));
		expect(manager.captureState().onDisk).toBe(true);

		// Open the append writer -- and so capture its `onError` hook -- via an
		// ordinary hot-path append, exactly as a live turn loop would.
		manager.appendCustomEntry("marker", {});

		const appendPromise = manager
			.appendEntriesAtomically(() => manager.appendCustomEntry("probe", {}))
			.then(
				() => "settled" as const,
				() => "settled" as const,
			);

		// Let flush() actually reach drain() before firing the failure, so the
		// ordering is exact rather than guessed: the failure lands while
		// drain() is outstanding, and drain() itself still resolves cleanly
		// once released.
		await storage.drainEntered;
		storage.fireBackgroundFailure();
		storage.releaseDrain();

		expect(await settlesWithinMicrotaskBudget(appendPromise, 500)).toBe(true);
	});
});
