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
export async function collectSubSessions(sessionFile: string): Promise<Record<string, SubSession>> {
	const result: Record<string, SubSession> = {};
	if (!sessionFile.endsWith(".jsonl")) return result;
	await collectSubSessionsFromDir(sessionFile.slice(0, -6), null, result);
	return result;
}

async function collectSubSessionsFromDir(
	dir: string,
	parentKey: string | null,
	out: Record<string, SubSession>,
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
		if (!name.endsWith(".jsonl") || name.includes(".bak") || isAdvisorTranscriptName(name)) continue;
		const agentId = name.slice(0, -6);
		const key = parentKey ? `${parentKey}/${agentId}` : agentId;
		const fileEntries = await loadEntriesFromFile(path.join(dir, name));
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
				aborted: fileNames.has(getAgentTombstonePath(name)),
			};
		}
		// Only descend into real child directories: a transcript stem such as "." or ".."
		// would revisit an ancestor, and symlinked directories can loop back into the tree.
		if (childDirectories.has(agentId)) await collectSubSessionsFromDir(path.join(dir, agentId), key, out);
	}
}
