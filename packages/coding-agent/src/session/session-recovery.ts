import * as fs from "node:fs";
import * as path from "node:path";
import { directoryIsEnterable, isEnoent, isEnotdir } from "@oh-my-pi/pi-utils";
import type { Settings } from "../config/settings";
import { SessionManager } from "./session-manager";
import type { SessionInfo } from "./session-listing";

/** Where a resume reopens a session whose recorded working directory is gone. */
export type SessionRecoveryDecision =
	| { kind: "unchanged" }
	| { kind: "relocate"; directory: string }
	| { kind: "choose-directory" };

type RepositoryMetadata = NonNullable<SessionInfo["repository"]>;
type DirectoryProbe = "usable" | "missing";

// Unlike the shared enterability helper, recovery must preserve non-missing filesystem errors.
async function probeRecordedCwd(directory: string): Promise<DirectoryProbe> {
	try {
		const stats = await fs.promises.stat(directory);
		if (!stats.isDirectory()) return "missing";
		await fs.promises.access(directory, fs.constants.X_OK);
		return "usable";
	} catch (error) {
		if (isEnoent(error) || isEnotdir(error)) return "missing";
		throw error;
	}
}

function validRepositoryMetadata(value: SessionInfo["repository"]): value is RepositoryMetadata {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof value.sessionWorktreeRoot === "string" &&
		path.isAbsolute(value.sessionWorktreeRoot) &&
		typeof value.primaryWorktreeRoot === "string" &&
		path.isAbsolute(value.primaryWorktreeRoot)
	);
}

export async function resolveSessionRecovery(
	session: SessionInfo,
	currentCwd: string,
	sessionDir?: string,
	settings?: Settings,
): Promise<SessionRecoveryDecision> {
	if (!session.cwd) return { kind: "unchanged" };
	if ((await probeRecordedCwd(session.cwd)) === "usable") return { kind: "unchanged" };

	if (
		(await SessionManager.isStrandedIn(session, currentCwd, sessionDir, settings)) &&
		(await directoryIsEnterable(currentCwd))
	) {
		return { kind: "relocate", directory: currentCwd };
	}

	// A saved path alone may now host an unrelated project; require the session's bucket to confirm it.
	if (
		validRepositoryMetadata(session.repository) &&
		(await directoryIsEnterable(session.repository.primaryWorktreeRoot)) &&
		(await SessionManager.isStrandedIn(session, session.repository.primaryWorktreeRoot, sessionDir, settings))
	) {
		return { kind: "relocate", directory: session.repository.primaryWorktreeRoot };
	}

	return { kind: "choose-directory" };
}
