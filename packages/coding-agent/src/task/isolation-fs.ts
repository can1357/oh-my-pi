/**
 * The whole filesystem surface the isolation path is allowed to touch.
 *
 * Reads come from `isolation-lookup` and answer `found` | `absent` |
 * `unknown`. Writes are here, and they are the operations that either happen
 * or raise — there is no third answer to swallow. Together they are why the
 * modules that decide whether a workspace may be deleted import no
 * filesystem API of their own.
 */

import { type BigIntStats, constants, type FSWatcher, watch as nodeWatch } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils";
import { reasonOf } from "./isolation-lookup";

export {
	ABSENT,
	FOUND,
	type Lookup,
	lstatLookup,
	readdirLookup,
	readdirTypedLookup,
	readJsonLookup,
	readTextLookup,
	realpathLookup,
	reasonOf,
	requireFound,
	statLookup,
	UNKNOWN,
} from "./isolation-lookup";

// Forwarded rather than re-bound: the call resolves the underlying function
// when it runs, so a test that replaces one still intercepts the isolation
// path's use of it.

/** Create a directory. `recursive` makes an existing one acceptable. */
export const mkdir = ((...args: Parameters<typeof fs.mkdir>) => fs.mkdir(...args)) as typeof fs.mkdir;
/** Move a path. One syscall: it either happened under the caller's hold or it did not. */
export const rename = ((...args: Parameters<typeof fs.rename>) => fs.rename(...args)) as typeof fs.rename;
/** Remove a path. */
export const rm = ((...args: Parameters<typeof fs.rm>) => fs.rm(...args)) as typeof fs.rm;
/** Copy a tree. */
export const cp = ((...args: Parameters<typeof fs.cp>) => fs.cp(...args)) as typeof fs.cp;
/** Write a file's whole contents. */
export const writeFile = ((...args: Parameters<typeof fs.writeFile>) => fs.writeFile(...args)) as typeof fs.writeFile;

/**
 * Watch a directory.
 *
 * A notification channel, not a read: it answers "something changed", never
 * "nothing is there", so it cannot manufacture the absence this subsystem's
 * rule is about. It lives here so the modules that decide deletions need no
 * `node:fs` import of their own — that import carries `promises` and every
 * `*Sync` read with it, which made banning only `node:fs/promises` a bypass
 * one identifier wide.
 */
export const watch = nodeWatch;
export type { FSWatcher };

/**
 * The start time a process reports to `ps`, or `null` when it reports none.
 *
 * A liveness probe, not a filesystem read, but it needs to spawn — and the
 * modules that decide deletions name no process API of their own, so it is
 * here with everything else that talks to the outside.
 */
export async function processStartTime(pid: number): Promise<string | null> {
	const ps = Bun.spawn(["ps", "-o", "lstart=", "-p", String(pid)], { stdout: "pipe", stderr: "ignore" });
	const out = await new Response(ps.stdout).text();
	if ((await ps.exited) !== 0) return null;
	const started = out.trim();
	return started.length > 0 ? started : null;
}

/** A content hash, for a name derived from a path. Reads nothing. */
export function hash(value: string): bigint | number {
	return Bun.hash(value);
}

/** Sleep. Reads nothing; here so the isolation path names no `Bun` of its own. */
export async function sleep(ms: number): Promise<void> {
	await Bun.sleep(ms);
}

/** Write a file's whole contents, creating parent directories. */
export async function writeFileDeep(file: string, contents: string): Promise<void> {
	await Bun.write(file, contents);
}

/**
 * A directory held by what it is, not by where it is.
 *
 * A path names whatever sits there when it is next resolved. A sandbox moved
 * away and replaced — by another run's claimed sandbox, or by a symlink to
 * one — answers to the same name, and a teardown that deleted "the sandbox at
 * this path" deleted the other run's. A pin records the directory's device and
 * inode when the caller proved it its own, and on POSIX keeps a descriptor
 * open on it, so the inode cannot be freed and handed to another directory
 * while the pin is held. Every act on the directory first checks the path
 * against the pin ({@link checkPinnedDirectory}).
 */
export interface DirectoryPin {
	readonly dev: bigint;
	readonly ino: bigint;
	/** Close the descriptor. Safe to call more than once. */
	release(): Promise<void>;
}

/** Pin the directory at `dir`. A symlink, or anything that is not a directory, is refused. */
export async function pinDirectory(dir: string): Promise<DirectoryPin> {
	if (process.platform === "win32") {
		// A held directory handle blocks the rename and the removal on Windows,
		// so the pin there is the identity alone.
		const stat = await fs.lstat(dir, { bigint: true });
		if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`${dir} is not a directory`);
		return { dev: stat.dev, ino: stat.ino, release: async () => {} };
	}
	const handle = await fs.open(dir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
	try {
		const stat = await handle.stat({ bigint: true });
		let released = false;
		return {
			dev: stat.dev,
			ino: stat.ino,
			release: async () => {
				if (released) return;
				released = true;
				await handle.close();
			},
		};
	} catch (error) {
		await handle.close();
		throw error;
	}
}

/**
 * Whether `dir` is, now, the directory `pin` holds: a directory and not a
 * symlink, with the pinned device and inode. Another directory, a symlink,
 * nothing, or a failure to look is a reason — never the pinned directory.
 */
export async function checkPinnedDirectory(
	dir: string,
	pin: DirectoryPin,
): Promise<{ same: true } | { same: false; reason: string }> {
	let stat: BigIntStats;
	try {
		stat = await fs.lstat(dir, { bigint: true });
	} catch (error) {
		return { same: false, reason: reasonOf(error) };
	}
	if (stat.isSymbolicLink()) return { same: false, reason: "it is now a symlink" };
	if (!stat.isDirectory()) return { same: false, reason: "it is no longer a directory" };
	if (stat.dev !== pin.dev || stat.ino !== pin.ino) {
		return { same: false, reason: "another directory now has its name" };
	}
	return { same: true };
}

/**
 * The mount points at `dir` or anywhere under it.
 *
 * A recursive removal walks into a mounted directory as into any other and
 * deletes what the mount projects — another tree's files — before failing on
 * the mount point itself; a backend record can be lost or never written, so
 * the mounts are read at the moment of removal instead.
 *
 * On Linux the kernel's mount table (`/proc/self/mountinfo`) is the answer,
 * because a bind mount of the same filesystem shares its parent's device
 * number and `stat` cannot see it. Off Linux there is no such table in a
 * portable place, so the device number is the signal: a filesystem mounted
 * under `dir` — the one an unprivileged user mounts, a disk image on macOS —
 * has a device number different from `dir`'s, and one mounted at `dir` itself
 * has a device number different from `dir`'s parent's. The copy and clone
 * backends this path removes mount nothing of their own, so either change is
 * always a foreign mount. The walk does not cross such a boundary (it is what
 * we are keeping the removal out of) and does not follow symlinks.
 *
 * Either way an answer that cannot be read raises: an unreadable table or an
 * unreadable directory is not "nothing is mounted". `dir` is matched as given,
 * so callers pass the canonical path.
 */
export async function liveMountsUnder(dir: string): Promise<string[]> {
	if (process.platform === "linux") return linuxMountsUnder(dir);
	const root = await fs.lstat(dir, { bigint: true }).catch((error: unknown) => {
		if (isEnoent(error)) return undefined;
		throw error;
	});
	if (root === undefined || !root.isDirectory()) return [];
	const mounts: string[] = [];
	// The root is a mount point itself when its device differs from its
	// parent's: a filesystem mounted at the sandbox, not below it. Every
	// descendant then shares the root's device, so the walk below could not
	// see it, and a teardown deleted the mounted filesystem's files.
	const parent = path.dirname(dir);
	if (parent !== dir && (await fs.lstat(parent, { bigint: true })).dev !== root.dev) mounts.push(dir);
	await collectDeviceBoundaries(dir, root.dev, mounts);
	return mounts;
}

function linuxMountsUnder(dir: string): Promise<string[]> {
	return fs.readFile("/proc/self/mountinfo", "utf8").then(table => {
		const prefix = dir.endsWith("/") ? dir : `${dir}/`;
		const mounts: string[] = [];
		for (const line of table.split("\n")) {
			const field = line.split(" ")[4];
			if (field === undefined) continue;
			// The kernel octal-escapes space, tab, newline and backslash.
			const mountPoint = field.replace(/\\([0-7]{3})/g, (_, octal: string) =>
				String.fromCharCode(parseInt(octal, 8)),
			);
			if (mountPoint === dir || mountPoint.startsWith(prefix)) mounts.push(mountPoint);
		}
		return mounts;
	});
}

async function collectDeviceBoundaries(dir: string, rootDev: bigint, mounts: string[]): Promise<void> {
	const entries = await fs.readdir(dir, { withFileTypes: true });
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const child = path.join(dir, entry.name);
		const stat = await fs.lstat(child, { bigint: true });
		if (stat.isSymbolicLink() || !stat.isDirectory()) continue;
		if (stat.dev !== rootDev) {
			// A mount boundary: recorded, and not descended into — what is under
			// it belongs to the mounted filesystem, not this tree.
			mounts.push(child);
			continue;
		}
		await collectDeviceBoundaries(child, rootDev, mounts);
	}
}

/** A live process on this host using a directory. */
export interface DirectoryUser {
	pid: number;
	/** The process's command name, as the kernel reports it. */
	command: string;
}

/** Who uses a directory: the answer, or why it could not be found. */
export type DirectoryUsers = { kind: "known"; users: DirectoryUser[] } | { kind: "unknown"; reason: string };

/** Processes inspected at once: enough to read a host with thousands of them in a fraction of a second. */
const PROCESS_SCAN_CONCURRENCY = 128;

/**
 * The live processes on this host whose working directory, an open file or a
 * memory mapping is `dir` or anything under it.
 *
 * A process's death does not end its children: a subprocess a dead worker's
 * shutdown handler started keeps writing, and a capture or a removal that
 * runs under it puts those writes into an unlinked inode. Records saying who
 * is inside cannot see such a process; the kernel can. `dir` is matched as
 * given, so callers pass the canonical path.
 *
 * This process counts like any other, except for descriptors on `dir` itself:
 * those are the pins and locks the caller holds to decide, which write
 * nothing. Linux reads `/proc`; a process this user may not inspect is
 * another user's and is skipped, since it could not be this user's writer.
 * macOS asks `lsof`. Windows answers itself: an open file or a working
 * directory there makes the removal fail rather than unlink under the user.
 * Anywhere else — or when the table cannot be read — the answer is unknown,
 * and callers keep the tree.
 */
export async function processesUsing(dir: string): Promise<DirectoryUsers> {
	switch (process.platform) {
		case "linux":
			return linuxProcessesUsing(dir);
		case "darwin":
			return lsofProcessesUsing(dir);
		case "win32":
			return { kind: "known", users: [] };
		default:
			return { kind: "unknown", reason: `no way to list what uses a directory on ${process.platform}` };
	}
}

function isInside(target: string, dir: string, prefix: string): boolean {
	// A deleted file keeps its old name with this suffix; it is still open.
	const name = target.endsWith(" (deleted)") ? target.slice(0, -" (deleted)".length) : target;
	return name === dir || name.startsWith(prefix);
}

async function linuxProcessesUsing(dir: string): Promise<DirectoryUsers> {
	const prefix = dir.endsWith("/") ? dir : `${dir}/`;
	let entries: string[];
	try {
		entries = (await fs.readdir("/proc")).filter(entry => /^\d+$/.test(entry));
	} catch (error) {
		return { kind: "unknown", reason: `/proc could not be listed (${reasonOf(error)})` };
	}
	const users: DirectoryUser[] = [];
	const inspect = async (entry: string): Promise<void> => {
		const pid = Number(entry);
		const base = `/proc/${entry}`;
		const own = pid === process.pid;
		let uses = false;
		try {
			uses = isInside(await fs.readlink(`${base}/cwd`), dir, prefix);
		} catch {
			// Gone, a zombie, or another user's: none of them is writing here as us.
			return;
		}
		if (!uses) {
			const fds = await fs.readdir(`${base}/fd`).catch(() => [] as string[]);
			const targets = await Promise.all(fds.map(fd => fs.readlink(`${base}/fd/${fd}`).catch(() => "")));
			uses = targets.some(target => isInside(target, dir, prefix) && !(own && target === dir));
		}
		if (!uses) {
			const maps = await fs.readFile(`${base}/maps`, "utf8").catch(() => "");
			uses = maps.split("\n").some(line => {
				const at = line.indexOf("/");
				return at >= 0 && isInside(line.slice(at), dir, prefix);
			});
		}
		if (!uses) return;
		const command = (await fs.readFile(`${base}/comm`, "utf8").catch(() => "?")).trim();
		users.push({ pid, command });
	};
	for (let i = 0; i < entries.length; i += PROCESS_SCAN_CONCURRENCY) {
		await Promise.all(entries.slice(i, i + PROCESS_SCAN_CONCURRENCY).map(inspect));
	}
	return { kind: "known", users };
}

async function lsofProcessesUsing(dir: string): Promise<DirectoryUsers> {
	const prefix = dir.endsWith("/") ? dir : `${dir}/`;
	let out: string;
	try {
		// Every open file on the host, filtered here: `+D` walks the whole tree
		// under `dir`, which for a repository copy is slower than this.
		const lsof = Bun.spawn(["lsof", "-n", "-P", "-w", "-F", "pcn"], { stdout: "pipe", stderr: "ignore" });
		out = await new Response(lsof.stdout).text();
		await lsof.exited;
	} catch (error) {
		return { kind: "unknown", reason: `lsof could not run (${reasonOf(error)})` };
	}
	if (out.length === 0) return { kind: "unknown", reason: "lsof listed nothing" };
	const users = new Map<number, DirectoryUser>();
	let pid = 0;
	let command = "?";
	for (const line of out.split("\n")) {
		const field = line.slice(1);
		if (line.startsWith("p")) {
			pid = Number(field);
			command = "?";
		} else if (line.startsWith("c")) {
			command = field;
		} else if (line.startsWith("n") && isInside(field, dir, prefix) && !(pid === process.pid && field === dir)) {
			users.set(pid, { pid, command });
		}
	}
	return { kind: "known", users: [...users.values()] };
}
