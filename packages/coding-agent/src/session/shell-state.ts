import * as path from "node:path";
import type { Settings } from "../config/settings";
import { cfgBashPersistShellState } from "../exec/settings";

/** Directory of a session's artifacts holding its saved shell states ({@link shellStateDir}). */
export const SHELL_STATE_DIR = "shell-state";

/**
 * Where agent session `sessionId`'s shells save their state (`executeBash`'s `stateDir`): a
 * directory per session in `artifactsDir` (subagents share their parent's directory). `undefined`
 * for a session without one, and when `bash.persistShellState` is off.
 */
export function shellStateDir(
	settings: Settings,
	artifactsDir: string | null | undefined,
	sessionId: string | undefined,
): string | undefined {
	if (!artifactsDir || !sessionId || !cfgBashPersistShellState.get(settings)) return undefined;
	return path.join(artifactsDir, SHELL_STATE_DIR, sessionId);
}
