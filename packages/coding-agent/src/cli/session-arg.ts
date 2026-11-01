import * as path from "node:path";
import { findMostRecentSession, resolveResumableSession } from "../session/session-listing";
import { SessionManager } from "../session/session-manager";
import { defaultSessionStorage } from "../session/session-storage";

/**
 * Resolve a CLI session argument (file path, id prefix, or cwd default) to a
 * session file path, through the configured session storage: under
 * `session.storage: sql` a session is a row, so an existence check on the
 * local filesystem would refuse every stored session by path.
 */
export async function resolveSessionFileArg(sessionArg: string | undefined, cwd: string): Promise<string> {
	const storage = defaultSessionStorage();
	if (sessionArg) {
		if (sessionArg.includes("/") || sessionArg.includes("\\") || sessionArg.endsWith(".jsonl")) {
			const resolved = path.resolve(sessionArg);
			if (await storage.exists(resolved)) return resolved;
			throw new Error(`Session file not found: ${resolved}`);
		}
		const match = await resolveResumableSession(sessionArg, cwd);
		if (!match) throw new Error(`Session "${sessionArg}" not found.`);
		return match.session.path;
	}
	const recent = await findMostRecentSession(SessionManager.getDefaultSessionDir(cwd, undefined, storage));
	if (!recent) throw new Error(`No sessions found for ${cwd}. Pass a session file or id.`);
	return recent;
}
