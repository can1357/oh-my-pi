import * as path from "node:path";

/** Conversation dump file for one task run, relative to the dump dir: `<task id, chars outside [A-Za-z0-9._-] → _>/run-<n>.md`. The edit runner writes here and the dashboard links here, so both must use this. */
export function conversationDumpRelativePath(taskId: string, runNumber: number): string {
	return path.join(taskId.replace(/[^a-zA-Z0-9._-]/g, "_"), `run-${runNumber}.md`);
}
