import * as fs from "node:fs/promises";
import * as path from "node:path";
import { inflateSync } from "node:zlib";
import { $which, isEnoent, logger } from "@oh-my-pi/pi-utils";

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
	readonly set: Readonly<Record<string, string>>;
	/** Variables direnv removes (JSON `null`). */
	readonly unset: readonly string[];
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

// Per-directory `.envrc` walk-up cache (positive and negative): a repo
// without `.envrc` pays the throwing-stat walk once per TTL window instead
// of once per bash call. Entries are keyed on the resolved start dir with a
// short TTL, so a created/deleted/moved `.envrc` is discovered within
// seconds without re-walking to the filesystem root on every call.
const envrcCache = new Map<string, { found: string | null; atMs: number }>();
const ENVRC_CACHE_MAX = 512;
const ENVRC_CACHE_TTL_MS = 5_000;

interface DirenvWatch {
	path: string;
	/** Newest of the link and target ns mtimes, mirroring direnv's `getLatestStat`; null when missing. */
	mtimeNs: bigint | null;
	size: bigint | null;
}

// Retain direnv's state so subsequent exports check its watch list instead of
// rebuilding devenv. The diff is relative to the clean process env.
const exportCache = new Map<
	string,
	{
		base: Record<string, string>;
		loaded: Record<string, string>;
		diff: DirenvExportDiff;
		mtimeNs: bigint;
		size: bigint;
		watches: DirenvWatch[];
	}
>();

async function statDirenvWatch(watchedPath: string): Promise<DirenvWatch> {
	try {
		// direnv takes the newer of lstat/stat so a re-pointed symlink counts as a change.
		const [link, target] = await Promise.all([
			fs.lstat(watchedPath, { bigint: true }),
			fs.stat(watchedPath, { bigint: true }),
		]);
		const mtimeNs = link.mtimeNs > target.mtimeNs ? link.mtimeNs : target.mtimeNs;
		return { path: watchedPath, mtimeNs, size: target.size };
	} catch (err) {
		if (!isEnoent(err)) throw err;
		return { path: watchedPath, mtimeNs: null, size: null };
	}
}

async function snapshotDirenvWatches(encoded: string, envrcPath: string): Promise<DirenvWatch[] | null> {
	try {
		// direnv's gzenv format is base64url-encoded zlib JSON.
		const decoded: unknown = JSON.parse(inflateSync(Buffer.from(encoded, "base64url")).toString("utf8"));
		if (!Array.isArray(decoded) || decoded.length === 0) return null;
		const recorded: { path: string; modtime: number; exists: boolean }[] = [];
		for (const watch of decoded) {
			if (
				!watch ||
				typeof watch !== "object" ||
				typeof watch.path !== "string" ||
				!path.isAbsolute(watch.path) ||
				typeof watch.modtime !== "number" ||
				typeof watch.exists !== "boolean"
			) {
				return null;
			}
			// The caller captures .envrc before the export.
			if (watch.path !== envrcPath) recorded.push(watch);
		}
		const watches = await Promise.all(recorded.map(watch => statDirenvWatch(watch.path)));
		// A watched file edited while the export ran no longer matches the second
		// direnv recorded; caching would pin the new mtime to the old environment.
		for (let i = 0; i < watches.length; i++) {
			const { mtimeNs } = watches[i];
			const { modtime, exists } = recorded[i];
			if ((mtimeNs !== null) !== exists) return null;
			if (mtimeNs !== null && mtimeNs / 1_000_000_000n !== BigInt(modtime)) return null;
		}
		return watches;
	} catch {
		// Without a readable watch list, the next export must start cold.
		return null;
	}
}

async function direnvWatchesUnchanged(watches: DirenvWatch[]): Promise<boolean> {
	try {
		const current = await Promise.all(watches.map(watch => statDirenvWatch(watch.path)));
		return current.every((now, i) => now.mtimeNs === watches[i].mtimeNs && now.size === watches[i].size);
	} catch {
		return false;
	}
}

/** Test-only: filtered parent-env baseline (versioned against live Bun.env). */
export function cleanSpawnEnvForTests(): Record<string, string> {
	return cleanSpawnEnv();
}

export function clearDirenvCachesForTests(): void {
	envrcCache.clear();
	exportCache.clear();
	cleanSpawnEnvCache = undefined;
}

async function findEnvrcCached(startDir: string): Promise<string | null> {
	const key = path.resolve(startDir);
	const now = Date.now();
	const cached = envrcCache.get(key);
	if (cached !== undefined && now - cached.atMs < ENVRC_CACHE_TTL_MS) return cached.found;
	const found = await findEnvrc(key);
	if (envrcCache.size >= ENVRC_CACHE_MAX) envrcCache.clear();
	envrcCache.set(key, { found, atMs: now });
	return found;
}

/** direnv computes its diff relative to the spawning env; strip any inherited
 *  direnv state so it loads the target `.envrc` from a clean baseline. */
// Filtered parent-env baseline, versioned against live Bun.env: production
// code DOES mutate Bun.env mid-process (deferred MCP discovery sets
// EXA_API_KEY in sdk.ts after the session is usable), so a permanently
// cached baseline would spawn direnv with stale values. Key cheaply on size
// + a rolling checksum; a mismatch rebuilds. DIRENV_* values are stripped
// (direnv diffs relative to the spawning env), so they are excluded from
// both the checksum and the output.
let cleanSpawnEnvCache: { size: number; checksum: number; env: Record<string, string> } | undefined;

function envChecksum(): { size: number; checksum: number } {
	let size = 0;
	let checksum = 0;
	for (const key in Bun.env) {
		if (key.startsWith("DIRENV_")) continue;
		size++;
		for (let i = 0; i < key.length; i++) checksum = (checksum * 31 + key.charCodeAt(i)) | 0;
		const value = Bun.env[key];
		if (typeof value === "string") {
			checksum = (checksum * 31 + value.length) | 0;
			for (let i = 0; i < value.length; i++) checksum = (checksum * 31 + value.charCodeAt(i)) | 0;
		}
	}
	return { size, checksum };
}

function cleanSpawnEnv(): Record<string, string> {
	const { size, checksum } = envChecksum();
	const cached = cleanSpawnEnvCache;
	if (cached !== undefined && cached.size === size && cached.checksum === checksum) return cached.env;
	const out: Record<string, string> = {};
	for (const [key, value] of Object.entries(Bun.env)) {
		if (value !== undefined && !key.startsWith("DIRENV_")) out[key] = value;
	}
	cleanSpawnEnvCache = { size, checksum, env: out };
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

function applyExportDiff(env: Record<string, string>, diff: DirenvExportDiff): Record<string, string> {
	const loaded = { ...env, ...diff.set };
	for (const name of diff.unset) delete loaded[name];
	return loaded;
}

/** Run `direnv export json` from `env`; null when the `.envrc` is blocked or the export fails. */
async function exportDirenv(
	bin: string,
	dir: string,
	timeoutMs: number,
	env: Record<string, string>,
	signal?: AbortSignal,
): Promise<DirenvExportDiff | null> {
	const { exitCode, stdout, stderr } = await runDirenv(bin, ["export", "json"], dir, timeoutMs, env, signal);
	const blocked = stderr.includes("is blocked");
	if (exitCode === 0 && !blocked) return parseDirenvExport(stdout);
	// A not-yet-allowed .envrc is an expected steady state (the user opted
	// out by never running `direnv allow`), not an error worth warning on.
	if (blocked) {
		logger.debug("direnv .envrc not allowed; skipping", { dir });
	} else {
		logger.warn("direnv export failed", { dir, exitCode });
	}
	return null;
}

/**
 * direnv >= 2.33 exports an explicitly denied `.envrc` with exit 0 and only its
 * own `DIRENV_*` bookkeeping. Older releases fail that export as blocked and
 * print plain-text `status` (no `--json`), which reads as not denied.
 */
async function direnvDenied(
	bin: string,
	dir: string,
	timeoutMs: number,
	env: Record<string, string>,
	signal?: AbortSignal,
): Promise<boolean> {
	const { exitCode, stdout } = await runDirenv(bin, ["status", "--json"], dir, timeoutMs, env, signal);
	if (exitCode !== 0) return false;
	let status: { state?: { foundRC?: { allowed?: unknown } | null } };
	try {
		status = JSON.parse(stdout);
	} catch {
		return false;
	}
	// direnv's AllowStatus: 0 allowed, 1 not allowed, 2 denied.
	return status.state?.foundRC?.allowed === 2;
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
 * Re-invokes `direnv export json` with its previous DIRENV_* state, so direnv
 * reuses the loaded environment until a watched input changes. High-resolution
 * stats of `.envrc` and every watched path (including direnv's allow/deny
 * files) catch same-second edits that direnv's whole-second timestamps miss.
 * A warm export that reports any change is discarded and re-run cold, so a
 * revoked allow or an input the stat guard missed never leaves the result
 * relative to stale direnv state. The returned diff is always relative to the
 * clean process environment.
 */
export async function loadDirenvEnv(
	cwd: string,
	opts?: { timeoutMs?: number; signal?: AbortSignal },
): Promise<DirenvExportDiff | null> {
	const envrcPath = await findEnvrcCached(cwd);
	if (!envrcPath) return null;
	const bin = direnvBinary();
	if (!bin) return null;

	const dir = path.dirname(envrcPath);
	const timeoutMs = opts?.timeoutMs ?? DEFAULT_DIRENV_TIMEOUT_MS;
	const base = cleanSpawnEnv();
	// Captured before the export so an edit made while it runs invalidates the entry.
	const envrcStat = await fs.stat(envrcPath, { bigint: true }).catch(() => null);
	const cached = exportCache.get(dir);
	const previous =
		cached?.base === base &&
		envrcStat &&
		cached.mtimeNs === envrcStat.mtimeNs &&
		cached.size === envrcStat.size &&
		(await direnvWatchesUnchanged(cached.watches))
			? cached
			: undefined;
	exportCache.delete(dir);
	try {
		if (previous) {
			const warm = await exportDirenv(bin, dir, timeoutMs, previous.loaded, opts?.signal);
			if (!warm) return null;
			if (Object.keys(warm.set).length === 0 && warm.unset.length === 0) {
				exportCache.set(dir, previous);
				return previous.diff;
			}
		}
		const diff = await exportDirenv(bin, dir, timeoutMs, base, opts?.signal);
		if (!diff) return null;
		if (
			diff.unset.length === 0 &&
			Object.keys(diff.set).every(name => name.startsWith("DIRENV_")) &&
			(await direnvDenied(bin, dir, timeoutMs, base, opts?.signal))
		) {
			logger.debug("direnv .envrc denied; skipping", { dir });
			return null;
		}
		const loaded = applyExportDiff(base, diff);
		const watches =
			envrcStat && Object.hasOwn(loaded, "DIRENV_DIFF") && Object.hasOwn(loaded, "DIRENV_WATCHES")
				? await snapshotDirenvWatches(loaded.DIRENV_WATCHES, envrcPath)
				: null;
		// Retain state only when every watched path can be tracked.
		if (envrcStat && watches) {
			if (exportCache.size >= ENVRC_CACHE_MAX) exportCache.clear();
			exportCache.set(dir, { base, loaded, diff, mtimeNs: envrcStat.mtimeNs, size: envrcStat.size, watches });
		}
		return diff;
	} catch (err) {
		logger.warn("direnv load failed", { dir, error: err instanceof Error ? err.message : String(err) });
		return null;
	}
}
