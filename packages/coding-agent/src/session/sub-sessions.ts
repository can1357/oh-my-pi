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

/** A child transcript file next to a session, found without reading it. */
export interface SubSessionFile {
	/** Slash-joined id relative to the main session ("ToolAsk", "ToolAsk/Helper"). */
	key: string;
	/** Transcript stem, e.g. "ToolAsk" or "__advisor.reviewer". */
	agentId: string;
	/** Key of the parent sub-session, or null when spawned by the main session. */
	parent: string | null;
	file: string;
	/** A tombstone sidecar sits next to the transcript: the subagent was explicitly killed. */
	aborted: boolean;
}

/** Receives the key of a subagent transcript that exists but has no readable session header. */
export type UnreadableSubSessionHandler = (key: string) => void;

/** Which child transcripts {@link listSubSessionFiles} finds. */
export interface SubSessionScope {
	/** Include advisor transcripts for read-only exports, never task restoration. */
	includeAdvisors?: boolean;
	/** Include gc-compressed transcripts for read-only exports. */
	includeCompressed?: boolean;
}

/** Read-only discovery scope and malformed-transcript reporting for child collectors. */
export interface CollectSubSessionsOptions extends SubSessionScope {
	onUnreadable?: UnreadableSubSessionHandler;
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
	for (const found of await listSubSessionFiles(sessionFile, options)) {
		const loaded = await loadCollectedSession(found.file);
		if (!loaded) continue;
		const { entries: fileEntries, malformedRecords, invalidHeader } = loaded;
		// Empty files load as [] and are skipped; a corrupt or missing header is reported so exports do
		// not look complete while omitting the transcript.
		if (!invalidHeader && fileEntries.length > 0) {
			const header = (fileEntries.find(e => e.type === "session") as SessionHeader | undefined) ?? null;
			const entries = fileEntries.filter((e): e is SessionEntry => e.type !== "session");
			result[found.key] = {
				agentId: found.agentId,
				parent: found.parent,
				header,
				entries,
				leafId: resolveSessionLeafId(entries),
				aborted: found.aborted,
				malformedRecords,
			};
		} else if (invalidHeader) {
			options.onUnreadable?.(found.key);
		}
	}
	return result;
}

/**
 * Child transcript files stored next to a session file, each before its own
 * children, siblings by name. Reads directories only. Advisors and compressed
 * transcripts are opt-in, as in {@link collectSubSessions}.
 */
export async function listSubSessionFiles(sessionFile: string, scope: SubSessionScope = {}): Promise<SubSessionFile[]> {
	const found: SubSessionFile[] = [];
	const transcriptName =
		scope.includeCompressed && sessionFile.endsWith(".jsonl.gz") ? sessionFile.slice(0, -3) : sessionFile;
	if (!transcriptName.endsWith(".jsonl")) return found;
	await listSubSessionDir(transcriptName.slice(0, -6), null, found, scope);
	return found;
}

/** Decompress archives before handing their JSONL to the central session parser. */
async function loadCollectedSession(file: string): Promise<SessionLoadResult | null> {
	if (!file.endsWith(".jsonl.gz")) return loadSessionFile(file);
	try {
		return parseSessionContent(utf8Decoder.decode(Bun.gunzipSync(await Bun.file(file).bytes())));
	} catch (err) {
		// Match the plain loader when gc removes a transcript after discovery.
		if (isEnoent(err)) return null;
		throw err;
	}
}

async function listSubSessionDir(
	dir: string,
	parentKey: string | null,
	out: SubSessionFile[],
	scope: SubSessionScope,
): Promise<void> {
	let dirents: fs.Dirent[];
	try {
		dirents = await fs.promises.readdir(dir, { withFileTypes: true });
	} catch (err) {
		if (isEnoent(err) || (err as NodeJS.ErrnoException).code === "ENOTDIR") return;
		throw err;
	}
	const fileNames = new Set<string>();
	const childDirectories = new Set<string>();
	for (const dirent of dirents) {
		if (dirent.isFile()) fileNames.add(dirent.name);
		else if (dirent.isDirectory()) childDirectories.add(dirent.name);
	}
	for (const name of [...fileNames].sort()) {
		const compressed = name.endsWith(".jsonl.gz");
		if (compressed && !scope.includeCompressed) continue;
		const transcriptName = compressed ? name.slice(0, -3) : name;
		if (
			!transcriptName.endsWith(".jsonl") ||
			name.includes(".bak") ||
			(!scope.includeAdvisors && isAdvisorTranscriptName(transcriptName))
		)
			continue;
		// A live transcript wins over an archive of the same session during gc.
		if (compressed && fileNames.has(transcriptName)) continue;
		const agentId = transcriptName.slice(0, -6);
		const key = parentKey ? `${parentKey}/${agentId}` : agentId;
		out.push({
			key,
			agentId,
			parent: parentKey,
			file: path.join(dir, name),
			aborted:
				fileNames.has(getAgentTombstonePath(transcriptName)) ||
				(compressed && fileNames.has(getAgentTombstonePath(name))),
		});
		// Only descend into real child directories: a transcript stem such as "." or ".."
		// would revisit an ancestor, and symlinked directories can loop back into the tree.
		if (childDirectories.has(agentId)) {
			await listSubSessionDir(path.join(dir, agentId), key, out, scope);
		}
	}
}
