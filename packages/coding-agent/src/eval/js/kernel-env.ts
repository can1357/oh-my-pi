/**
 * Environment the JS eval kernel runs model code under.
 *
 * Two guards against a cell starting an unattended agent:
 *
 * - `OMPCODE=1` marks the kernel as an omp tool process, the mark the bash
 *   tool's shell already carries, so an `omp <words>` launched from a cell is
 *   refused unless it says `-p` on purpose (see `refuseToolShellAutoPrint`).
 * - In a compiled omp, Bun's shell resolves the bare command `bun` to the
 *   running executable when PATH has none, and that executable, started
 *   without `BUN_BE_BUN`, is omp: `` Bun.$`bun test x.ts` `` became the
 *   headless agent `omp test x.ts`. A `bun` shim on the kernel's PATH wins
 *   over that fallback. It re-enters the executable with `BUN_BE_BUN=1`, so
 *   `bun` is bun for `Bun.$`, `Bun.spawn` and `child_process` alike. The shim
 *   is appended to PATH, so a real bun anywhere on it still wins, and an `omp`
 *   started from a cell is untouched: `BUN_BE_BUN` is set only inside the shim.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { $which, errorMessage, getBunShimDir, isCompiledBinary, isEnoent, logger } from "@oh-my-pi/pi-utils";
import { resolveExecutablePath } from "../../subprocess/worker-client";

/** Shell shim that makes the executable at `execPath` act as bun. */
export function bunShimScript(execPath: string): string {
	return `#!/bin/sh\nBUN_BE_BUN=1 exec '${execPath.replaceAll("'", "'\\''")}' "$@"\n`;
}

/** Seams of `bunShimPathEntry` and `jsKernelEnv`; production callers pass none, tests inject a fake executable and lookup. */
export interface BunShimOptions {
	/** Whether this process is a compiled omp (default: detected). */
	compiled?: boolean;
	/** Executable the shim re-enters (default: this omp's executable, as `resolveExecutablePath` finds it after an upgrade). */
	execPath?: string;
	/** Root under which each executable gets its own shim directory (default: the agent cache). */
	shimRoot?: string;
	/** `bun` lookup on a PATH (default: `$which`). */
	which?: (command: string, PATH: string | undefined) => string | null;
}

/**
 * The shim directory to append to `env.PATH`, or undefined when no shim is
 * needed or none can be published: a source run (plain bun, whose fallback is
 * bun), a PATH that already resolves `bun`, Windows (no POSIX shim), or a
 * cache that cannot take the file (unwritable, full, blocked). Without a shim
 * a cell's `bun` still reaches this executable, and the kernel's `OMPCODE=1`
 * makes that launch refuse to run headless.
 *
 * Each executable path gets its own directory under the root, named by a hash
 * of that path, and its shim's content is a pure function of the path. So a
 * shim, once published, never changes: another omp version with a live kernel
 * keeps re-entering its own executable, and a moved binary gets a new
 * directory rather than a rewrite. The file is published by rename, so a
 * kernel never sees a partial script, and concurrent first uses converge on
 * identical bytes.
 */
export function bunShimPathEntry(env: Record<string, string>, options: BunShimOptions = {}): string | undefined {
	if (process.platform === "win32") return undefined;
	if (!(options.compiled ?? isCompiledBinary())) return undefined;
	const which = options.which ?? ((command, PATH) => $which(command, { PATH }));
	if (which("bun", env.PATH) !== null) return undefined;
	const execPath = options.execPath ?? resolveExecutablePath();
	const shimDir = path.join(options.shimRoot ?? getBunShimDir(), Bun.hash(execPath).toString(16));
	const shim = path.join(shimDir, "bun");
	const script = bunShimScript(execPath);
	try {
		if (readShim(shim) !== script) publishShim(shimDir, shim, script);
	} catch (error) {
		logger.warn("JS eval kernel starts without its bun shim", { shimDir, error: errorMessage(error) });
		return undefined;
	}
	return shimDir;
}

/** The published shim's content, or undefined when there is none yet. */
function readShim(shim: string): string | undefined {
	try {
		return fs.readFileSync(shim, "utf8");
	} catch (error) {
		if (isEnoent(error)) return undefined;
		throw error;
	}
}

/** Write `script` beside `shim` and rename it into place; a failed attempt leaves no staging file. */
function publishShim(shimDir: string, shim: string, script: string): void {
	fs.mkdirSync(shimDir, { recursive: true });
	const staging = path.join(shimDir, `.bun.${process.pid}.${Date.now().toString(36)}`);
	try {
		fs.writeFileSync(staging, script, { mode: 0o755 });
		fs.renameSync(staging, shim);
	} catch (error) {
		fs.rmSync(staging, { force: true });
		throw error;
	}
}

/** Kernel env: `base` plus the tool-process mark and, when needed, the `bun` shim appended to PATH. */
export function jsKernelEnv(base: Record<string, string>, options?: BunShimOptions): Record<string, string> {
	const env: Record<string, string> = { ...base, OMPCODE: "1" };
	const shimDir = bunShimPathEntry(env, options);
	if (shimDir !== undefined) env.PATH = env.PATH ? `${env.PATH}${path.delimiter}${shimDir}` : shimDir;
	return env;
}
