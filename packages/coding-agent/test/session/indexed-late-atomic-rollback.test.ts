/**
 * F1 late-rollback repro (holds for HOLD finding 1 on 48642f8432).
 *
 * `writeTextAtomic` settles its backend failure OUTSIDE the path queue: the
 * catch awaits `backend.readFull` after the queued op already rejected. A
 * synchronous write that commits while that readback is parked drops its own
 * frame on success, so when the old readback settles only the old frame
 * remains and `#failFrame` restores the pre-A snapshot over the newer
 * durable index. `statSync` then describes a body the backend no longer
 * holds, and a guarded follow-up keyed on the durable size is rejected.
 *
 * Settler schedule: reject atomic A, gate A's readFull, publish
 * different-sized sync B and await B's confirmWrites, release A's readback
 * (which now observes B). The backend and `statSync` must still describe B
 * and a guarded follow-up replacement must succeed.
 */

import { describe, expect, it } from "bun:test";
import {
	IndexedSessionStorage,
	type SessionStorageBackend,
	type SessionStorageIndexEntry,
} from "@oh-my-pi/pi-coding-agent/session/indexed-session-storage";

function deferred<T = void>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>(r => {
		resolve = r;
	});
	return { promise, resolve };
}

/** Minimal backend with a gateable `readFull` and one-shot write failures. */
class GatedBackend implements SessionStorageBackend {
	readonly files = new Map<string, string>();
	failWrites = 0;
	gateReadFull = false;
	readonly writeFullAttempted = deferred();
	readonly readFullGated = deferred();
	#readGate = deferred();
	#readGateOpen = false;

	async init(): Promise<void> {}

	async loadIndex(): Promise<SessionStorageIndexEntry[]> {
		return [...this.files].map(([path, content]) => ({
			path,
			size: Buffer.byteLength(content, "utf8"),
			mtimeMs: 0,
		}));
	}

	async readFull(path: string): Promise<string | null> {
		if (this.gateReadFull) {
			this.readFullGated.resolve();
			await this.#readGate.promise;
		}
		return this.files.get(path) ?? null;
	}

	releaseReadFull(): void {
		if (!this.#readGateOpen) {
			this.#readGateOpen = true;
			this.#readGate.resolve();
		}
	}

	async readSlices(path: string, prefixBytes: number, suffixBytes: number): Promise<[string, string]> {
		const bytes = Buffer.from(this.files.get(path) ?? "", "utf8");
		return [
			bytes.subarray(0, prefixBytes).toString("utf8"),
			suffixBytes > 0 ? bytes.subarray(Math.max(0, bytes.length - suffixBytes)).toString("utf8") : "",
		];
	}

	async append(path: string, line: string): Promise<void> {
		this.files.set(path, (this.files.get(path) ?? "") + line);
	}

	async writeFull(
		path: string,
		content: string,
		_mtimeMs: number,
		_title?: unknown,
		expectedSize?: number | null,
	): Promise<void> {
		this.writeFullAttempted.resolve();
		if (this.failWrites > 0) {
			this.failWrites -= 1;
			throw new Error("transient backend write failure");
		}
		const current = this.files.get(path) ?? null;
		const actualSize = current === null ? null : Buffer.byteLength(current, "utf8");
		if (expectedSize !== undefined && actualSize !== expectedSize) {
			throw new Error(`backend conflict for ${path}: expected ${expectedSize}, found ${actualSize}`);
		}
		this.files.set(path, content);
	}

	async updateSessionTitle(_path: string, _title: unknown, _mtimeMs: number): Promise<void> {}

	async truncate(path: string, _mtimeMs: number): Promise<void> {
		this.files.set(path, "");
	}

	async remove(paths: string[]): Promise<void> {
		for (const path of paths) this.files.delete(path);
	}

	async move(src: string, dst: string, _mtimeMs: number): Promise<void> {
		const content = this.files.get(src);
		if (content === undefined) throw new Error(`ENOENT: ${src}`);
		this.files.delete(src);
		this.files.set(dst, content);
	}
}

describe("late atomic rollback preserves a newer durable write", () => {
	it("keeps B durable when A's gated readback settles after B commits", async () => {
		const backend = new GatedBackend();
		const storage = new IndexedSessionStorage(backend);
		await storage.initialize();
		const path = "session.jsonl";
		const base = "base-line\n";
		storage.writeTextSync(path, base);
		await storage.drain();
		const baseSize = Buffer.byteLength(base, "utf8");

		backend.failWrites = 1;
		backend.gateReadFull = true;
		const atomic = storage.writeTextAtomic(path, "atomic-A-body\n", { expectedSize: baseSize });
		await backend.writeFullAttempted.promise;
		await backend.readFullGated.promise;

		const bBody = "B-replacement-with-a-different-size\n";
		storage.writeTextSync(path, bBody);
		await storage.confirmWrites(path);
		backend.releaseReadFull();
		await expect(atomic).rejects.toThrow("transient backend write failure");

		const bSize = Buffer.byteLength(bBody, "utf8");
		expect(backend.files.get(path)).toBe(bBody);
		expect(storage.statSync(path).size).toBe(bSize);
		storage.writeTextSync(path, "C\n", { expectedSize: bSize });
	});
});
