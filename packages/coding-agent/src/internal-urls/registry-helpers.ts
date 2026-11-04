/**
 * Shared helpers for internal-url protocol handlers that resolve IDs against
 * registered agent sessions.
 */

import * as path from "node:path";
import { AgentRegistry } from "../registry/agent-registry";
import { defaultSessionStorage, type SessionStorage } from "../session/session-storage";

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
 * EPERM-rewrite backups (`.bak`) are skipped. The walk goes through the
 * session storage (`options.storage`, else the configured one), which is where
 * the transcripts are: under a key-indexed backend (`session.storage: sql`) a
 * resumed session's subagent transcripts are rows, and a directory walk of
 * the artifacts tree finds nothing. When the same id appears in multiple dirs,
 * the first hit wins (registry dirs are scanned first; a `preferredDir` from
 * the caller root is scanned before them). Within one directory both modes
 * keep the orders they had when this walked the filesystem directly:
 * `onlyPreferred` records direct files before it descends, so a direct
 * transcript beats a nested same-id copy, while a full walk takes the
 * directory's entries in their own order and descends as it meets them, so
 * whichever of `Worker.jsonl` and `Z/Worker.jsonl` the directory lists first
 * wins. That order is what `listEntriesSync` exists to carry across the
 * storage abstraction. `preserveDuplicates` retains every candidate path per
 * id for ambiguity checks.
 */
export function sessionFilesFromDisk(
	preferredDir: string | undefined,
	options: { onlyPreferred?: boolean; preserveDuplicates: true; storage?: SessionStorage },
): Promise<Map<string, string[]>>;
export function sessionFilesFromDisk(
	preferredDir?: string,
	options?: { onlyPreferred?: boolean; preserveDuplicates?: false; storage?: SessionStorage },
): Promise<Map<string, string>>;
export async function sessionFilesFromDisk(
	preferredDir?: string,
	options?: { onlyPreferred?: boolean; preserveDuplicates?: boolean; storage?: SessionStorage },
): Promise<Map<string, string> | Map<string, string[]>> {
	const storage = options?.storage ?? defaultSessionStorage();
	const dirs = options?.onlyPreferred ? [] : artifactsDirsFromRegistry();
	if (preferredDir) dirs.unshift(preferredDir);

	const found = options?.preserveDuplicates ? new Map<string, string[]>() : new Map<string, string>();
	const seenDirs = new Set<string>();
	const recordFile = (file: string): void => {
		const name = path.basename(file);
		if (!name.endsWith(".jsonl") || name.startsWith("__advisor")) return;
		const id = name.slice(0, -".jsonl".length);
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
	const scan = (dir: string, depth: number): void => {
		if (depth > MAX_SCAN_DEPTH || seenDirs.has(dir)) return;
		seenDirs.add(dir);
		const entries = storage.listEntriesSync(dir);
		if (options?.onlyPreferred) {
			// Prefer a direct transcript over a nested same-id copy.
			for (const entry of entries) {
				if (entry.isFile) recordFile(path.join(dir, entry.name));
			}
			for (const entry of entries) {
				if (entry.isDirectory) scan(path.join(dir, entry.name), depth + 1);
			}
			return;
		}
		for (const entry of entries) {
			if (entry.isDirectory) scan(path.join(dir, entry.name), depth + 1);
			// Regular files only: a symlink, a FIFO or a device node named
			// `*.jsonl` is not a transcript, and handing one to the reader can
			// block forever.
			else if (entry.isFile) recordFile(path.join(dir, entry.name));
		}
	};
	for (const dir of dirs) scan(dir, 0);
	return found;
}

/**
 * Availability half of the `history://` resolution semantics: true when a
 * transcript for `agentId` can be served from a registered ref's live session
 * or retained session file, or from a stored `.jsonl` under a known artifacts
 * dir. Hint surfaces use this so they only advertise `history://<agentId>`
 * links that `HistoryProtocolHandler` can actually resolve. `storage` is the
 * caller's session tree storage, the one `history://` reads for the same
 * caller ({@link ResolveContext.storage}); omitted, the default session
 * storage. A retained sessionFile path is verified against that storage
 * before it counts, and probing never throws: a stale path or unreadable
 * artifacts subtree reads as unavailable instead of disturbing the caller's
 * delivery path.
 */
/**
 * Whether `file` is a regular file in `storage`; false for a directory, a
 * missing path, or any fault. Follows symlinks, as the filesystem `stat` the
 * check replaced did: a retained transcript reached through a symlink is
 * readable and must still be advertised.
 */
function isStoredFile(file: string, storage: SessionStorage): boolean {
	try {
		return storage.statSync(file).isFile;
	} catch {
		return false;
	}
}

export async function hasResolvableTranscript(
	agentId: string,
	storage: SessionStorage = defaultSessionStorage(),
): Promise<boolean> {
	try {
		const registry = AgentRegistry.global();
		const lower = agentId.toLowerCase();
		let ref = registry.get(agentId);
		if (ref?.kind === "advisor") ref = undefined;
		ref ??= registry.list().find(candidate => candidate.kind !== "advisor" && candidate.id.toLowerCase() === lower);
		if (ref?.session) return true;
		// A running worker resolves to a "no transcript yet" note, not an error.
		if (ref?.status === "running") return true;
		// A regular file, not merely something at that path: a retained path that
		// is now a directory resolves to no transcript, and promising one makes
		// a hint surface advertise a `history://` link that cannot be served.
		if (ref?.sessionFile && isStoredFile(ref.sessionFile, storage)) return true;
		const files = await sessionFilesFromDisk(undefined, { storage });
		for (const id of files.keys()) {
			if (id.toLowerCase() === lower) return true;
		}
	} catch {
		// Availability probing is advisory; any storage failure means the
		// transcript cannot be promised, never that delivery should fail.
	}
	return false;
}
