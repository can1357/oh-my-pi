/**
 * Post-rollback notification seam.
 *
 * A rollback changes files behind the agent's back: filesystem scan caches, LSP
 * diagnostics, and pending patch expectations all go stale. Consumers register
 * here instead of the checkpoints module reaching into them, so this file has no
 * dependency on the session, LSP, or tool layers.
 */
import { logger, toError } from "@oh-my-pi/pi-utils";
import type { CheckpointMeta, WorkspaceRollbackSessionSurface } from "./types";

/** Session entry type appended for a rollback, so a resumed transcript shows the workspace changed. */
export const WORKSPACE_ROLLED_BACK_ENTRY = "workspace_rolled_back";

export interface WorkspaceRolledBackEvent {
	readonly checkpoint: CheckpointMeta;
	readonly rolledBackAt: string;
}

export type WorkspaceRolledBackListener = (event: WorkspaceRolledBackEvent) => void;

const listeners = new Set<WorkspaceRolledBackListener>();

/** Subscribe to workspace rollbacks. Returns the unsubscribe handle. */
export function onWorkspaceRolledBack(listener: WorkspaceRolledBackListener): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

/**
 * Announce a completed rollback: append a custom entry to `session` when one was
 * provided, then fan out to registered listeners. A throwing listener is logged
 * and skipped — one stale-cache consumer must not abort the others or fail the
 * rollback that already succeeded.
 */
export function emitWorkspaceRolledBack(
	session: WorkspaceRollbackSessionSurface | undefined,
	meta: CheckpointMeta,
): void {
	const rolledBackAt = new Date().toISOString();
	if (session) {
		session.appendCustomEntry(WORKSPACE_ROLLED_BACK_ENTRY, {
			checkpointId: meta.id,
			sessionId: meta.sessionId,
			label: meta.label,
			reason: meta.reason,
			treeSha: meta.treeSha,
			rolledBackAt,
		});
	}
	for (const listener of listeners) {
		try {
			listener({ checkpoint: meta, rolledBackAt });
		} catch (error) {
			logger.warn("Workspace rollback listener failed", {
				checkpointId: meta.id,
				error: toError(error).message,
			});
		}
	}
}
