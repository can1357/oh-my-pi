import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type * as Zlib from "node:zlib";
import { Shell } from "@oh-my-pi/pi-natives";
import { isEnoent, logger } from "@oh-my-pi/pi-utils";
import { cfgBashDirenvLoadTimeoutMs } from "./settings";

let zlibCache: typeof Zlib | undefined;

const CACHE_MAX = 512;
const MISS_TTL_MS = 5_000;
const STATE_VARS = [
	"DIRENV_DIFF",
	"DIRENV_DIR",
	"DIRENV_FILE",
	"DIRENV_WATCHES",
	"DIRENV_DUMP_FILE_PATH",
	"DIRENV_REQUIRED",
	"DIRENV_EXE_PATH",
];
const UTILITY_GATE = "PI_DISABLE_UUTILS_BUILTINS";
const TRUST_ROOT_VARS = ["HOME", "XDG_DATA_HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "DIRENV_CONFIG"];

/** Walk up to the nearest `.envrc`, optionally treating `.env` as a candidate. */
export async function findEnvrc(startDir: string, includeDotenv = false): Promise<string | null> {
	const names = includeDotenv ? [".envrc", ".env"] : [".envrc"];
	for (let dir = path.resolve(startDir); ; dir = path.dirname(dir)) {
		for (const filename of names) {
			const candidate = path.join(dir, filename);
			try {
				if ((await fs.stat(candidate)).isFile()) return candidate;
			} catch (err) {
				if (!isEnoent(err)) throw err;
			}
		}
		if (dir === path.dirname(dir)) return null;
	}
}

export interface DirenvExportDiff {
	/** Variables direnv sets to a concrete value. */
	readonly set: Readonly<Record<string, string>>;
	/** Variables direnv removes (JSON `null`). */
	readonly unset: readonly string[];
}

/** Parse the Rust builtin's `direnv export json` output into set/unset halves. */
function parseDirenvExport(jsonText: string): DirenvExportDiff {
	const data: unknown = JSON.parse(jsonText);
	if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Invalid direnv export");
	const set: Record<string, string> = Object.create(null);
	const unset: string[] = [];
	const record = data as Record<string, unknown>;
	for (const name in record) {
		if (!Object.hasOwn(record, name)) continue;
		const value = record[name];
		if (typeof value === "string") set[name] = value;
		else if (value === null) unset.push(name);
		else throw new Error("Invalid direnv export value");
	}
	return { set, unset };
}

interface DirenvWatch {
	path: string;
	stamp: string;
	mtimeNs: bigint | null;
	ctimeNs: bigint | null;
}

const misses = new Map<string, number>();
const exportCache = new Map<
	string,
	{
		base: Record<string, string>;
		envrc: string;
		diff: DirenvExportDiff;
		watches: DirenvWatch[];
	}
>();

export function clearDirenvCachesForTests(): void {
	misses.clear();
	exportCache.clear();
}

async function statWatch(watchedPath: string): Promise<DirenvWatch> {
	try {
		const link = await fs.lstat(watchedPath, { bigint: true });
		const target = link.isSymbolicLink() ? await fs.stat(watchedPath, { bigint: true }) : link;
		const mtimeNs = link.mtimeNs > target.mtimeNs ? link.mtimeNs : target.mtimeNs;
		const stamp = `${link.dev}:${link.ino}:${link.ctimeNs}:${link.mtimeNs}:${target.dev}:${target.ino}:${target.ctimeNs}:${target.mtimeNs}:${target.size}`;
		const ctimeNs = link.ctimeNs > target.ctimeNs ? link.ctimeNs : target.ctimeNs;
		return { path: watchedPath, stamp, mtimeNs, ctimeNs };
	} catch (err) {
		if (!isEnoent(err)) throw err;
		return { path: watchedPath, stamp: "missing", mtimeNs: null, ctimeNs: null };
	}
}

async function snapshotNativeWatches(
	encoded: string,
	envrc: string,
	loadStartedNs: bigint,
	signal: AbortSignal,
): Promise<DirenvWatch[] | null> {
	try {
		zlibCache ??= require("node:zlib") as typeof Zlib;
		const decoded: unknown = JSON.parse(zlibCache.inflateSync(Buffer.from(encoded, "base64url")).toString("utf8"));
		if (!Array.isArray(decoded) || decoded.length === 0) return null;
		const watches: DirenvWatch[] = [];
		let rootPinned = false;
		for (const watch of decoded) {
			signal.throwIfAborted();
			if (
				!watch ||
				typeof watch.path !== "string" ||
				!path.isAbsolute(watch.path) ||
				typeof watch.modtime !== "number" ||
				typeof watch.exists !== "boolean"
			)
				return null;
			const snapshot = await statWatch(watch.path);
			if ((snapshot.mtimeNs !== null) !== watch.exists) return null;
			if (snapshot.mtimeNs !== null && snapshot.mtimeNs / 1_000_000_000n !== BigInt(watch.modtime)) return null;
			// A pinned input (the root or a require_allowed file) was approved by
			// content, not timestamp. Bind our finer stat to those same bytes.
			if (watch.hash !== undefined) {
				if (typeof watch.hash !== "string" || !watch.exists) return null;
				const bytes = await fs.readFile(watch.path, { signal });
				if (createHash("sha256").update(`${watch.path}\n`).update(bytes).digest("hex") !== watch.hash) return null;
				if (watch.path === envrc) rootPinned = true;
			} else if (snapshot.ctimeNs !== null && snapshot.ctimeNs >= loadStartedNs) {
				// Only a whole-second observation came from the builtin. If this
				// input was touched during evaluation, its new high-resolution
				// stamp can't vouch for the bytes that produced the diff.
				return null;
			}
			if (watch.path !== envrc) watches.push(snapshot);
		}
		return rootPinned ? watches : null;
	} catch {
		return null;
	}
}

async function watchesUnchanged(watches: DirenvWatch[], signal: AbortSignal): Promise<boolean> {
	for (const watch of watches) {
		signal.throwIfAborted();
		if ((await statWatch(watch.path)).stamp !== watch.stamp) return false;
	}
	signal.throwIfAborted();
	return true;
}

function cleanEnv(): Record<string, string> {
	const env: Record<string, string> = Object.create(null);
	for (const name in Bun.env) {
		const value = Bun.env[name];
		if (value !== undefined && !STATE_VARS.includes(name)) env[name] = value;
	}
	return env;
}

function sameEnv(previous: Record<string, string>, current: Record<string, string>): boolean {
	for (const name in previous) if (previous[name] !== current[name]) return false;
	for (const name in current) if (!Object.hasOwn(previous, name)) return false;
	return true;
}

async function configWatches(env: Record<string, string>): Promise<DirenvWatch[]> {
	const conf = env.DIRENV_CONFIG || path.join(env.XDG_CONFIG_HOME || path.join(env.HOME, ".config"), "direnv");
	const libDir = path.join(conf, "lib");
	const watchedPaths = [
		path.join(conf, "direnv.toml"),
		path.join(conf, "config.toml"),
		path.join(conf, "direnvrc"),
		path.join(env.HOME || path.sep, ".direnvrc"),
	];
	// Pin the directory before listing it so concurrent additions cannot get
	// a fresh directory stamp while being omitted from its member watches.
	const libWatch = await statWatch(libDir);
	const libs = await fs.readdir(libDir).catch(err => {
		if (isEnoent(err) || (err as NodeJS.ErrnoException).code === "ENOTDIR") return [];
		throw err;
	});
	for (const lib of libs) if (lib.endsWith(".sh")) watchedPaths.push(path.join(libDir, lib));
	return [libWatch, ...(await Promise.all(watchedPaths.map(statWatch)))];
}

async function runBuiltin(
	shell: Shell,
	command: "export json" | "status --json",
	cwd: string,
	signal: AbortSignal,
	base: Record<string, string>,
): Promise<{ exitCode?: number; stdout: string }> {
	// The native session inherits the host env *under* its Bun-provided
	// overlay. Clear absent trust roots as well as hook state so an unset
	// DIRENV_CONFIG, for example, can't select a different approval policy.
	const unset = [...STATE_VARS];
	for (const name of [...TRUST_ROOT_VARS, "DIRENV_DISABLE", UTILITY_GATE]) {
		if (!(name in base)) unset.push(name);
	}
	let output = "";
	const result = await shell.run(
		{
			command: `unset -v ${unset.join(" ")}\n[[ $(type -t direnv) == builtin ]] || exit 127\ncommand direnv ${command} 2>/dev/null`,
			cwd,
			env: UTILITY_GATE in base ? { [UTILITY_GATE]: base[UTILITY_GATE] } : undefined,
			signal,
		},
		(_error, chunk) => {
			output += chunk;
		},
	);
	return { exitCode: result.exitCode, stdout: output };
}

async function allowedFile(
	shell: Shell,
	dir: string,
	signal: AbortSignal,
	base: Record<string, string>,
): Promise<string | null> {
	const status = await runBuiltin(shell, "status --json", dir, signal, base);
	if (status.exitCode !== 0 || signal.aborted) return null;
	const found = JSON.parse(status.stdout).state?.foundRC;
	return found?.allowed === 0 && typeof found.path === "string" && path.isAbsolute(found.path) ? found.path : null;
}

/** Load a project environment with omp-shell's native direnv builtin. */
export async function loadDirenvEnv(
	cwd: string,
	opts?: { timeoutMs?: number; signal?: AbortSignal },
): Promise<DirenvExportDiff | null> {
	let signal = opts?.signal;
	try {
		const budget = AbortSignal.timeout(opts?.timeoutMs ?? cfgBashDirenvLoadTimeoutMs.default);
		signal = signal ? AbortSignal.any([signal, budget]) : budget;
		signal.throwIfAborted();
		const key = path.resolve(cwd);
		const miss = misses.get(key);
		if (miss !== undefined && Date.now() - miss < MISS_TTL_MS) return null;
		const candidate = await findEnvrc(await fs.realpath(key), true);
		if (!candidate) {
			if (misses.size >= CACHE_MAX) misses.clear();
			misses.set(key, Date.now());
			return null;
		}
		const candidateDir = path.dirname(candidate);
		const base = cleanEnv();
		// XDG bases should be absolute. A relative base would allow a repository
		// to supply files where the embedded builtin expects the user's trust store.
		if (!base.HOME && (!base.XDG_DATA_HOME || !base.XDG_CACHE_HOME || !(base.XDG_CONFIG_HOME || base.DIRENV_CONFIG)))
			return null;
		for (const name of TRUST_ROOT_VARS) {
			if (base[name] && !path.isAbsolute(base[name])) return null;
		}
		const cached = exportCache.get(candidate);
		if (
			cached &&
			sameEnv(cached.base, base) &&
			(cached.envrc === candidate || (await findEnvrc(candidateDir)) === cached.envrc) &&
			(await watchesUnchanged(cached.watches, signal))
		)
			return cached.diff;
		exportCache.delete(candidate);
		const config = await configWatches(base);
		signal.throwIfAborted();
		const shell = new Shell({ sessionEnv: { ...base, [UTILITY_GATE]: "0" } });
		// Only the builtin knows whether load_dotenv is enabled. A nearer .env
		// must not mask a parent's .envrc or change its startup directory.
		const envrc =
			path.basename(candidate) === ".env" ? await allowedFile(shell, candidateDir, signal, base) : candidate;
		if (!envrc) return null;
		const dir = path.dirname(envrc);
		const rc = await statWatch(envrc);
		const loadStartedNs = BigInt(Math.trunc((performance.timeOrigin + performance.now()) * 1e6));
		const { exitCode, stdout } = await runBuiltin(shell, "export json", dir, signal, base);
		if (signal.aborted || exitCode !== 0 || !stdout.trim()) return null;
		const diff = parseDirenvExport(stdout);
		if (diff.set.DIRENV_REQUIRED || diff.set.DIRENV_FILE !== envrc) return null;
		if (diff.unset.length === 0 && Object.keys(diff.set).every(name => name.startsWith("DIRENV_"))) {
			// The builtin's public export protocol returns only its bookkeeping
			// and exits successfully on denial. Don't merge that state into Bash.
			if ((await allowedFile(shell, dir, signal, base)) !== envrc) return null;
		}
		// High-resolution stats supplement direnv's whole-second watch protocol.
		// Pin the pre-run envrc and config stats, never ones taken after execution.
		if (diff.set.DIRENV_WATCHES) {
			const watches = await snapshotNativeWatches(diff.set.DIRENV_WATCHES, envrc, loadStartedNs, signal);
			if (watches && (await watchesUnchanged([rc, ...config], signal))) {
				if (exportCache.size >= CACHE_MAX) exportCache.clear();
				exportCache.set(candidate, { base, envrc, diff, watches: [rc, ...config, ...watches] });
			}
		}
		return signal.aborted ? null : diff;
	} catch (err) {
		if (!signal?.aborted)
			logger.warn("embedded direnv load failed", { cwd, error: err instanceof Error ? err.message : String(err) });
		return null;
	}
}
