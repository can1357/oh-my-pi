/**
 * Session-lifecycle handler types shared by the extension runner and the hook
 * loader/runner. Both surfaces wire the same new-session / branch / navigate
 * handlers into their command contexts; this is the single source of truth.
 */
import type { SessionManager } from "../session/session-manager";

/** Handler for `ctx.newSession()` — creates (and optionally seeds) a session. */
export type NewSessionHandler = (options?: {
	parentSession?: string;
	setup?: (sessionManager: SessionManager) => Promise<void>;
}) => Promise<{ cancelled: boolean }>;

/** Handler for `ctx.branch()` — branches from a transcript entry. */
export type BranchHandler = (entryId: string) => Promise<{ cancelled: boolean }>;

/** Handler for `ctx.navigateTree()` — navigates the session tree. */
export type NavigateTreeHandler = (
	targetId: string,
	options?: { summarize?: boolean },
) => Promise<{ cancelled: boolean }>;
