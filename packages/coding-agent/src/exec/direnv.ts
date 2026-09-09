import * as fs from "node:fs/promises";
import * as path from "node:path";
import { $which, logger } from "@oh-my-pi/pi-utils";

/** Default cap on a single `direnv` invocation. The first export for a devenv
 *  `.envrc` can build a shell; callers may raise this via `bash.direnvLoadTimeoutMs`. */
export const DEFAULT_DIRENV_TIMEOUT_MS = 30_000;

/** Walk up from `startDir` to the nearest directory containing an `.envrc`. */
export async function findEnvrc(startDir: string): Promise<string | null> {
	let dir = path.resolve(startDir);
	for (;;) {
		const candidate = path.join(dir, ".envrc");
		try {
			if ((await fs.stat(candidate)).isFile()) return candidate;
		} catch {
			// no .envrc here — keep walking up
		}
		const parent = path.dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

export interface DirenvExportDiff {
	/** Variables direnv sets to a concrete value. */
	set: Record<string, string>;
	/** Variables direnv removes (JSON `null`). */
	unset: string[];
}

/** Parse `direnv export json` output (`{VAR: value|null}`) into set/unset halves. */
export function parseDirenvExport(jsonText: string): DirenvExportDiff {
	const trimmed = jsonText.trim();
	if (trimmed.length === 0) return { set: {}, unset: [] };
	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch {
		return { set: {}, unset: [] };
	}
	const set: Record<string, string> = {};
	const unset: string[] = [];
	if (parsed && typeof parsed === "object") {
		for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
			if (value === null) unset.push(key);
			else if (typeof value === "string") set[key] = value;
		}
	}
	return { set, unset };
}

let direnvLookup: { bin: string | null } | undefined;
function direnvBinary(): string | null {
	if (!direnvLookup) direnvLookup = { bin: $which("direnv") };
	return direnvLookup.bin;
}

/** direnv computes its diff relative to the spawning env; strip any inherited
 *  direnv state so it loads the target `.envrc` from a clean baseline. */
function cleanSpawnEnv(): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [key, value] of Object.entries(Bun.env)) {
		if (value !== undefined && !key.startsWith("DIRENV_")) out[key] = value;
	}
	return out;
}

async function runDirenv(
	bin: string,
	args: string[],
	cwd: string,
	timeoutMs: number,
	env: Record<string, string>,
	signal?: AbortSignal,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	// Bail on the caller's cancellation as well as the per-invocation cap so a
	// cold `.envrc` load can't outlive an aborted / short-timeout bash call.
	const abortSignal = signal
		? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
		: AbortSignal.timeout(timeoutMs);
	const proc = Bun.spawn([bin, ...args], {
		cwd,
		env,
		stdout: "pipe",
		stderr: "pipe",
		signal: abortSignal,
	});
	// Drain stdout AND stderr concurrently: a cold `use devenv`/Nix load emits
	// enough diagnostics to fill the stderr pipe and block the child forever if
	// only stdout is read (it would then wait out `timeoutMs`).
	const [stdout, stderr] = await Promise.all([
		new Response(proc.stdout as ReadableStream<Uint8Array>).text(),
		new Response(proc.stderr as ReadableStream<Uint8Array>).text(),
	]);
	const exitCode = await proc.exited;
	return { exitCode, stdout, stderr };
}

/**
 * Resolve the nearest `.envrc` from `cwd` and return its `direnv export` diff
 * (variables to set, and variables direnv removes). Returns `null` when there
 * is no `.envrc`, `direnv` is not installed, the `.envrc` is not on direnv's
 * allow list, or the export fails/times out.
 *
 * direnv's own allow list is honored — an `.envrc` the user has not
 * `direnv allow`ed is NEVER executed or auto-allowed. This keeps OMP's trust
 * boundary identical to the user's own shell: cloning a repo with a poisoned
 * `.envrc` grants it nothing until the user explicitly allows it.
 *
 * Always re-invokes `direnv export json` rather than serving a cached diff:
 * direnv is fast once warm, and its own watch/mtime invalidation is the
 * authoritative freshness signal (a content-hash cache here would go stale when
 * a `watch_file` target changes without the `.envrc` text changing).
 */
export async function loadDirenvEnv(
	cwd: string,
	opts?: { timeoutMs?: number; signal?: AbortSignal },
): Promise<DirenvExportDiff | null> {
	const envrcPath = await findEnvrc(cwd);
	if (!envrcPath) return null;
	const bin = direnvBinary();
	if (!bin) return null;

	const dir = path.dirname(envrcPath);
	const timeoutMs = opts?.timeoutMs ?? DEFAULT_DIRENV_TIMEOUT_MS;
	const env = cleanSpawnEnv();
	try {
		const { exitCode, stdout, stderr } = await runDirenv(bin, ["export", "json"], dir, timeoutMs, env, opts?.signal);
		if (exitCode !== 0) {
			// A not-yet-allowed .envrc is an expected steady state (the user opted
			// out by never running `direnv allow`), not an error worth warning on.
			if (stderr.includes("is blocked")) {
				logger.debug("direnv .envrc not allowed; skipping", { dir });
			} else {
				logger.warn("direnv export failed", { dir, exitCode });
			}
			return null;
		}
		return parseDirenvExport(stdout);
	} catch (err) {
		logger.warn("direnv load failed", { dir, error: err instanceof Error ? err.message : String(err) });
		return null;
	}
}
