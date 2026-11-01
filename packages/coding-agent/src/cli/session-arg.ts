import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils";
import { materializeSessionFile } from "../session/session-archive";
import { findMostRecentSession, resolveResumableSession } from "../session/session-listing";
import { SessionManager } from "../session/session-manager";

/**
 * Resolve a CLI session argument (file path, id prefix, or cwd default) to a
 * session file path. A session that exists only in the cold archive — given
 * up with `gc --reclaim`, or moved there by an older `gc --archive` — comes
 * back to its own path first: every caller here (`omp render`, `omp session
 * pack`/`moved`, `omp anonymize`) reads an ordinary `.jsonl` and the artifact
 * tree beside it, so handing one a `.jsonl.gz` fails or silently drops its
 * subagent transcripts.
 */
export async function resolveSessionFileArg(sessionArg: string | undefined, cwd: string): Promise<string> {
	// These commands run before anything else owns the terminal: a session
	// coming out of the archive says so on stderr, which keeps stdout clean.
	const progress = (line: string): void => void process.stderr.write(`${line}\n`);
	if (sessionArg) {
		if (sessionArg.includes("/") || sessionArg.includes("\\") || sessionArg.endsWith(".jsonl")) {
			const resolved = path.resolve(sessionArg);
			try {
				await fs.access(resolved);
			} catch (err) {
				if (isEnoent(err)) throw new Error(`Session file not found: ${resolved}`);
				throw err;
			}
			return await materializeSessionFile(resolved, undefined, progress);
		}
		const match = await resolveResumableSession(sessionArg, cwd);
		if (!match) throw new Error(`Session "${sessionArg}" not found.`);
		return await materializeSessionFile(match.session.path, undefined, progress);
	}
	const recent = await findMostRecentSession(SessionManager.getDefaultSessionDir(cwd));
	if (!recent) throw new Error(`No sessions found for ${cwd}. Pass a session file or id.`);
	return recent;
}
