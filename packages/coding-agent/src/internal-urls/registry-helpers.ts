/**
 * Shared helpers for internal-url protocol handlers that resolve IDs against
 * registered agent sessions.
 */

import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils";
import { AgentRegistry } from "../registry/agent-registry";
import { ARTIFACT_STAGING_SUFFIX } from "../session/artifact-staging";
import { whenArtifactCopiesSettle } from "../session/session-manager";

const extraArtifactsDirs = new Set<string>();
/** Deepest nesting `sessionFilesFromDisk` descends below an artifacts dir. */
const MAX_SCAN_DEPTH = 8;

export function registerArtifactsDir(dir: string): () => void {
	extraArtifactsDirs.add(dir);
	return () => {
		extraArtifactsDirs.delete(dir);
	};
}

export function resetRegisteredArtifactDirsForTests(): void {
	extraArtifactsDirs.clear();
}

/**
 * Snapshot of artifacts dirs for every registered session, deduped.
 *
 * Collects TWO candidate dirs per ref, because a subagent reads from its
 * adopted (root-wide) `ArtifactManager.dir` but its own children are written
 * one level deeper, under `sessionFile.slice(0, -6)` (`task/index.ts`). A
 * depth-2+ subagent's output therefore lives in the write-time dir, not the
 * adopted one, so `agent://` must scan both or it 404s a live nested peer.
 * `addDir` dedup collapses the depth-0 case (both formulas agree) back to a
 * single entry.
 *
 * When `options.preferredDir` is supplied — the caller root's canonical
 * artifact directory, derived from the caller's session file — it is inserted
 * FIRST, ahead of every registry-derived dir. Under A/B same-id conflicts the
 * caller's own root must win even when the process-global registry's single
 * `Main` ref belongs to another root (or the caller's session is not
 * registered at all). Absent a preferred dir, the pre-existing process-global
 * ordering is preserved unchanged.
 */
export function artifactsDirsFromRegistry(options?: { preferredDir?: string }): string[] {
	const dirs: string[] = [];
	const addDir = (dir: string | null | undefined) => {
		if (!dir) return;
		if (!dirs.includes(dir)) dirs.push(dir);
	};
	if (options?.preferredDir) addDir(options.preferredDir);
	for (const ref of AgentRegistry.global().list()) {
		addDir(ref.session?.sessionManager?.getArtifactsDir());
		if (ref.sessionFile) addDir(ref.sessionFile.slice(0, -6));
	}
	for (const dir of extraArtifactsDirs) addDir(dir);
	return dirs;
}

/** How {@link sessionFilesFromDisk} scans. */
interface SessionFileScan {
	/** Scan only the directory passed, not every registered one. */
	onlyPreferred?: boolean;
	/**
	 * `false` lists the directories as they are, mid-copy or not. Only for a
	 * caller whose result is a suggestion — a completion list, an availability
	 * probe — and that would rather be briefly incomplete than wait on a copy.
	 */
	waitForCopies?: boolean;
	/** Cancels the wait for copies. */
	signal?: AbortSignal;
}

/**
 * Recursively scan artifacts dirs for agent session transcripts, keyed by
 * agent id (the `.jsonl` basename). Used by `history://` so transcripts of
 * agents no longer in the registry (unregistered one-shot helpers, released
 * agents, or any agent after session resume) remain reachable — mirroring how
 * `agent://` reads `.md` outputs straight off disk.
 *
 * Layout follows `task/index.ts`: a subagent's transcript is
 * `<artifactsDir>/<AgentId>.jsonl`, and its own children nest one level deeper
 * under `<artifactsDir>/<AgentId>/<AgentId>.<ChildId>.jsonl`. Advisor
 * transcripts (`__advisor*.jsonl`) are observability-only and excluded;
 * EPERM-rewrite backups (`.bak`) are skipped. When the same id appears in
 * multiple dirs, the first hit wins (registry dirs are scanned first; a
 * `preferredDir` from the caller root is scanned before them). Directory
 * listings are prefetched in parallel; the walk itself stays a sequential
 * depth-first pass so first-hit order is unaffected. In `onlyPreferred` mode,
 * only the supplied directory is scanned, with direct files before descendants.
 * `preserveDuplicates` retains every candidate path per id for ambiguity checks.
 *
 * The scan waits for the artifact copies this process is running into the
 * directories it reads. A fork inherits its parent's subagent transcripts by
 * copy, and a scan taken while one is arriving reports an inherited agent as
 * one that does not exist.
 */
export function sessionFilesFromDisk(
	preferredDir: string | undefined,
	options: SessionFileScan & { preserveDuplicates: true },
): Promise<Map<string, string[]>>;
export function sessionFilesFromDisk(
	preferredDir?: string,
	options?: SessionFileScan & { preserveDuplicates?: false },
): Promise<Map<string, string>>;
export async function sessionFilesFromDisk(
	preferredDir?: string,
	options?: SessionFileScan & { preserveDuplicates?: boolean },
): Promise<Map<string, string> | Map<string, string[]>> {
	const dirs = options?.onlyPreferred ? [] : artifactsDirsFromRegistry();
	if (preferredDir) dirs.unshift(preferredDir);
	if (options?.waitForCopies !== false) {
		for (const dir of dirs) await whenArtifactCopiesSettle(dir, options?.signal);
	}
	const listings = new Map<string, Promise<Dirent[] | null>>();
	const list = (dir: string, depth: number): Promise<Dirent[] | null> => {
		let listing = listings.get(dir);
		if (listing) return listing;
		listing = readDirEntries(dir);
		listings.set(dir, listing);
		// Fan out to subdirectories as soon as this listing lands. Rejections
		// are surfaced (in walk order) by the awaiting scan below.
		listing.then(
			entries => {
				if (!entries || depth >= MAX_SCAN_DEPTH) return;
				for (const entry of entries) {
					if (entry.isDirectory() && !isArtifactStagingDir(entry.name)) {
						list(path.join(dir, entry.name), depth + 1);
					}
				}
			},
			() => {},
		);
		return listing;
	};
	for (const dir of dirs) list(dir, 0);

	const found = options?.preserveDuplicates ? new Map<string, string[]>() : new Map<string, string>();
	const seenDirs = new Set<string>();
	const recordFile = (dir: string, entry: Dirent): void => {
		if (!entry.isFile() || !entry.name.endsWith(".jsonl")) return;
		if (entry.name.startsWith("__advisor")) return;
		const id = entry.name.slice(0, -".jsonl".length);
		const file = path.join(dir, entry.name);
		if (options?.preserveDuplicates) {
			const files = found as Map<string, string[]>;
			const candidates = files.get(id);
			if (candidates) candidates.push(file);
			else files.set(id, [file]);
		} else {
			const files = found as Map<string, string>;
			if (!files.has(id)) files.set(id, file);
		}
	};
	const scan = async (dir: string, depth: number): Promise<void> => {
		if (depth > MAX_SCAN_DEPTH || seenDirs.has(dir)) return;
		seenDirs.add(dir);
		const entries = await list(dir, depth);
		if (!entries) return;
		if (options?.onlyPreferred) {
			// Prefer a direct transcript over a nested same-id copy.
			for (const entry of entries) recordFile(dir, entry);
			for (const entry of entries) {
				if (entry.isDirectory() && !isArtifactStagingDir(entry.name)) {
					await scan(path.join(dir, entry.name), depth + 1);
				}
			}
			return;
		}
		for (const entry of entries) {
			if (entry.isDirectory()) {
				if (!isArtifactStagingDir(entry.name)) await scan(path.join(dir, entry.name), depth + 1);
				continue;
			}
			recordFile(dir, entry);
		}
	};
	for (const dir of dirs) await scan(dir, 0);
	return found;
}

/**
 * Whether `name` is an artifact copy's own staging directory.
 *
 * What is in one has not been accepted by any session: it is a copy still
 * being built, or one a crash left behind. Walking into it would serve an
 * unpublished transcript as if the session owned it.
 */
function isArtifactStagingDir(name: string): boolean {
	return name.endsWith(ARTIFACT_STAGING_SUFFIX);
}

/** Directory entries of `dir`, or null when it is missing or not a directory. */
async function readDirEntries(dir: string): Promise<Dirent[] | null> {
	try {
		return await fs.readdir(dir, { withFileTypes: true });
	} catch (err) {
		if (isEnoent(err) || (err as NodeJS.ErrnoException).code === "ENOTDIR") return null;
		throw err;
	}
}

/**
 * Availability half of the `history://` resolution semantics: true when a
 * transcript for `agentId` can be served from a registered ref's live session
 * or retained session file, or from an on-disk `.jsonl` under a known
 * artifacts dir. Hint surfaces use this so they only advertise
 * `history://<agentId>` links that `HistoryProtocolHandler` can actually
 * resolve. A retained sessionFile path is verified on disk before it counts,
 * and probing never throws: a stale path or unreadable artifacts subtree
 * reads as unavailable instead of disturbing the caller's delivery path.
 */
export async function hasResolvableTranscript(agentId: string): Promise<boolean> {
	try {
		const registry = AgentRegistry.global();
		const lower = agentId.toLowerCase();
		let ref = registry.get(agentId);
		if (ref?.kind === "advisor") ref = undefined;
		ref ??= registry.list().find(candidate => candidate.kind !== "advisor" && candidate.id.toLowerCase() === lower);
		if (ref?.session) return true;
		// A running worker resolves to a "no transcript yet" note, not an error.
		if (ref?.status === "running") return true;
		if (ref?.sessionFile && (await isReadableFile(ref.sessionFile))) return true;
		// A hint, on the caller's delivery path: an inherited transcript still
		// being copied goes unadvertised rather than holding delivery up.
		const files = await sessionFilesFromDisk(undefined, { waitForCopies: false });
		for (const id of files.keys()) {
			if (id.toLowerCase() === lower) return true;
		}
	} catch {
		// Availability probing is advisory; any filesystem failure means the
		// transcript cannot be promised, never that delivery should fail.
	}
	return false;
}

/** True when `file` exists and is a regular file; never throws. */
async function isReadableFile(file: string): Promise<boolean> {
	try {
		const stat = await fs.stat(file);
		return stat.isFile();
	} catch {
		return false;
	}
}
