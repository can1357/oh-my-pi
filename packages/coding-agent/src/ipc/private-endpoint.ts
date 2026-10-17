/**
 * Owner-private local IPC helpers shared by the Collab registry and the
 * session host registry: private directories, endpoint files, atomic 0600 JSON
 * writes, token comparison, liveness probes. Endpoint paths come from the
 * native `ipcEndpoint`.
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import { IpcConnection } from "@oh-my-pi/pi-natives";
import { hasFsCode } from "@oh-my-pi/pi-utils";
import { withFileLock } from "@oh-my-pi/pi-utils/file-lock";

export function tokenMatches(expected: string, presented: unknown): boolean {
	if (typeof presented !== "string") return false;
	const a = Buffer.from(expected, "utf8");
	const b = Buffer.from(presented, "utf8");
	if (a.length !== b.length) return false;
	return crypto.timingSafeEqual(a, b);
}

export function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/**
 * The directory must be a real directory; POSIX also verifies its owner.
 * Both publication and listing check this: listing prunes malformed
 * entries, so following a symlink into an unrelated directory would let a
 * planted link turn a list command into a deletion tool.
 */
export async function assertPrivateDir(dir: string, label: string): Promise<fs.Stats | null> {
	const stat = await fs.promises.lstat(dir);
	if (stat.isSymbolicLink()) throw new Error(`${label} directory is a symlink: ${dir}`);
	if (!stat.isDirectory()) throw new Error(`${label} path is not a directory: ${dir}`);
	if (process.platform === "win32") return null;
	const uid = process.getuid?.();
	if (uid !== undefined && stat.uid !== uid) {
		throw new Error(`${label} directory is not owned by the current user: ${dir}`);
	}
	return stat;
}

/**
 * Create the directory with owner-only POSIX permissions. Windows retains
 * the config root's ACL. `mkdir` with a mode leaves an
 * existing directory's permissions alone, so an already-present directory is
 * tightened explicitly; a symlink or a directory owned by another user is
 * refused rather than published into.
 */
export async function ensurePrivateDir(dir: string, label: string): Promise<void> {
	await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
	const stat = await assertPrivateDir(dir, label);
	if (stat && (stat.mode & 0o077) !== 0) await fs.promises.chmod(dir, 0o700);
}

/**
 * Unix files an endpoint leaves on disk: the socket and the native listener's
 * `<socket>.bind.lock`. Endpoint names are unique per publication, so no other
 * binder can contend for that lock and unlinking it is race-free.
 */
export function endpointFiles(endpoint: string): string[] {
	return process.platform === "win32" ? [] : [endpoint, `${endpoint}.bind.lock`];
}

/** Best-effort synchronous unlink; a survivor is pruned by the next list. */
export function removeFilesSync(files: string[]): void {
	for (const file of files) {
		try {
			fs.rmSync(file, { force: true });
		} catch {
			// Best-effort.
		}
	}
}

/**
 * Exclusive-create `${target}.<rand>.tmp` with mode 0600, write, rename over
 * `target`, so a concurrent list never observes a partial file (it would
 * classify the entry as malformed and prune it). The temp suffix keeps it
 * outside a `*.json` listing filter; the random part keeps concurrent
 * rewrites of one entry from colliding. Any failure after the exclusive create
 * removes the temp file again.
 *
 * Windows refuses a rename over a target that another writer is replacing or a
 * reader holds open (EPERM). Writers of one target are serialized there, and
 * the rename is retried with backoff while a reader holds the file. The rename
 * stays direct: moving the old file aside first would let a concurrent list
 * see the entry missing and treat a live host as gone.
 */
export async function writePrivateJson(target: string, value: unknown): Promise<void> {
	const write = async (): Promise<void> => {
		const tmpPath = `${target}.${crypto.randomBytes(4).toString("hex")}.tmp`;
		const handle = await fs.promises.open(tmpPath, "wx", 0o600);
		try {
			try {
				await handle.writeFile(JSON.stringify(value), "utf8");
			} finally {
				await handle.close();
			}
			await renameOverReaders(tmpPath, target);
		} catch (err) {
			fs.rmSync(tmpPath, { force: true });
			throw err;
		}
	};
	if (process.platform === "win32") {
		await withFileLock(target, write);
		return;
	}
	await write();
}

// ponytail: 20 attempts with 2..50 ms backoff, about 0.8 s in all. A Windows
// probe with a reader re-reading the file in a tight loop needed at most 8
// attempts (171 ms); raise the cap if a slower reader exhausts it.
const RENAME_ATTEMPTS = 20;

async function renameOverReaders(source: string, target: string): Promise<void> {
	for (let attempt = 1; ; attempt++) {
		try {
			await fs.promises.rename(source, target);
			return;
		} catch (err) {
			const transient = hasFsCode(err, "EPERM") || hasFsCode(err, "EACCES") || hasFsCode(err, "EBUSY");
			if (process.platform !== "win32" || !transient || attempt >= RENAME_ATTEMPTS) throw err;
			await Bun.sleep(Math.min(2 ** attempt, 50));
		}
	}
}

/**
 * Connect and immediately close. Endpoints die with their host process: a
 * refused or missing socket means the host is gone ("dead"). Any other error
 * (EMFILE, EACCES, ETIMEDOUT, …) says nothing about liveness ("unknown") and
 * must not prune a live host.
 */
export async function probeEndpoint(endpoint: string, timeoutMs: number): Promise<"alive" | "dead" | "unknown"> {
	try {
		(await IpcConnection.connect(endpoint, { framing: "raw", timeoutMs })).destroy();
		return "alive";
	} catch (err) {
		return hasFsCode(err, "ENOENT") || hasFsCode(err, "ECONNREFUSED") ? "dead" : "unknown";
	}
}
