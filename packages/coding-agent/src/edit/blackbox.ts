import * as fs from "node:fs";
import * as path from "node:path";
import { logger } from "@oh-my-pi/pi-utils";
import type { ToolSession } from "../tools";
import type { EditMode } from "../utils/edit-mode";

const EDIT_BLACKBOX_FILE = "edit-blackbox.jsonl";

/** Full source transition committed by one edit operation. */
export interface AppliedEditSnapshot {
	/** Path used to select the tree-sitter language. */
	path: string;
	/** File content immediately before the operation. */
	prev: string;
	/** File content immediately after the operation. */
	next: string;
}

/** Observes a committed edit before its full-file snapshots are pruned. */
export type AppliedEditObserver = (snapshot: AppliedEditSnapshot) => Promise<void>;

/** Create the enabled recorder that appends native-detected parse regressions. */
export function createEditBlackboxRecorder(
	session: ToolSession,
	variant: EditMode,
	arg: unknown,
): AppliedEditObserver | undefined {
	if (!session.settings.get("edit.blackbox.enabled")) return undefined;
	const logPath = path.join(session.settings.getAgentDir(), EDIT_BLACKBOX_FILE);
	const model = session.getActiveModelString?.() ?? "unknown";

	return async ({ prev, next }) => {
		try {
			await fs.promises.appendFile(logPath, `${JSON.stringify({ prev, new: next, model, variant, arg })}\n`);
		} catch (error) {
			// Recording is diagnostic only. The edit has already committed, so a
			// telemetry failure must not turn it into a reported edit failure.
			logger.debug("Failed to record edit parse regression", {
				path: logPath,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	};
}
