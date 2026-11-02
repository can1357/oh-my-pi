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
