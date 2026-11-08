/**
 * The filesystem and runtime `omp gc`'s own modules may use: operations on
 * names and directories — look, list, link, move, remove, make — none of
 * which opens a file and reads or writes what it holds, and the three
 * facilities gc takes from Bun, none of which opens a file either: `Glob`,
 * which lists directories, `CryptoHasher` and `sleep`. A file's contents are
 * reached only through `regular-file.ts`, which opens without blocking and
 * refuses anything but a regular file; this module has no `open`,
 * `readFile`, `writeFile`, `copyFile`, stream or `Bun.file` to offer, so a
 * gc module that imports from here has none to call, under any name.
 *
 * `gc-cli.ts`, `session-archive.ts` and `gc-lock.ts` import from here only:
 * `.oxlintrc.json` makes an import of `node:fs`, `fs`, `bun`, `bun:sqlite`
 * or `node:child_process` an error in them, with `require`, the `Bun`
 * global and `process.getBuiltinModule`. That guard is local to those three
 * files, not transitive: a helper in a fourth file they import, a child
 * process another module starts, or code built at run time reaches a file
 * past it, and nothing here or in the type checker stops that.
 */
export { CryptoHasher, Glob, sleep } from "bun";
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
