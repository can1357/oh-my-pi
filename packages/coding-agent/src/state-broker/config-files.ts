/**
 * File-layer replication for the agent config directory (`~/.omp/agent`).
 *
 * Replication happens BELOW `Settings`: we copy raw files, not parsed config.
 * That keeps `Settings`' load/write/lock logic completely untouched — the
 * config domain never calls into it. A file is the merge unit; its mtime is the
 * logical clock (`rev`).
 *
 * Only a curated set of files follows a user between machines. The exclude set
 * is deliberately conservative: a broker peer is not fully trusted, so anything
 * carrying raw secrets or per-machine identity is kept local.
 */

import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Files (relative to the agent dir) that SHOULD follow a user between machines.
 *
 * Directory trees (`agents/`, `managed-skills/`) are enumerated recursively and
 * filtered by {@link REPLICABLE_EXTENSIONS}; the named entries here are the
 * top-level single files.
 */
export const REPLICATED_CONFIG_FILES: readonly string[] = [
	"config.yml",
	"models.yml",
	"keybindings.yml",
	"mcp.json",
	"ssh.json",
] as const;

/** Directory subtrees walked recursively, keeping only {@link REPLICABLE_EXTENSIONS}. */
const REPLICATED_CONFIG_DIRS: readonly string[] = ["agents", "managed-skills"] as const;

/** Content types worth replicating inside {@link REPLICATED_CONFIG_DIRS}. */
const REPLICABLE_EXTENSIONS: Record<string, true> = { ".yml": true, ".yaml": true, ".json": true, ".md": true };

/**
 * Basenames that are NEVER replicated, each excluded for a concrete reason:
 *
 * - `.env`, `secrets.yml` — raw secrets. Sharing them through a state broker
 *   widens blast radius far beyond what the auth-broker's redaction model
 *   guarantees; credentials belong in the auth broker, not here.
 * - `secret-placeholder.key` — an HMAC key; same secret-material concern.
 * - `auth-broker.token` — the broker bearer; a machine authenticates itself.
 * - `kimi-device-id`, `install-id` — per-machine identity. Replicating them
 *   would collide usage attribution across machines.
 * - `last-changelog-version` — per-machine "have I seen the changelog" marker.
 * - `gc.lock` — a lock file, meaningless on another host.
 * - `omp-crash.log`, `omp-debug.log` — per-machine logs, pure noise.
 * - `agent.db`, `history.db`, `models.db`, `state.db`, `state-sync.db` — these
 *   are replicated by their own domains (or are pure derived cache); copying the
 *   raw sqlite file would fight those domains and risk a torn database.
 * - `projects.yml` — the machine-specific map from logical project id to THIS
 *   machine's checkout path (`~/projects/foo` here, `~/dev/foo` there). It is the
 *   very table the sync layer translates paths THROUGH; replicating it would
 *   overwrite each machine's local paths with another's and break every
 *   cross-machine path translation. It must stay strictly per-machine.
 */
const EXCLUDED_BASENAMES: Record<string, true> = {
	".env": true,
	"secrets.yml": true,
	"secret-placeholder.key": true,
	"auth-broker.token": true,
	"kimi-device-id": true,
	"install-id": true,
	"last-changelog-version": true,
	"gc.lock": true,
	"omp-crash.log": true,
	"omp-debug.log": true,
	"agent.db": true,
	"history.db": true,
	"models.db": true,
	"state.db": true,
	"state-sync.db": true,
	"projects.yml": true,
};

/**
 * Top-level directories that are never descended into: caches, bulk content
 * (moved over S3 by the object-store slice, not the JSON broker), and other
 * per-machine or derived state.
 */
const EXCLUDED_DIRS: Record<string, true> = {
	cache: true,
	blobs: true,
	sessions: true,
	"terminal-sessions": true,
	memories: true,
	"python-gateway": true,
};

/**
 * Size ceiling for a replicated config file (1 MiB). A "config file" larger than
 * this is not a config file — refuse it rather than shipping megabytes over the
 * JSON broker.
 */
export const MAX_CONFIG_FILE_BYTES = 1024 * 1024;

/**
 * Resolve `rel` against `agentDir` and reject anything that escapes it.
 *
 * A broker peer is not fully trusted, so an incoming `rel` (`../`, absolute, or
 * a symlink target outside the dir once normalized) must never be written or
 * read. Returns the absolute path; throws for a traversal attempt.
 */
function resolveInsideAgentDir(agentDir: string, rel: string): string {
	if (path.isAbsolute(rel)) {
		throw new Error(`config replication: absolute path rejected: ${rel}`);
	}
	const base = path.resolve(agentDir);
	const abs = path.resolve(base, rel);
	// `base + sep` prevents a sibling like `/x/agent-evil` from passing.
	if (abs !== base && !abs.startsWith(base + path.sep)) {
		throw new Error(`config replication: path escapes agent dir: ${rel}`);
	}
	return abs;
}

/** One replicable file with the metadata `enumerateConfigFiles` cares about. */
export interface ConfigFileStat {
	/** Path relative to the agent dir, using the local `path.sep`. */
	rel: string;
	/** File mtime in epoch millis — the replication `rev`. */
	mtimeMs: number;
	/** Size in bytes; used to enforce {@link MAX_CONFIG_FILE_BYTES}. */
	size: number;
}

/** True when `abs` is a replicable regular file within the size cap. */
function statReplicable(abs: string): fs.Stats | null {
	let st: fs.Stats;
	try {
		st = fs.statSync(abs);
	} catch {
		return null;
	}
	if (!st.isFile()) return null;
	if (st.size > MAX_CONFIG_FILE_BYTES) return null;
	return st;
}

/** Recursively collect replicable files under `dirAbs`, pushing `{rel,...}` rows. */
function walkDir(agentDir: string, dirRel: string, out: ConfigFileStat[]): void {
	const dirAbs = path.resolve(agentDir, dirRel);
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dirAbs, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		const childRel = path.join(dirRel, entry.name);
		if (entry.isDirectory()) {
			walkDir(agentDir, childRel, out);
			continue;
		}
		if (!entry.isFile()) continue;
		if (Object.hasOwn(EXCLUDED_BASENAMES, entry.name)) continue;
		if (!Object.hasOwn(REPLICABLE_EXTENSIONS, path.extname(entry.name).toLowerCase())) continue;
		const abs = path.resolve(agentDir, childRel);
		const st = statReplicable(abs);
		if (!st) continue;
		out.push({ rel: childRel, mtimeMs: st.mtimeMs, size: st.size });
	}
}

/**
 * Enumerate every replicable config file under `agentDir`, honouring the
 * include/exclude sets and the {@link MAX_CONFIG_FILE_BYTES} cap. Missing files
 * are simply omitted; nothing here throws.
 */
export function enumerateConfigFiles(agentDir: string): ConfigFileStat[] {
	const out: ConfigFileStat[] = [];
	for (const rel of REPLICATED_CONFIG_FILES) {
		if (Object.hasOwn(EXCLUDED_BASENAMES, rel)) continue;
		const abs = path.resolve(agentDir, rel);
		const st = statReplicable(abs);
		if (!st) continue;
		out.push({ rel, mtimeMs: st.mtimeMs, size: st.size });
	}
	for (const dirRel of REPLICATED_CONFIG_DIRS) {
		if (Object.hasOwn(EXCLUDED_DIRS, dirRel)) continue;
		walkDir(agentDir, dirRel, out);
	}
	return out;
}

/**
 * Read a config file's UTF-8 content, or `null` when it is absent, unreadable,
 * or over the size cap. Rejects a `rel` that escapes the agent dir.
 */
export function readConfigFile(agentDir: string, rel: string): string | null {
	const abs = resolveInsideAgentDir(agentDir, rel);
	const st = statReplicable(abs);
	if (!st) return null;
	try {
		return fs.readFileSync(abs, "utf8");
	} catch {
		return null;
	}
}

/**
 * Atomically write `content` to `rel` and stamp its mtime to `mtimeMs`.
 *
 * The write is temp-file + `renameSync` in the SAME directory (rename is atomic
 * only within a filesystem), so a concurrent reader never observes a torn file.
 * The parent is created as needed. Finally the mtime is forced to the remote
 * `rev` so the round trip is stable — the file does not immediately look
 * "newer than remote" and re-push. Rejects a traversal `rel`.
 */
export function writeConfigFileAtomic(agentDir: string, rel: string, content: string, mtimeMs: number): void {
	const abs = resolveInsideAgentDir(agentDir, rel);
	const dir = path.dirname(abs);
	fs.mkdirSync(dir, { recursive: true });
	const tmp = path.join(dir, `.${path.basename(abs)}.${process.pid}.${Date.now()}.tmp`);
	fs.writeFileSync(tmp, content);
	try {
		fs.renameSync(tmp, abs);
	} catch (error) {
		try {
			fs.rmSync(tmp, { force: true });
		} catch {
			// best-effort temp cleanup; original error is the one that matters.
		}
		throw error;
	}
	// mtime is the replication clock: pin it to the remote rev in seconds.
	const seconds = mtimeMs / 1000;
	fs.utimesSync(abs, seconds, seconds);
}

/** Delete `rel` if present. Rejects a traversal `rel`; a missing file is a no-op. */
export function deleteConfigFile(agentDir: string, rel: string): void {
	const abs = resolveInsideAgentDir(agentDir, rel);
	fs.rmSync(abs, { force: true });
}

/**
 * Local mtime of `rel` in epoch millis, or `null` when the file is absent.
 * Rejects a traversal `rel`. Used by the merge path to compare against a remote
 * `rev` before overwriting or unlinking.
 */
export function configFileMtimeMs(agentDir: string, rel: string): number | null {
	const abs = resolveInsideAgentDir(agentDir, rel);
	try {
		return fs.statSync(abs).mtimeMs;
	} catch {
		return null;
	}
}
