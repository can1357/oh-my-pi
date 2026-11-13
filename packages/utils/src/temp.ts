import * as fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Owned temporary directory, removed via `remove()` or `using`/`await using`.
 *
 * Prefixes follow `mkdtemp`: `"@name-"` creates under the OS temp dir, any other
 * prefix is a path (a bare `"name-"` lands in the process cwd), and no prefix
 * means `"@pi-temp-"`.
 */
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

/**
 * `<os temp>/omp-<uid>`, the single directory omp keeps its own temp paths in.
 *
 * A shared `/tmp` then holds one entry per user instead of one per run, and
 * `rm -rf "$TMPDIR/omp-<uid>"` clears everything omp left behind. The suffix is
 * the user id wherever the platform has one: a bare `omp` in a world-writable
 * directory is a name another user can create first, and a directory or symlink
 * they own is one they can read from, swap, or point elsewhere. macOS and
 * Windows already hand each user a private temp directory, so the suffix is
 * only added where `getuid` exists.
 *
 * The directory is created 0700 on first use and an existing one is checked:
 * anything that is not a directory this user owns, or that others can read, is
 * refused rather than written through. New temp paths belong under
 * {@link tempSubpath} / {@link mkdtempInTempRoot} rather than beside it.
 */
export function getTempRoot(): string {
	// `os.tmpdir()` is re-read per call: tests swap TMPDIR mid-process and the
	// staging paths must follow it. It is also resolved, because TMPDIR may be
	// relative and a temp path that moves under `chdir` is not a temp path.
	const root = path.join(path.resolve(os.tmpdir()), tempRootLeaf());
	ensureOwnedDirectory(root);
	return root;
}

/** The root's leaf name: `omp-<uid>` where the user id is available, else `omp`. */
function tempRootLeaf(): string {
	const uid = process.getuid?.();
	return uid === undefined ? "omp" : `omp-${uid}`;
}

/**
 * Create `dir` (0700) or confirm the existing one is a directory this user owns
 * and that nobody else can read.
 *
 * The path is derived from the environment, so this check is the difference
 * between a private staging area and one another user chose: a symlink, a
 * regular file, or a directory owned by someone else is an error rather than
 * something to write into.
 */
function ensureOwnedDirectory(dir: string): void {
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	const stats = fs.lstatSync(dir);
	if (!stats.isDirectory()) throw new Error(`The temp directory ${dir} is not a directory`);
	const uid = process.getuid?.();
	if (uid !== undefined && stats.uid !== uid) {
		throw new Error(`The temp directory ${dir} belongs to another user`);
	}
	if ((stats.mode & 0o077) !== 0) fs.chmodSync(dir, 0o700);
}

/** Joins leaf segments below `getTempRoot()`; leaves carry no `omp-` prefix. */
export function tempSubpath(...segments: string[]): string {
	return path.join(getTempRoot(), ...segments);
}

/** `mkdtemp` below `getTempRoot()`. */
export function mkdtempInTempRootSync(prefix: string): string {
	return fs.mkdtempSync(path.join(getTempRoot(), prefix));
}

/** Async `mkdtempInTempRootSync`. */
export async function mkdtempInTempRoot(prefix: string): Promise<string> {
	return fsPromises.mkdtemp(path.join(getTempRoot(), prefix));
}

/**
 * `mkdtemp`-style prefix to a real one: no prefix means the temp root, a
 * `@name-` prefix means the temp root too (the `@` marks "omp's own, clean it
 * up"), and any other prefix is the path the caller named.
 */
function normalizePrefix(prefix?: string): string {
	if (!prefix) return path.join(getTempRoot(), "pi-temp-");
	if (prefix.startsWith("@")) return path.join(getTempRoot(), prefix.slice(1));
	return prefix;
}

const kRemoveOptions = { recursive: true, force: true } as const;
const kRemoveRetries = 40;
// 50ms × 40 retries = 2s total retry window. Windows holds file locks on
// SQLite DBs for up to ~1.5s after close(); the previous 25ms (1s total)
// was too short for some test cleanup scenarios.
const kRemoveRetryDelayMs = 50;
const kRetryableRemoveErrorCodes = new Set(["EBUSY", "EPERM", "ENOTEMPTY"]);

/** Removes a path recursively, retrying transient Windows deletion failures. */
export async function removeWithRetries(target: string): Promise<void> {
	for (let attempt = 0; ; attempt++) {
		try {
			await fsPromises.rm(target, kRemoveOptions);
			return;
		} catch (err) {
			if (!shouldRetryRemove(err, attempt)) throw err;
			// bun on Windows finalizes SQLite's db/-wal/-shm file and directory
			// handles on GC, so a closed database can still block deletion for
			// seconds. One forced major collection on the first retry releases
			// them immediately instead of burning the retry window.
			if (attempt === 0) Bun.gc(true);
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
			if (attempt === 0) Bun.gc(true);
			Bun.sleepSync(kRemoveRetryDelayMs);
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
