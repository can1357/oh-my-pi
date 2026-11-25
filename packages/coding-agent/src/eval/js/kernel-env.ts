/**
 * Environment the JS eval kernel runs model code under.
 *
 * In a compiled omp, Bun's shell resolves the bare command `bun` to the running
 * executable when PATH has none (oven-sh/bun#14459), and that executable is omp:
 * `` Bun.$`bun test x.ts` `` in a cell became the headless agent `omp test x.ts`.
 * Only `Bun.$` has that fallback; `Bun.spawn`, `child_process` and other
 * runtimes report `bun` as missing.
 *
 * The kernel's PATH therefore ends with a `bun` stub that says bun is not
 * installed and exits 127, so `Bun.$` finds it before falling back to itself.
 * Appended, so a real bun anywhere on PATH still wins. The stub does not
 * re-enter the executable with `BUN_BE_BUN=1`: that variable is inherited, and
 * every bun-compiled program the resulting bun starts (omp included) would run
 * as bare bun too.
 *
 * Remove once Bun stops resolving `bun` to a compiled executable.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { $which, errorMessage, getBunStubDir, isCompiledBinary, isEnoent, logger } from "@oh-my-pi/pi-utils";
import { resolvePathKey } from "../py/runtime";

/** First line the stub writes to stderr; the smoke test recognizes the stub by it. */
export const BUN_STUB_MESSAGE = "bun: not installed; install bun from https://bun.sh to use it from an omp eval cell";

/** Stub file name and content for `platform`: a POSIX script, or a cmd script on Windows. */
export function bunStub(platform: NodeJS.Platform = process.platform): { name: string; script: string } {
	if (platform === "win32") {
		return { name: "bun.cmd", script: `@echo ${BUN_STUB_MESSAGE} 1>&2\r\n@exit /b 127\r\n` };
	}
	return { name: "bun", script: `#!/bin/sh\necho '${BUN_STUB_MESSAGE}' >&2\nexit 127\n` };
}

/** Seams of `bunStubPathEntry` and `jsKernelEnv`; production callers pass none. */
export interface BunStubOptions {
	/** Whether this process is a compiled omp (default: detected). */
	compiled?: boolean;
	/** Directory the stub is published in (default: the agent cache). */
	stubDir?: string;
	/** `bun` lookup on a PATH (default: `$which`). */
	which?: (command: string, PATH: string | undefined) => string | null;
	/** Platform whose stub is written (default: this one). */
	platform?: NodeJS.Platform;
}

/**
 * The stub directory to append to the kernel's PATH, or undefined when none is
 * needed or it cannot be published: a source run (the executable is bun), a PATH
 * that already resolves `bun`, or a cache that cannot take the file. The file is
 * published by rename, so a kernel never sees a partial script.
 */
export function bunStubPathEntry(PATH: string | undefined, options: BunStubOptions = {}): string | undefined {
	if (!(options.compiled ?? isCompiledBinary())) return undefined;
	const which = options.which ?? ((command, searchPath) => $which(command, { PATH: searchPath }));
	if (which("bun", PATH) !== null) return undefined;
	const stubDir = options.stubDir ?? getBunStubDir();
	const { name, script } = bunStub(options.platform);
	const stub = path.join(stubDir, name);
	try {
		if (readStub(stub) !== script) publishStub(stubDir, stub, script);
	} catch (error) {
		logger.warn("JS eval kernel starts without its bun stub", { stubDir, error: errorMessage(error) });
		return undefined;
	}
	return stubDir;
}

/** The published stub's content, or undefined when there is none yet. */
function readStub(stub: string): string | undefined {
	try {
		return fs.readFileSync(stub, "utf8");
	} catch (error) {
		if (isEnoent(error)) return undefined;
		throw error;
	}
}

/** Write `script` beside `stub` and rename it into place; a failed attempt leaves no staging file. */
function publishStub(stubDir: string, stub: string, script: string): void {
	fs.mkdirSync(stubDir, { recursive: true });
	const staging = path.join(stubDir, `.bun.${process.pid}.${Date.now().toString(36)}`);
	try {
		fs.writeFileSync(staging, script, { mode: 0o755 });
		fs.renameSync(staging, stub);
	} catch (error) {
		fs.rmSync(staging, { force: true });
		throw error;
	}
}

/** Kernel env: `base` with the `bun` stub directory appended to PATH when needed. */
export function jsKernelEnv(base: Record<string, string>, options?: BunStubOptions): Record<string, string> {
	const pathKey = resolvePathKey(base);
	const stubDir = bunStubPathEntry(base[pathKey], options);
	if (stubDir === undefined) return base;
	const current = base[pathKey];
	return { ...base, [pathKey]: current ? `${current}${path.delimiter}${stubDir}` : stubDir };
}
