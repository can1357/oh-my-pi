/**
 * Regression for the "Writer closed" race between `SessionManager.close()`
 * and a concurrent `appendMessage()`.
 *
 * Repro shape (pre-fix):
 *   1. `close()` queues `#closePersistWriterInternal()` on the persist chain.
 *   2. The task runs and awaits `#persistWriter.close()`, which sets `#closing
 *      = true` synchronously before yielding on `flush()` / its inner writer
 *      `close()`.
 *   3. A synchronous `appendMessage()` lands in the yield window. `_persist`
 *      reaches the hot path, `#ensurePersistWriter()` returns the still-cached
 *      (but now closing) writer, and `writeSync` throws `Error("Writer closed")`.
 *   4. The throw is captured into `#persistError`. The next async caller
 *      (`flush()` or a later `appendMessage()`) re-throws it, producing an
 *      unhandled rejection with the original line-1282 stack.
 *
 * Fix: `NdjsonFileWriter.isOpen()` is consulted; mid-close writers cause
 * `_persist` to route the entry through the async `#rewriteFile()` cold path.
 *
 * To pin the race deterministically, the test wraps `MemorySessionStorage`
 * and parks every underlying writer `close()` on a deferred. The race window
 * opens the moment `NdjsonFileWriter.close()` flips `#closing = true` and
 * yields on its inner writer `close()` — which is our parked promise.
 */

import { describe, expect, it } from "bun:test";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	MemorySessionStorage,
	type SessionStorage,
	type SessionStorageWriter,
	type WriteTextAtomicOptions,
} from "@oh-my-pi/pi-coding-agent/session/session-storage";
import type { SessionTitleUpdate } from "@oh-my-pi/pi-coding-agent/session/session-title-slot";

class CloseHoldingStorage implements SessionStorage {
	readonly #inner = new MemorySessionStorage();
	readonly #closeGates: Array<PromiseWithResolvers<void>> = [];

	openWriter(path: string, options?: { flags?: "a" | "w"; onError?: (err: Error) => void }): SessionStorageWriter {
		const inner = this.#inner.openWriter(path, options);
		const gates = this.#closeGates;
		return {
			append(line) {
				return inner.append(line);
			},
			flush() {
				return inner.flush();
			},
			isOpen() {
				return inner.isOpen();
			},
			async close() {
				const gate = Promise.withResolvers<void>();
				gates.push(gate);
				await gate.promise;
				return inner.close();
			},
			getError() {
				return inner.getError();
			},
		};
	}

	releaseNextClose(): boolean {
		const next = this.#closeGates.shift();
		if (!next) return false;
		next.resolve();
		return true;
	}

	hasPendingClose(): boolean {
		return this.#closeGates.length > 0;
	}

	// Delegate the rest of the SessionStorage surface to the in-memory impl.
	ensureDirSync(dir: string): void {
		this.#inner.ensureDirSync(dir);
	}
	existsSync(p: string): boolean {
		return this.#inner.existsSync(p);
	}
	writeTextSync(p: string, content: string): void {
		this.#inner.writeTextSync(p, content);
	}
	updateSessionTitle(p: string, title: SessionTitleUpdate): Promise<void> {
		return this.#inner.updateSessionTitle(p, title);
	}
	statSync(p: string) {
		return this.#inner.statSync(p);
	}
	listFilesSync(dir: string, pattern: string): string[] {
		return this.#inner.listFilesSync(dir, pattern);
	}
	exists(p: string): Promise<boolean> {
		return this.#inner.exists(p);
	}
	readText(p: string): Promise<string> {
		return this.#inner.readText(p);
	}
	readTextSlices(p: string, prefixBytes: number, suffixBytes: number): Promise<[string, string]> {
		return this.#inner.readTextSlices(p, prefixBytes, suffixBytes);
	}
	writeText(p: string, content: string): Promise<void> {
		return this.#inner.writeText(p, content);
	}
	writeTextAtomic(p: string, content: string, options?: WriteTextAtomicOptions): Promise<void> {
		return this.#inner.writeTextAtomic(p, content, options);
	}
	rename(p: string, nextPath: string): Promise<void> {
		return this.#inner.rename(p, nextPath);
	}
	unlink(p: string): Promise<void> {
		return this.#inner.unlink(p);
	}
	deleteSessionWithArtifacts(sessionPath: string): Promise<void> {
		return this.#inner.deleteSessionWithArtifacts(sessionPath);
	}
	drain(): Promise<void> {
		return this.#inner.drain();
	}
}

/** Drive microtasks while releasing every parked close until `promise` settles. */
async function settle<T>(promise: Promise<T>, storage: CloseHoldingStorage): Promise<T> {
	let done = false;
	let value: T | undefined;
	let error: unknown;
	promise.then(
		v => {
			value = v;
			done = true;
		},
		e => {
			error = e;
			done = true;
		},
	);
	for (let safety = 0; safety < 1000; safety++) {
		if (done) break;
		storage.releaseNextClose();
		await Promise.resolve();
	}
	if (!done) throw new Error("settle() did not converge — promise stayed pending");
	if (error) throw error;
	return value as T;
}

describe("SessionManager close/appendMessage race", () => {
	it("appendMessage during in-flight close() does not stash a persistError", async () => {
		const storage = new CloseHoldingStorage();
		const sm = SessionManager.create("/cwd", "/sessions", storage);
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected built-in anthropic model to exist");

		// Seed an assistant message so persist activates (the `#ensuredOnDisk`
		// guard gates the first write on the first assistant entry). This
		// first append takes the cold `#rewriteFile` path.
		sm.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "hello" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		});
		await settle(sm.flush(), storage);

		// Drive a hot-path append so `#ensurePersistWriter()` instantiates and
		// caches `#persistWriter`. The first assistant write took the cold
		// `#rewriteFile` path (which leaves no cached writer); only after
		// `#flushed = true` does a subsequent append open the hot writeSync
		// path that the race relies on.
		sm.appendMessage({
			role: "user",
			content: "prime",
			timestamp: Date.now(),
		});
		// `appendMessage` is sync; hot-path writeSync already ran. No queued
		// task to settle, but flushing the writer is still wise — it leaves
		// `#persistWriter` cached and ready for the close-race window.
		await settle(sm.flush(), storage);

		// Start close — its inner writer.close() parks on our gate. The
		// outer NdjsonFileWriter.close() has already flipped `#closing = true`
		// synchronously by the time the gate is hit.
		const closePromise = sm.close();
		// Spin microtasks until the parked close shows up.
		for (let i = 0; i < 200; i++) {
			if (storage.hasPendingClose()) break;
			await Promise.resolve();
		}
		expect(storage.hasPendingClose()).toBe(true);

		// Synchronous append in the yield window — must not record a
		// persistError. Pre-fix this stashes Error("Writer closed").
		expect(() => {
			sm.appendMessage({
				role: "user",
				content: "during-close",
				timestamp: Date.now(),
			});
		}).not.toThrow();

		const sessionFile = sm.getSessionFile();
		if (!sessionFile) throw new Error("Expected session file");
		const duringCloseContent = await storage.readText(sessionFile);
		expect(duringCloseContent).toContain('"content":"during-close"');

		// Drain everything.
		await settle(closePromise, storage);
		// Pre-fix `flush()` rejects with the stashed Error("Writer closed").
		await expect(settle(sm.flush(), storage)).resolves.toBeUndefined();

		// And a subsequent append on the same SessionManager must remain
		// healthy — pre-fix the persistError sentinel turns this into a
		// synchronous re-throw at `_persist`'s entry guard.
		expect(() => {
			sm.appendMessage({
				role: "user",
				content: "after-close",
				timestamp: Date.now(),
			});
		}).not.toThrow();
		await expect(settle(sm.flush(), storage)).resolves.toBeUndefined();
	});
});
