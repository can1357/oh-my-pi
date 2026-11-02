/**
 * Sessions roots that hold an agent directory's sessions.
 *
 * `OMP_SESSIONS_DIR` chooses where new sessions are written. A session already
 * written stays in the root it was written to, while its image blobs, stats and
 * history stay with the agent directory. So each process records the root the
 * variable selects, and the readers that decide what still exists (`omp gc`,
 * `omp stats`) read every recorded root, whatever the variable says when they run.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentSessionsDir, getSessionRootsDir, getSessionsDir, normalizePathForComparison } from "./dirs";
import { isEnoent } from "./fs-error";
import * as logger from "./logger";

/** Suffix of an entry still being written; it is renamed into place once complete. */
const STAGING_SUFFIX = ".tmp";

/** Registry entries this process wrote or found current, so each costs one read per process. */
const recordedEntries = new Set<string>();

/**
 * Record the sessions root `OMP_SESSIONS_DIR` selects for `agentDir` (default:
 * the active agent directory), so later processes read its sessions whatever
 * the variable says then. No-op while the agent directory uses its own
 * `sessions`, which {@link getSessionsRoots} always lists.
 *
 * Best effort, like the custom-session-file markers: a failure is logged and
 * retried on the next call, never thrown into session creation.
 */
export function registerSessionsRoot(agentDir?: string): void {
	const root = getSessionsDir(agentDir);
	if (root === getAgentSessionsDir(agentDir)) return;
	// The root's full 64-bit hash names its entry, so two roots never share one.
	const entry = path.join(getSessionRootsDir(agentDir), Bun.hash(root).toString(16).padStart(16, "0"));
	if (recordedEntries.has(entry)) return;
	try {
		let recorded: string | undefined;
		try {
			recorded = fs.readFileSync(entry, "utf8");
		} catch (err) {
			if (!isEnoent(err)) throw err;
		}
		if (recorded !== root) {
			// Renamed into place, so a concurrent reader never sees half a path.
			const staging = `${entry}.${process.pid}${STAGING_SUFFIX}`;
			fs.mkdirSync(path.dirname(entry), { recursive: true });
			fs.writeFileSync(staging, root);
			fs.renameSync(staging, entry);
		}
		recordedEntries.add(entry);
	} catch (err) {
		logger.warn("Failed to record the sessions root", { root, entry, error: String(err) });
	}
}

/**
 * Every sessions root that can hold `agentDir`'s sessions (default: the active
 * agent directory): the one in use, the agent directory's own `sessions`, and
 * each root {@link registerSessionsRoot} recorded. A recorded root that no
 * longer exists is still listed and reads as empty. An unreadable registry
 * throws: a caller deciding what to delete must not act on a partial list.
 */
export function getSessionsRoots(agentDir?: string): string[] {
	const roots = new Map<string, string>();
	const add = (root: string) => {
		const key = normalizePathForComparison(root);
		if (!roots.has(key)) roots.set(key, root);
	};
	add(getSessionsDir(agentDir));
	add(getAgentSessionsDir(agentDir));
	const registry = getSessionRootsDir(agentDir);
	let entries: string[];
	try {
		entries = fs.readdirSync(registry);
	} catch (err) {
		if (isEnoent(err)) return [...roots.values()];
		throw err;
	}
	for (const name of entries.sort()) {
		if (name.endsWith(STAGING_SUFFIX)) continue;
		let recorded: string;
		try {
			recorded = fs.readFileSync(path.join(registry, name), "utf8").trim();
		} catch (err) {
			if (isEnoent(err)) continue;
			throw err;
		}
		if (path.isAbsolute(recorded)) add(path.resolve(recorded));
	}
	return [...roots.values()];
}

/**
 * The deepest of `roots` holding `file` (compared as spelled, the way readers
 * list files under each root), or undefined when none does.
 */
export function findSessionsRoot(file: string, roots: readonly string[] = getSessionsRoots()): string | undefined {
	let found: string | undefined;
	for (const root of roots) {
		const relative = path.relative(root, file);
		if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) continue;
		if (!found || root.length > found.length) found = root;
	}
	return found;
}
