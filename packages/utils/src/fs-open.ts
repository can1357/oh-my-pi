/** Close-on-exec file opens for descriptors held past a child spawn. */
import * as fs from "node:fs";

/**
 * `O_CLOEXEC`, which neither Node nor Bun exposes in `fs.constants`.
 *
 * Kernel ABI values: `0o2000000` on Linux, `0x0100_0000` on Darwin. Windows has
 * no `exec` and its CRT handles are inherited only when a spawn explicitly asks
 * for it, so the bit is 0 there — as it is on any other platform, where adding
 * an unknown flag bit would be worse than leaving the descriptor inheritable.
 */
const O_CLOEXEC = process.platform === "linux" ? 0o2000000 : process.platform === "darwin" ? 0x0100_0000 : 0;

/**
 * `fs.openSync` with close-on-exec, matching Node's default.
 *
 * libuv adds `O_CLOEXEC` inside `uv__fs_open`, so on Node every `fs` descriptor
 * dies at `exec`. Bun's `fs.open*` does not, and descriptors it returns survive
 * into any child spawned through a path that does not close strays itself — the
 * bash tool's shell `fork`/`exec`s user commands and hands them the lot. Use
 * this for every descriptor kept open past such a spawn (session transcripts,
 * logs, spools); a child must never hold a writable handle to them (#13224).
 *
 * Flags are numeric only: the bit cannot be OR-ed into `"a"`/`"w+"` strings.
 *
 * @example
 * const fd = openCloexecSync(logPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND);
 */
export function openCloexecSync(filePath: string, flags: number, mode?: number): number {
	return fs.openSync(filePath, flags | O_CLOEXEC, mode);
}
