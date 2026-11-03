import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils";
import { Settings } from "../config/settings";
import { findMostRecentSession, resolveResumableSession } from "../session/session-listing";
import { configureSessionExtraRoots, sessionExtraRootsConfigured } from "../session/session-locator";
import { SessionManager } from "../session/session-manager";
import { cfgSessionExtraRoots } from "../session/settings";

/**
 * Apply the persisted `session.extraRoots` for a command that looks sessions
 * up by id without starting the settings stack (which applies it itself), so
 * every lookup consults the same roots.
 */
export async function applySessionExtraRootsSetting(cwd: string): Promise<void> {
	if (sessionExtraRootsConfigured()) return;
	configureSessionExtraRoots(cfgSessionExtraRoots.get(await Settings.loadReadOnly({ cwd })));
}

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
		await applySessionExtraRootsSetting(cwd);
		const match = await resolveResumableSession(sessionArg, cwd);
		if (!match) throw new Error(`Session "${sessionArg}" not found.`);
		return match.session.path;
	}
	const recent = await findMostRecentSession(SessionManager.getDefaultSessionDir(cwd));
	if (!recent) throw new Error(`No sessions found for ${cwd}. Pass a session file or id.`);
	return recent;
}
