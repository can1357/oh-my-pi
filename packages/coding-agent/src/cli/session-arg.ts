import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils";
import { findMostRecentSession, resolveResumableSession } from "../session/session-listing";
import { SessionManager } from "../session/session-manager";

/** Resolve a CLI session argument (file path, id prefix, or cwd default) to a session file path. */
export async function resolveSessionFileArg(sessionArg: string | undefined, cwd: string): Promise<string> {
	if (sessionArg) {
		if (sessionArg.includes("/") || sessionArg.includes("\\") || sessionArg.endsWith(".jsonl")) {
			const resolved = path.resolve(sessionArg);
			try {
				await fs.access(resolved);
				return resolved;
			} catch (err) {
				if (isEnoent(err)) throw new Error(`Session file not found: ${resolved}`);
				throw err;
			}
		}
		const match = await resolveResumableSession(sessionArg, cwd);
		if (!match) throw new Error(`Session "${sessionArg}" not found.`);
		return match.session.path;
	}
	const recent = await findMostRecentSession(SessionManager.getDefaultSessionDir(cwd));
	if (!recent) throw new Error(`No sessions found for ${cwd}. Pass a session file or id.`);
	return recent;
}
