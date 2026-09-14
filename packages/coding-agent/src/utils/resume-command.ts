import { APP_NAME, getActiveProfile } from "@oh-my-pi/pi-utils";

/**
 * Build the shell command that resumes a session by id.
 *
 * Sessions launched under a named profile are stored in that profile's agent
 * directory (`~/.omp/profiles/<name>/agent`), so the profile must be carried
 * into the resume command (issue #9018). When a working directory is supplied,
 * the command also restores it and opts into home-directory execution. The cwd
 * is single-quoted so the emitted command remains safe to paste verbatim.
 */
export function resumeCommand(sessionId: string, cwd?: string): string {
	const profile = getActiveProfile();
	const profileFlag = profile ? `--profile ${profile} ` : "";
	const command = `${APP_NAME} ${profileFlag}${cwd ? "--allow-home " : ""}--resume ${sessionId}`;
	if (!cwd) return command;
	return `cd '${cwd.replaceAll("'", "'\\''")}' && ${command}`;
}
