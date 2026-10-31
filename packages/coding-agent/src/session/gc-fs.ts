/**
 * The filesystem `omp gc`'s own modules may use: operations on names and
 * directories — look, list, link, move, remove, make — none of which opens a
 * file and reads or writes what it holds. A file's contents are reached only
 * through `regular-file.ts`, which opens without blocking and refuses
 * anything but a regular file; this module has no `open`, `readFile`,
 * `writeFile`, `copyFile` or stream to offer, so a gc module that imports its
 * filesystem from here has none to call, under any name. `gc-cli.ts`,
 * `session-archive.ts` and `gc-lock.ts` import their filesystem only from
 * here: `.oxlintrc.json` makes an import of `node:fs` or `node:fs/promises`
 * an error in them.
 */
export {
	access,
	chmod,
	link,
	lstat,
	mkdir,
	readdir,
	readlink,
	realpath,
	rename,
	rm,
	rmdir,
	stat,
	symlink,
	unlink,
	utimes,
} from "node:fs/promises";
export type { FileHandle } from "node:fs/promises";
export { constants } from "node:fs";
export type { Stats } from "node:fs";
