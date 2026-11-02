/**
 * Sessions roots that hold an agent directory's sessions.
 *
 * `OMP_SESSIONS_DIR` chooses where new sessions are written. A session already
 * written stays in the root it was written to, while its image blobs, stats and
 * history stay with the agent directory. So every root omp writes sessions to
 * is recorded, and `omp gc` deletes a blob only when the record proves it has
 * read every root: any doubt about the record or about a recorded root keeps
 * every blob, with the reason reported.
 *
 * The record is kept twice, in the agent directory's state (`sessions-roots/`)
 * and beside the blobs it protects (`blobs/sessions-roots/`), so losing or
 * damaging one copy shows as a disagreement instead of a shorter list. Each
 * entry is named by a hash of its root and holds the root exactly, with the
 * device and inode of the directory that was there, so an unmounted disk (an
 * empty mount point in its place) or a replaced directory is told apart from
 * an empty root.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import {
	getAgentSessionsDir,
	getBlobsDir,
	getSessionRootsDir,
	getSessionsDir,
	normalizePathForComparison,
} from "./dirs";
import { isEnoent } from "./fs-error";
import * as logger from "./logger";

/** Suffix of an entry still being written; it is renamed into place once complete. */
const STAGING_SUFFIX = ".tmp";

/** One recorded root: its exact path and the identity of the directory recorded there. */
interface RootRecord {
	root: string;
	dev: string;
	ino: string;
}

/** Roots this process recorded, keyed by registry and root, so each costs its reads once per process. */
const recordedRoots = new Set<string>();

/** The root's full 64-bit hash names its entry, so two roots never share one. */
function entryName(root: string): string {
	return Bun.hash(root).toString(16).padStart(16, "0");
}

/** Both copies of the registry: the agent directory's state, and beside the blobs. */
function registryCopies(agentDir: string | undefined): string[] {
	return [getSessionRootsDir(agentDir), path.join(getBlobsDir(agentDir), "sessions-roots")];
}

/** The record an entry holds, or why it cannot be trusted. */
function parseEntry(name: string, text: string): RootRecord | string {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return "is not a complete record";
	}
	if (!value || typeof value !== "object") return "is not a record";
	const { root, dev, ino } = value as Record<string, unknown>;
	if (typeof root !== "string" || typeof dev !== "string" || typeof ino !== "string") {
		return "lacks its root or the identity of its directory";
	}
	if (!path.isAbsolute(root) || path.resolve(root) !== root) return "names a path that is not absolute";
	if (entryName(root) !== name) return "names a root other than the one its file name records";
	return { root, dev, ino };
}

/** Write `text` exactly, under a temporary name renamed into place so no reader sees part of it. */
function writeEntry(file: string, text: string): void {
	const staging = `${file}.${process.pid}-${Math.random().toString(36).slice(2)}${STAGING_SUFFIX}`;
	fs.mkdirSync(path.dirname(file), { recursive: true });
	try {
		fs.writeFileSync(staging, text);
		fs.renameSync(staging, file);
	} catch (err) {
		fs.rmSync(staging, { force: true });
		throw err;
	}
}

/** Why the directory at a recorded root is not the one recorded, or undefined when it is. */
function rootUnavailable(record: RootRecord): string | undefined {
	let stat: fs.BigIntStats;
	try {
		stat = fs.statSync(record.root, { bigint: true });
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		return code === "ENOENT" || code === "ENOTDIR" ? "is missing" : `cannot be read (${String(err)})`;
	}
	if (!stat.isDirectory()) return "is not a directory";
	if (String(stat.dev) !== record.dev || String(stat.ino) !== record.ino) {
		return "is not the directory that was recorded there (is its disk unmounted, or was it replaced?)";
	}
	try {
		fs.accessSync(record.root, fs.constants.R_OK | fs.constants.X_OK);
	} catch (err) {
		return `cannot be read (${String(err)})`;
	}
	return undefined;
}

/**
 * Record `root` as holding `agentDir`'s sessions (default: the active agent
 * directory) in both copies of the registry, with the identity of the
 * directory now at that path. An existing record of `root` is kept as it is.
 *
 * Throws when `root` is not a directory, when a record of it is damaged or
 * names another directory (omp then refuses to write sessions there, since gc
 * could not prove it reads them), and when neither copy could be written. When
 * only one copy could be written the copies disagree, which keeps every blob
 * until the record is repaired; that is logged, not thrown.
 */
export function recordSessionsRoot(root: string, agentDir?: string): void {
	const stat = fs.statSync(root, { bigint: true });
	if (!stat.isDirectory()) throw new Error(`Sessions root ${root} is not a directory`);
	const record: RootRecord = { root, dev: String(stat.dev), ino: String(stat.ino) };
	const name = entryName(root);
	const files = registryCopies(agentDir).map(dir => path.join(dir, name));
	const fix = `if its sessions are gone, or were moved here on purpose, remove ${files.join(" and ")} and start omp again`;
	const failures: string[] = [];
	let recorded = 0;
	for (const file of files) {
		let existing: string | undefined;
		try {
			existing = fs.readFileSync(file, "utf8");
		} catch (err) {
			if (!isEnoent(err)) {
				failures.push(String(err));
				continue;
			}
		}
		if (existing !== undefined) {
			const parsed = parseEntry(name, existing);
			if (typeof parsed === "string")
				throw new Error(`The record of sessions root ${root} at ${file} ${parsed}; ${fix}`);
			if (parsed.dev !== record.dev || parsed.ino !== record.ino) {
				throw new Error(
					`Sessions root ${root} is not the directory recorded at ${file} (is its disk unmounted, or was it replaced?); ${fix}`,
				);
			}
			recorded += 1;
			continue;
		}
		try {
			writeEntry(file, JSON.stringify(record));
			recorded += 1;
		} catch (err) {
			failures.push(String(err));
		}
	}
	if (recorded === 0) throw new Error(`Cannot record sessions root ${root}: ${failures.join("; ")}`);
	if (failures.length > 0) {
		logger.warn("Recorded the sessions root in one copy only; omp gc keeps every blob until both copies agree", {
			root,
			failures,
		});
	}
}

/**
 * Record the sessions root `OMP_SESSIONS_DIR` selects for `agentDir` (default:
 * the active agent directory) once the directory exists. No-op while the agent
 * directory uses its own `sessions`, which every reader includes anyway.
 * Throws as {@link recordSessionsRoot} does: a caller about to write a session
 * there must not write it unrecorded.
 */
export function registerSessionsRoot(agentDir?: string): void {
	const root = getSessionsDir(agentDir);
	if (root === getAgentSessionsDir(agentDir)) return;
	const key = `${getSessionRootsDir(agentDir)}\0${root}`;
	if (recordedRoots.has(key) || !fs.existsSync(root)) return;
	recordSessionsRoot(root, agentDir);
	recordedRoots.add(key);
}

/** What {@link scanSessionsRoots} found. */
export interface SessionsRootsScan {
	/**
	 * Roots to read: the one in use, the agent directory's own `sessions`, and
	 * every recorded root whose directory is the one recorded.
	 */
	roots: string[];
	/** Why the record cannot be trusted to name every root holding sessions; empty when it can. */
	problems: string[];
}

/**
 * Every sessions root that can hold `agentDir`'s sessions (default: the active
 * agent directory), and every reason to doubt the list is complete: a copy of
 * the registry that cannot be read, an entry missing from one copy, damaged, or
 * different between them, and a recorded root that is missing, not a
 * directory, unreadable, or another directory than the one recorded. Never
 * throws. A caller that deletes must act only when `problems` is empty.
 */
export function scanSessionsRoots(agentDir?: string): SessionsRootsScan {
	const roots = new Map<string, string>();
	const add = (root: string) => {
		const key = normalizePathForComparison(root);
		if (!roots.has(key)) roots.set(key, root);
	};
	add(getSessionsDir(agentDir));
	add(getAgentSessionsDir(agentDir));
	const problems: string[] = [];
	const copies = registryCopies(agentDir).map(dir => {
		const texts = new Map<string, string>();
		let names: string[] = [];
		try {
			names = fs.readdirSync(dir);
		} catch (err) {
			if (!isEnoent(err)) problems.push(`the sessions-root registry ${dir} cannot be read (${String(err)})`);
		}
		for (const name of names) {
			if (name.endsWith(STAGING_SUFFIX)) continue;
			const file = path.join(dir, name);
			try {
				texts.set(name, fs.readFileSync(file, "utf8"));
			} catch (err) {
				problems.push(`the sessions-root record ${file} cannot be read (${String(err)})`);
			}
		}
		return { dir, texts };
	});
	const names = new Set(copies.flatMap(copy => [...copy.texts.keys()]));
	for (const name of [...names].sort()) {
		let record: RootRecord | undefined;
		for (const { dir, texts } of copies) {
			const file = path.join(dir, name);
			const text = texts.get(name);
			if (text === undefined) {
				problems.push(`the sessions-root record ${name} is missing from ${dir}`);
				continue;
			}
			const parsed = parseEntry(name, text);
			if (typeof parsed === "string") {
				problems.push(`the sessions-root record ${file} ${parsed}`);
			} else if (!record) {
				record = parsed;
			} else if (parsed.root !== record.root || parsed.dev !== record.dev || parsed.ino !== record.ino) {
				problems.push(`the copies of sessions-root record ${name} disagree`);
			}
		}
		if (!record) continue;
		const unavailable = rootUnavailable(record);
		if (unavailable) {
			problems.push(`recorded sessions root ${JSON.stringify(record.root)} ${unavailable}`);
			continue;
		}
		add(record.root);
	}
	return { roots: [...roots.values()], problems };
}

/**
 * The sessions roots {@link scanSessionsRoots} can read, for readers that only
 * list (stats); a caller that deletes must use the scan and its problems.
 */
export function getSessionsRoots(agentDir?: string): string[] {
	return scanSessionsRoots(agentDir).roots;
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
