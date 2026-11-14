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
import { $which, getBunShimDir, isCompiledBinary } from "@oh-my-pi/pi-utils";

/** Shell shim that makes the executable at `execPath` act as bun. */
export function bunShimScript(execPath: string): string {
	return `#!/bin/sh\nBUN_BE_BUN=1 exec '${execPath.replaceAll("'", "'\\''")}' "$@"\n`;
}

export interface BunShimOptions {
	/** Whether this process is a compiled omp (default: detected). */
	compiled?: boolean;
	/** Executable the shim re-enters (default: this process). */
	execPath?: string;
	/** Where the shim lives (default: the agent cache). */
	shimDir?: string;
	/** `bun` lookup on a PATH (default: `$which`). */
	which?: (command: string, PATH: string | undefined) => string | null;
}

/**
 * The shim directory to append to `env.PATH`, or undefined when no shim is
 * needed: a source run (plain bun, whose fallback is bun), a PATH that already
 * resolves `bun`, or Windows (no POSIX shim). The shim is written on first use
 * and rewritten when the executable path it names differs, so a moved binary
 * never leaves a stale shim behind.
 */
export function bunShimPathEntry(env: Record<string, string>, options: BunShimOptions = {}): string | undefined {
	if (process.platform === "win32") return undefined;
	if (!(options.compiled ?? isCompiledBinary())) return undefined;
	const which = options.which ?? ((command, PATH) => $which(command, { PATH }));
	if (which("bun", env.PATH) !== null) return undefined;
	const shimDir = options.shimDir ?? getBunShimDir();
	const shim = path.join(shimDir, "bun");
	const script = bunShimScript(options.execPath ?? process.execPath);
	let current: string | undefined;
	try {
		current = fs.readFileSync(shim, "utf8");
	} catch {
		current = undefined;
	}
	if (current !== script) {
		fs.mkdirSync(shimDir, { recursive: true });
		fs.writeFileSync(shim, script, { mode: 0o755 });
	}
	fs.chmodSync(shim, 0o755);
	return shimDir;
}

/** Kernel env: `base` plus the tool-process mark and, when needed, the `bun` shim appended to PATH. */
export function jsKernelEnv(base: Record<string, string>, options?: BunShimOptions): Record<string, string> {
	const env: Record<string, string> = { ...base, OMPCODE: "1" };
	const shimDir = bunShimPathEntry(env, options);
	if (shimDir !== undefined) env.PATH = env.PATH ? `${env.PATH}${path.delimiter}${shimDir}` : shimDir;
	return env;
}
