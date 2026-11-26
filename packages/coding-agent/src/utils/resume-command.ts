import * as path from "node:path";
import { APP_NAME, getActiveProfile } from "@oh-my-pi/pi-utils";
import { isManagedSessionFile } from "../session/session-paths";
import { quotePosixArgument } from "./shell-quote";

/**
 * Build the shell command that resumes a session by id.
 *
 * Sessions launched under a named profile are stored in that profile's agent
 * directory (`~/.omp/profiles/<name>/agent`), so a bare `omp --resume <id>`
 * run without the profile looks in the default directory and fails with
 * `Session "<id>" not found`. When a profile is active, prefix `--profile
 * <name>` so the emitted hint is a command the user can paste verbatim
 * (issue #9018). Profile names are validated against a strict charset
 * (`normalizeProfileName`), so no shell quoting is required.
 *
 * A session file outside the managed sessions root cannot be found by id, so the
 * command names its shell-quoted path instead: `--resume <path>` opens it directly
 * (issue #9544). Without a file, or for a managed session, the id form is kept.
 */
export function resumeCommand(sessionId: string, sessionFile?: string): string {
	const profile = getActiveProfile();
	const profileFlag = profile ? `--profile ${profile} ` : "";
	const target =
		sessionFile === undefined || isManagedSessionFile(sessionFile)
			? sessionId
			: quotePosixArgument(path.resolve(sessionFile));
	return `${APP_NAME} ${profileFlag}--resume ${target}`;
}
