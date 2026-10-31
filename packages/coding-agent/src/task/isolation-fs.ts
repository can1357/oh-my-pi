/**
 * The whole filesystem surface the isolation path is allowed to touch.
 *
 * Reads come from `isolation-lookup` and answer `found` | `absent` |
 * `unknown`. Writes are here, and they are the operations that either happen
 * or raise — there is no third answer to swallow. Together they are the reason
 * the modules that decide whether a workspace may be deleted import no
 * filesystem API of their own: a read in the old form is not discouraged
 * there, it is unavailable, and `isolation-lookup-surface.test.ts` asks that
 * of the module graph rather than of the text.
 */

import { type FSWatcher, watch as nodeWatch } from "node:fs";
import * as fs from "node:fs/promises";

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
