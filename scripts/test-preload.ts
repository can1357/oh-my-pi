/**
 * Preloaded by every `bun test` in this repository. Each directory a test run starts in
 * names it in its own bunfig.toml, because Bun reads only the bunfig.toml of that directory.
 *
 * It marks every process a test spawns as a test child (`PI_TEST_RUNTIME=1`, which
 * `isBunTestRuntime()` in @oh-my-pi/pi-utils reads). A test file's own process is recognised
 * by its entrypoint, but a child such as an omp CLI has a production entrypoint. Unmarked, it
 * uses the auth broker and the telemetry collector that the developer's shell names, with the
 * developer's token. ci-test-ts.ts starts `bun test` with the marker already set, so every
 * child inherits it; a direct `bun test` has no such launcher, so this sets it instead.
 *
 * A child takes its environment from one of three places, all filled from the environment
 * the process was started with, so the marker goes into each:
 * - The environment of the process itself (`environ`). Native code builds a child's from it:
 *   the shell `Shell.run` uses and the terminal `PtySession` opens copy it when they start.
 *   So does a Worker for a child it spawns, since a Worker never sees this realm or its
 *   `Bun.spawn`. Writing `process.env` leaves it untouched, so this calls the C library.
 * - `process.env`, which reaches the children of `node:child_process` and `Bun.$`, any call
 *   that passes `env: { ...process.env }`, and a Worker's own `process.env`.
 * - The environment Bun started with, which a `Bun.spawn` or `Bun.spawnSync` call without
 *   `env` passes and nothing can change. For those calls in this realm the default becomes
 *   that same starting environment plus the marker.
 * A call that builds its `env` from nothing, or that removes the marker to run a child as
 * production, still decides for itself, and must keep the developer's broker variables,
 * `OTEL_*` collector and home directory from that child.
 */
import { dlopen, FFIType, ptr } from "bun:ffi";

const TEST_RUNTIME_MARKER = "PI_TEST_RUNTIME";

/**
 * Sets a variable in the environment of the process, which `process.env` does not reach. It
 * runs before any test code, while nothing else changes that environment. It throws rather
 * than return without the marker set: an unmarked native child is the leak this file stops.
 */
function setProcessEnvironment(name: string, value: string): void {
	if (process.platform === "win32") {
		const kernel32 = dlopen("kernel32.dll", {
			SetEnvironmentVariableW: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
		});
		try {
			const wideName = Buffer.from(`${name}\0`, "utf16le");
			const wideValue = Buffer.from(`${value}\0`, "utf16le");
			if (kernel32.symbols.SetEnvironmentVariableW(ptr(wideName), ptr(wideValue)) !== 0) return;
		} finally {
			kernel32.close();
		}
		throw new Error(`test preload: SetEnvironmentVariableW could not set ${name}`);
	}
	// Darwin: dyld resolves libSystem from the shared cache. Linux: glibc first, then the
	// generic soname for musl-style layouts (as in pi-utils' stderr-guard.ts).
	const candidates =
		process.platform === "darwin" ? ["libSystem.B.dylib", "/usr/lib/libSystem.B.dylib"] : ["libc.so.6", "libc.so"];
	for (const candidate of candidates) {
		const libc = openSetenv(candidate);
		if (libc === undefined) continue;
		try {
			const cName = Buffer.from(`${name}\0`, "utf8");
			const cValue = Buffer.from(`${value}\0`, "utf8");
			if (libc.symbols.setenv(ptr(cName), ptr(cValue), 1) === 0) return;
		} finally {
			libc.close();
		}
		throw new Error(`test preload: setenv could not set ${name}`);
	}
	throw new Error(`test preload: no C library to set ${name} in (tried ${candidates.join(", ")})`);
}

/** The C library's `setenv`, or nothing when `library` is not on this system. */
function openSetenv(library: string) {
	try {
		return dlopen(library, {
			setenv: { args: [FFIType.ptr, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
		});
	} catch {
		return undefined;
	}
}

setProcessEnvironment(TEST_RUNTIME_MARKER, "1");
process.env[TEST_RUNTIME_MARKER] = "1";
// Taken before any test runs: the environment Bun started with, plus the marker just set.
const defaultChildEnv: Record<string, string | undefined> = { ...process.env };

interface EnvOption {
	env?: Record<string, string | undefined>;
}

function withDefaultChildEnv<T extends EnvOption>(options: T): T {
	return options.env === undefined ? { ...options, env: defaultChildEnv } : options;
}

const spawn = Bun.spawn;
const spawnSync = Bun.spawnSync;
// One implementation cannot restate Bun's overloads, so each wrapper is cast to the type of
// the function it forwards to: it fills in an omitted `env` and passes everything else as is.
Object.assign(Bun, {
	spawn: ((command: string[] | (EnvOption & { cmd: string[] }), options?: EnvOption) =>
		Array.isArray(command)
			? spawn(command, withDefaultChildEnv(options ?? {}))
			: spawn(withDefaultChildEnv(command))) as unknown as typeof Bun.spawn,
	spawnSync: ((command: string[] | (EnvOption & { cmd: string[] }), options?: EnvOption) =>
		Array.isArray(command)
			? spawnSync(command, withDefaultChildEnv(options ?? {}))
			: spawnSync(withDefaultChildEnv(command))) as unknown as typeof Bun.spawnSync,
});
