import { type } from "@oh-my-pi/omptype";
import type { ToolApprovalFile } from "@oh-my-pi/pi-agent-core";

/**
 * ArkType schema for a single file revision in tool approval responses.
 */
export const toolApprovalRevisionSchema = type({
	path: "string > 0",
	content: "string",
});

/**
 * Defensive deep freeze of approval files presented to extensions.
 */
export function freezeApprovalFiles(files: readonly ToolApprovalFile[]): readonly ToolApprovalFile[] {
	return Object.freeze(
		files.map(file =>
			Object.freeze({
				path: file.path,
				before: file.before,
				after: file.after,
			}),
		),
	);
}
