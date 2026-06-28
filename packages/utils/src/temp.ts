import * as fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

export class TempDir {
	#path: string;
	private constructor(path: string) {
		this.#path = path;
	}

	static createSync(prefix?: string): TempDir {
		return new TempDir(fs.mkdtempSync(normalizePrefix(prefix)));
	}

	static async create(prefix?: string): Promise<TempDir> {
		return new TempDir(await fsPromises.mkdtemp(normalizePrefix(prefix)));
	}

	#removePromise: Promise<void> | null = null;

	path(): string {
		return this.#path;
	}

	absolute(): string {
		return path.resolve(this.#path);
	}

	remove(): Promise<void> {
		if (this.#removePromise) {
			return this.#removePromise;
		}
		const removePromise = removeWithRetries(this.#path);
		this.#removePromise = removePromise;
		return removePromise;
	}

	removeSync(): void {
		removeSyncWithRetries(this.#path);
		this.#removePromise = Promise.resolve();
	}

	toString(): string {
		return this.#path;
	}

	join(...paths: string[]): string {
		return path.join(this.#path, ...paths);
	}

	async [Symbol.asyncDispose](): Promise<void> {
		try {
			await this.remove();
		} catch {
			// Ignore cleanup errors
		}
	}

	[Symbol.dispose](): void {
		try {
			this.removeSync();
		} catch {
			// Ignore cleanup errors
		}
	}
}

const kTempDir = os.tmpdir();

function normalizePrefix(prefix?: string): string {
	if (!prefix) {
		return `${kTempDir}${path.sep}pi-temp-`;
	} else if (prefix.startsWith("@")) {
		return path.join(kTempDir, prefix.slice(1));
	}
	return prefix;
}

const kRemoveOptions = { recursive: true, force: true } as const;
const kRemoveRetries = 40;
// 50ms × 40 retries = 2s total retry window. Windows holds file locks on
// SQLite DBs for up to ~1.5s after close(); the previous 25ms (1s total)
// was too short for some test cleanup scenarios.
const kRemoveRetryDelayMs = 50;
const kRetryableRemoveErrorCodes = new Set(["EBUSY", "EPERM", "ENOTEMPTY"]);
const kSleepBuffer = new Int32Array(new SharedArrayBuffer(4));

/** Removes a path recursively, retrying transient Windows deletion failures. */
export async function removeWithRetries(target: string): Promise<void> {
	for (let attempt = 0; ; attempt++) {
		try {
			await fsPromises.rm(target, kRemoveOptions);
			return;
		} catch (err) {
			if (!shouldRetryRemove(err, attempt)) throw err;
			await Bun.sleep(kRemoveRetryDelayMs);
		}
	}
}

export function removeSyncWithRetries(target: string): void {
	for (let attempt = 0; ; attempt++) {
		try {
			fs.rmSync(target, kRemoveOptions);
			return;
		} catch (err) {
			if (!shouldRetryRemove(err, attempt)) throw err;
			sleepSync(kRemoveRetryDelayMs);
		}
	}
}

function shouldRetryRemove(err: unknown, attempt: number): boolean {
	return attempt < kRemoveRetries && process.platform === "win32" && isRetryableRemoveError(err);
}

function isRetryableRemoveError(err: unknown): boolean {
	return (
		typeof err === "object" &&
		err !== null &&
		"code" in err &&
		typeof err.code === "string" &&
		kRetryableRemoveErrorCodes.has(err.code)
	);
}

function sleepSync(ms: number): void {
	if ("sleepSync" in Bun && typeof Bun.sleepSync === "function") {
		Bun.sleepSync(ms);
		return;
	}
	Atomics.wait(kSleepBuffer, 0, 0, ms);
}
