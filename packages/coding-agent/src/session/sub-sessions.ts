/**
 * Subagent session discovery shared by `/export` (HTML) and `/dump all` (zip of text dumps).
 *
 * A session at `<dir>/<name>.jsonl` keeps its subagent sessions at `<dir>/<name>/<AgentId>.jsonl`;
 * each subagent's own children nest the same way under `<dir>/<name>/<AgentId>/`. Advisor
 * transcripts (`__advisor*.jsonl`) share those directories and are not subagents.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils";
import { isAdvisorTranscriptName } from "../advisor/transcript-recorder";
import { getAgentTombstonePath } from "../registry/agent-tombstone";
import type { SessionEntry, SessionHeader } from "./session-entries";
import { loadEntriesFromFile } from "./session-loader";
import { defaultSessionStorage, FileSessionStorage, type SessionStorage } from "./session-storage";

/** Persisted subagent session transcript, keyed by slash-joined agent path. */
export interface SubSession {
	/** Bare agent id (session file stem), e.g. "ToolAsk". */
	agentId: string;
	/** Key of the parent sub-session, or null when spawned by the main session. */
	parent: string | null;
	header: SessionHeader | null;
	entries: SessionEntry[];
	leafId: string | null;
	/** The subagent was explicitly killed (a tombstone sidecar sits next to its transcript). */
	aborted: boolean;
}

/**
 * Collect subagent session transcripts stored next to a session file.
 *
 * Keys in the returned record are slash-joined ids relative to the main session
 * ("ToolAsk", "ToolAsk/Helper"). Corrupt or empty files are skipped silently.
 */
export async function collectSubSessions(
	sessionFile: string,
	storage: SessionStorage = defaultSessionStorage(),
): Promise<Record<string, SubSession>> {
	const result: Record<string, SubSession> = {};
	if (!sessionFile.endsWith(".jsonl")) return result;
	await collectSubSessionsFromDir(sessionFile.slice(0, -6), null, result, storage);
	return result;
}

/** One file stored directly in a subagent directory, in name order. */
interface StoredSubSessionFile {
	name: string;
	/** Path the storage holds the file under. */
	file: string;
	/** The subagent was explicitly killed. */
	aborted: boolean;
	/** The directory named after the file's stem may hold that subagent's own children. */
	descend: boolean;
}

async function collectSubSessionsFromDir(
	dir: string,
	parentKey: string | null,
	out: Record<string, SubSession>,
	storage: SessionStorage,
): Promise<void> {
	const files =
		storage instanceof FileSessionStorage ? await listDirectoryFiles(dir) : await listStoredFiles(dir, storage);
	for (const { name, file, aborted, descend } of files) {
		if (!name.endsWith(".jsonl") || name.includes(".bak") || isAdvisorTranscriptName(name)) continue;
		const agentId = name.slice(0, -6);
		const key = parentKey ? `${parentKey}/${agentId}` : agentId;
		const fileEntries = await loadEntriesFromFile(file, storage);
		// Empty/corrupt files (no valid session header) load as [] — skip silently.
		if (fileEntries.length > 0) {
			const header = (fileEntries.find(e => e.type === "session") as SessionHeader | undefined) ?? null;
			const entries = fileEntries.filter((e): e is SessionEntry => e.type !== "session");
			out[key] = {
				agentId,
				parent: parentKey,
				header,
				entries,
				leafId: entries.length > 0 ? entries[entries.length - 1].id : null,
				aborted,
			};
		}
		if (descend) await collectSubSessionsFromDir(path.join(dir, agentId), key, out, storage);
	}
}

/**
 * Files in an on-disk subagent directory. Only real child directories are
 * descended into: a transcript stem such as "." or ".." would revisit an
 * ancestor, and symlinked directories can loop back into the tree.
 */
async function listDirectoryFiles(dir: string): Promise<StoredSubSessionFile[]> {
	let dirents: fs.Dirent[];
	try {
		dirents = await fs.promises.readdir(dir, { withFileTypes: true });
	} catch (err) {
		if (isEnoent(err) || (err as NodeJS.ErrnoException).code === "ENOTDIR") return [];
		throw err;
	}
	const fileNames = new Set<string>();
	const childDirectories = new Set<string>();
	for (const dirent of dirents) {
		if (dirent.isFile()) fileNames.add(dirent.name);
		else if (dirent.isDirectory()) childDirectories.add(dirent.name);
	}
	return [...fileNames].sort().map(name => ({
		name,
		file: path.join(dir, name),
		aborted: fileNames.has(getAgentTombstonePath(name)),
		descend: childDirectories.has(name.slice(0, -6)),
	}));
}

/**
 * Transcripts a key-indexed storage holds directly under `dir`. It has no
 * directories, so every stem is searched for children unless its directory is
 * not strictly inside `dir`: the stems "", "." and ".." would revisit `dir` or
 * its parent. Kill tombstones are written beside the transcript path on local
 * disk whatever the storage.
 */
async function listStoredFiles(dir: string, storage: SessionStorage): Promise<StoredSubSessionFile[]> {
	const byName = new Map(storage.listFilesSync(dir, "*.jsonl").map(file => [path.basename(file), file]));
	return Promise.all(
		[...byName.keys()].sort().map(async name => {
			const file = byName.get(name)!;
			return {
				name,
				file,
				aborted: await Bun.file(getAgentTombstonePath(file)).exists(),
				descend: path.dirname(path.join(dir, name.slice(0, -6))) === path.join(dir),
			};
		}),
	);
}
