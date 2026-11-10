import { dlopen, FFIType } from "bun:ffi";
import * as fs from "node:fs";
import { filterLauncherEnv } from "../env";
import { isFsError } from "../fs-error";
import type { SandboxHost, SandboxLandlock, SandboxRootListing } from "./types";

type SandboxCheck = (pid: number, operation: null, type: number) => number;

let sandboxCheckFn: SandboxCheck | null | undefined;

/** libsandbox's `sandbox_check`, resolved once from libSystem; `null` when it cannot be loaded. */
function loadSandboxCheck(): SandboxCheck | null {
	if (sandboxCheckFn !== undefined) return sandboxCheckFn;
	sandboxCheckFn = null;
	for (const candidate of ["libSystem.B.dylib", "/usr/lib/libSystem.B.dylib"]) {
		try {
			// Variadic in C; with filter type 0 (SANDBOX_FILTER_NONE) no variadic argument is read.
			const lib = dlopen(candidate, {
				sandbox_check: { args: [FFIType.i32, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
			});
			sandboxCheckFn = lib.symbols.sandbox_check;
			break;
		} catch {}
	}
	return sandboxCheckFn;
}

/** Only the child executes syscall 444: a seccomp SIGSYS cannot terminate omp. */
const LANDLOCK_QUERY_SCRIPT = `
const { dlopen, FFIType, read } = require("bun:ffi");
const libc = dlopen("libc.so.6", {
	syscall: { args: [FFIType.i64, FFIType.ptr, FFIType.u64, FFIType.u32], returns: FFIType.i64 },
	__errno_location: { args: [], returns: FFIType.ptr },
});
const ret = Number(libc.symbols.syscall(444, null, 0, 1));
const errno = ret > 0 ? 0 : read.i32(libc.symbols.__errno_location());
process.stdout.write(JSON.stringify({ ret, errno }));
`;

/** How the query child ended; a plain value so each ending (SIGSYS, timeout, bad output) can be tested. */
export interface LandlockProbeResult {
	exitCode: number | null;
	signalCode?: string | null;
	stdout?: { toString(): string } | null;
	exitedDueToTimeout?: boolean;
}

export function mapLandlockProbeResult(result: LandlockProbeResult): SandboxLandlock {
	if (result.signalCode === "SIGSYS" && !result.exitedDueToTimeout) return { state: "blocked" };
	if (result.exitedDueToTimeout || result.signalCode || result.exitCode !== 0) return { state: "unknown" };
	let parsed: unknown;
	try {
		parsed = JSON.parse(result.stdout?.toString() ?? "");
	} catch {
		return { state: "unknown" };
	}
	if (typeof parsed !== "object" || parsed === null) return { state: "unknown" };
	const { ret, errno } = parsed as { ret?: unknown; errno?: unknown };
	if (
		typeof ret !== "number" ||
		!Number.isSafeInteger(ret) ||
		typeof errno !== "number" ||
		!Number.isSafeInteger(errno)
	)
		return { state: "unknown" };
	if (ret > 0 && errno === 0) return { state: "supported", abi: ret };
	if (ret !== -1) return { state: "unknown" };
	if (errno === 38) return { state: "unsupported" }; // ENOSYS
	if (errno === 95) return { state: "disabled" }; // EOPNOTSUPP
	if (errno === 1 || errno === 13) return { state: "blocked" }; // EPERM / EACCES
	return { state: "unknown" };
}

async function queryLandlockAbi(): Promise<SandboxLandlock> {
	// The syscall number below is verified for these architectures only.
	if (process.platform !== "linux" || (process.arch !== "x64" && process.arch !== "arm64"))
		return { state: "unknown" };
	try {
		const child = Bun.spawn([process.execPath, "--no-env-file", "-e", LANDLOCK_QUERY_SCRIPT], {
			env: { ...process.env, BUN_BE_BUN: "1" },
			timeout: 2000,
			killSignal: "SIGKILL",
			maxBuffer: 1024,
			stdin: "ignore",
			stdout: "pipe",
			stderr: "ignore",
		});
		const [stdout, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited]);
		return mapLandlockProbeResult({ exitCode, signalCode: child.signalCode, stdout });
	} catch {
		return { state: "unknown" };
	}
}

/** One query per process: the kernel's answer does not change while omp runs. */
let landlockQuery: Promise<SandboxLandlock> | undefined;

export interface SandboxHostOptions {
	/** The process environment; `process.env` by default. */
	env?: Record<string, string | undefined>;
	/** The working directory; `process.cwd()` by default. */
	cwd?: string;
	/** The directory whose dotenv files were loaded at startup; the launch directory by default. */
	launchDir?: string;
}

/**
 * The real host (see {@link SandboxHost} for why it is synchronous). `root` prefixes every path, `/` included, so
 * tests can point the host at a fake tree. Probes see the environment omp was started with ({@link filterLauncherEnv}),
 * not what dotenv files added: Bun and omp load the launch directory's `.env` at startup, and a repository must not
 * be able to declare a sandbox (a `NONO_CAP_FILE` in a cloned repository's `.env` names no nono layer), also after
 * `--cwd` or a resume has moved omp to another directory.
 */
export function createSandboxHost(root = "", options: SandboxHostOptions = {}): SandboxHost {
	const at = (p: string) => `${root}${p}`;
	const cwd = options.cwd ?? process.cwd();
	return {
		platform: process.platform,
		env: filterLauncherEnv(options.env ?? process.env, { cwd, launchDir: options.launchDir }),
		cwd,
		readFile(p) {
			try {
				return fs.readFileSync(at(p), "utf8");
			} catch {
				return undefined;
			}
		},
		readLink(p) {
			try {
				return fs.readlinkSync(at(p));
			} catch {
				return undefined;
			}
		},
		exists(p) {
			return fs.existsSync(at(p));
		},
		rootListing(): SandboxRootListing | undefined {
			let st: fs.Stats;
			try {
				st = fs.statSync(at("/"));
			} catch {
				return undefined;
			}
			let listing: SandboxRootListing["listing"] = "ok";
			try {
				fs.readdirSync(at("/"));
			} catch (err) {
				const code = isFsError(err) ? err.code : undefined;
				listing = code === "EACCES" || code === "EPERM" ? code : "other";
			}
			return { uid: st.uid, mode: st.mode, listing };
		},
		sandboxCheck() {
			if (process.platform !== "darwin") return undefined;
			const check = loadSandboxCheck();
			if (!check) return undefined;
			try {
				return check(process.pid, null, 0);
			} catch {
				return undefined;
			}
		},
		landlockAbi() {
			// A fake /proc tree must never borrow ABI evidence from the real host.
			if (root) return { state: "unknown" };
			landlockQuery ??= queryLandlockAbi();
			return landlockQuery;
		},
	};
}
