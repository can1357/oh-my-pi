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

/** Write a file's whole contents, creating parent directories. */
export async function writeFileDeep(file: string, contents: string): Promise<void> {
	await Bun.write(file, contents);
}
