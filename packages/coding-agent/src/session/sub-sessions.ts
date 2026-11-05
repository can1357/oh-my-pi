/**
 * Subagent session discovery shared by `/export` (HTML) and `/dump all` (zip of text dumps).
 *
 * A session at `<dir>/<name>.jsonl` keeps its subagent sessions at `<dir>/<name>/<AgentId>.jsonl`;
 * each subagent's own children nest the same way under `<dir>/<name>/<AgentId>/`. Advisor
 * transcripts (`__advisor*.jsonl`) share those directories and are only collected when
 * requested. Read-only exports can also include gc-compressed `.jsonl.gz` transcripts.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils";
import { isAdvisorTranscriptName } from "../advisor/transcript-recorder";
import { getAgentTombstonePath } from "../registry/agent-tombstone";
import { resolveSessionLeafId, type SessionEntry, type SessionHeader } from "./session-entries";
import { loadSessionFile, parseSessionContent, type SessionLoadResult } from "./session-loader";
import { defaultSessionStorage, FileSessionStorage, type SessionStorage } from "./session-storage";

const utf8Decoder = new TextDecoder();

/** Persisted child transcript (subagent or opted-in advisor), keyed by slash-joined path. */
export interface SubSession {
	/** Transcript stem, e.g. "ToolAsk" or "__advisor.reviewer". */
	agentId: string;
	/** Key of the parent sub-session, or null when spawned by the main session. */
	parent: string | null;
	header: SessionHeader | null;
	entries: SessionEntry[];
	leafId: string | null;
	/** The subagent was explicitly killed (a tombstone sidecar sits next to its transcript). */
	aborted: boolean;
	/** JSONL records skipped as malformed while loading this transcript. */
	malformedRecords: number;
}

/** Receives the key of a subagent transcript that exists but has no readable session header. */
export type UnreadableSubSessionHandler = (key: string) => void;

/** Read-only discovery scope and malformed-transcript reporting for child collectors. */
export interface CollectSubSessionsOptions {
	onUnreadable?: UnreadableSubSessionHandler;
	/** Include advisor transcripts for read-only exports, never task restoration. */
	includeAdvisors?: boolean;
	/** Include gc-compressed transcripts for read-only exports. */
	includeCompressed?: boolean;
	/** Storage holding the transcripts; defaults to {@link defaultSessionStorage}. */
	storage?: SessionStorage;
}

/**
 * Collect subagent session transcripts stored next to a session file.
 *
 * Keys in the returned record are slash-joined ids relative to the main session
 * ("ToolAsk", "ToolAsk/Helper"). Empty files are skipped silently; corrupt ones
 * are skipped and reported to `onUnreadable`. Advisors and compressed transcripts
 * are opt-in, so task restoration and text dumps retain their subagent-only scope.
 */
export async function collectSubSessions(
	sessionFile: string,
	options: CollectSubSessionsOptions = {},
): Promise<Record<string, SubSession>> {
	const result: Record<string, SubSession> = {};
	const transcriptName =
		options.includeCompressed && sessionFile.endsWith(".jsonl.gz") ? sessionFile.slice(0, -3) : sessionFile;
	if (!transcriptName.endsWith(".jsonl")) return result;
	const storage = options.storage ?? defaultSessionStorage();
	await collectSubSessionsFromDir(transcriptName.slice(0, -6), null, result, options, storage);
	return result;
}

/** Decompress archives before handing their JSONL to the central session parser. */
async function loadCollectedSession(
	file: string,
	compressed: boolean,
	storage: SessionStorage,
): Promise<SessionLoadResult | null> {
	if (!compressed) return loadSessionFile(file, storage);
	try {
		return parseSessionContent(utf8Decoder.decode(Bun.gunzipSync(await Bun.file(file).bytes())));
	} catch (err) {
		// Match the plain loader when gc removes a transcript after discovery.
		if (isEnoent(err)) return null;
		throw err;
	}
}

/** One subagent transcript stored directly in a subagent directory, in name order. */
interface StoredSubSessionFile {
	/** Transcript stem, e.g. "ToolAsk"; its own children live under the directory of that name. */
	agentId: string;
	/** Path the storage holds the file under. */
	file: string;
	/** A gc-compressed `.jsonl.gz` archive; its live transcript is gone. */
	compressed: boolean;
	/** An advisor transcript (`__advisor*.jsonl`). */
	advisor: boolean;
	/** The subagent was explicitly killed: a tombstone sits beside its transcript or its archive. */
	aborted: boolean;
	/** The directory named after the stem may hold that subagent's own children. */
	descend: boolean;
}

/** What one storage knows about a directory; {@link subSessionFiles} applies the rules to it. */
interface ListedDirectory {
	/** Each file stored directly in the directory, by name and stored path. */
	files: ReadonlyArray<{ name: string; file: string }>;
	/** Whether a tombstone exists at `tombstone`. */
	hasTombstone(tombstone: string): boolean | Promise<boolean>;
	/** Whether the directory named after `agentId` may hold that subagent's own children. */
	mayHoldChildren(agentId: string): boolean;
}

/**
 * The subagent transcripts of one listed directory, in name order. Both listers
 * call this, so the rules exist once: only `.jsonl` and `.jsonl.gz` names count
 * and `.bak` copies never do; a live transcript wins over its archive during gc;
 * a tombstone beside the transcript name or the archive name marks the subagent
 * killed.
 */
async function subSessionFiles(listed: ListedDirectory): Promise<StoredSubSessionFile[]> {
	const byName = new Map(listed.files.map(({ name, file }) => [name, file]));
	const transcripts: Array<{ name: string; file: string; compressed: boolean; transcriptName: string }> = [];
	for (const name of [...byName.keys()].sort()) {
		const compressed = name.endsWith(".jsonl.gz");
		const transcriptName = compressed ? name.slice(0, -3) : name;
		if (!transcriptName.endsWith(".jsonl") || name.includes(".bak")) continue;
		// A live transcript wins over an archive of the same session during gc.
		if (compressed && byName.has(transcriptName)) continue;
		transcripts.push({ name, file: byName.get(name)!, compressed, transcriptName });
	}
	return Promise.all(
		transcripts.map(async ({ file, compressed, transcriptName }) => {
			const agentId = transcriptName.slice(0, -6);
			const transcriptFile = compressed ? file.slice(0, -3) : file;
			return {
				agentId,
				file,
				compressed,
				advisor: isAdvisorTranscriptName(transcriptName),
				aborted:
					(await listed.hasTombstone(getAgentTombstonePath(transcriptFile))) ||
					(compressed && (await listed.hasTombstone(getAgentTombstonePath(file)))),
				descend: listed.mayHoldChildren(agentId),
			};
		}),
	);
}

async function collectSubSessionsFromDir(
	dir: string,
	parentKey: string | null,
	out: Record<string, SubSession>,
	options: CollectSubSessionsOptions,
	storage: SessionStorage,
): Promise<void> {
	const files =
		storage instanceof FileSessionStorage ? await listDirectoryFiles(dir) : await listStoredFiles(dir, storage);
	for (const { agentId, file, compressed, advisor, aborted, descend } of files) {
		if ((compressed && !options.includeCompressed) || (advisor && !options.includeAdvisors)) continue;
		const key = parentKey ? `${parentKey}/${agentId}` : agentId;
		const loaded = await loadCollectedSession(file, compressed, storage);
		if (!loaded) continue;
		const { entries: fileEntries, malformedRecords, invalidHeader } = loaded;
		// Empty files load as [] and are skipped; a corrupt or missing header is reported so exports do
		// not look complete while omitting the transcript.
		if (!invalidHeader && fileEntries.length > 0) {
			const header = (fileEntries.find(e => e.type === "session") as SessionHeader | undefined) ?? null;
			const entries = fileEntries.filter((e): e is SessionEntry => e.type !== "session");
			out[key] = {
				agentId,
				parent: parentKey,
				header,
				entries,
				leafId: resolveSessionLeafId(entries),
				aborted,
				malformedRecords,
			};
		} else if (invalidHeader) {
			options.onUnreadable?.(key);
		}
		if (descend) await collectSubSessionsFromDir(path.join(dir, agentId), key, out, options, storage);
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
	return subSessionFiles({
		files: [...fileNames].map(name => ({ name, file: path.join(dir, name) })),
		hasTombstone: tombstone => fileNames.has(path.basename(tombstone)),
		mayHoldChildren: agentId => childDirectories.has(agentId),
	});
}

/**
 * Transcripts a key-indexed storage holds directly under `dir`. It has no
 * directories, so every stem is searched for children unless its directory is
 * not strictly inside `dir`: the stems "", "." and ".." would revisit `dir` or
 * its parent. Kill tombstones are written beside the transcript path on local
 * disk whatever the storage.
 */
async function listStoredFiles(dir: string, storage: SessionStorage): Promise<StoredSubSessionFile[]> {
	return subSessionFiles({
		files: storage.listFilesSync(dir, "*.jsonl").map(file => ({ name: path.basename(file), file })),
		hasTombstone: tombstone => Bun.file(tombstone).exists(),
		mayHoldChildren: agentId => path.dirname(path.join(dir, agentId)) === path.join(dir),
	});
}
