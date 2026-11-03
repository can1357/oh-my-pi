import * as path from "node:path";
import { findMostRecentSession, resolveResumableSession } from "../session/session-listing";
import { SessionManager } from "../session/session-manager";
import { defaultSessionStorage } from "../session/session-storage";
import { installConfiguredSessionStorage, SessionStorageConfigError } from "../session/session-storage-config";

/**
 * Install the configured session storage for a command that runs outside the
 * root command's start-up install, before it resolves or lists a session.
 * Under `session.storage: sql` a session is a row: without this the command
 * looks for files and reports every stored session missing. Prints a
 * misconfiguration to stderr, sets exit code 1, and returns false.
 */
export async function installSessionStorageForCommand(): Promise<boolean> {
	try {
		await installConfiguredSessionStorage(process.cwd());
		return true;
	} catch (err) {
		if (!(err instanceof SessionStorageConfigError)) throw err;
		process.stderr.write(`Error: ${err.message}\n`);
		process.exitCode = 1;
		return false;
	}
}

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
