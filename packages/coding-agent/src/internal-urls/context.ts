/**
 * Session-derived caller contexts for the internal URL router. Tools build
 * their {@link ResolveContext}/{@link WriteContext} here instead of assembling
 * per-tool literals, so every handler sees the same caller identity.
 */
import type { ToolSession } from "../tools";
import { owningSessionId } from "../tools/session-id";
import { getExperimentalContextSession } from "../tools/context-notes";
import type { LocalProtocolOptions } from "./local-protocol";
import { InternalUrlRouter } from "./router";
import type { ResolveContext, WriteContext } from "./types";

import { cfgCompactionExperimentalContextManagement } from "../session/context-settings";

/**
 * The session's `local://` mapping: its pinned {@link LocalProtocolOptions}
 * (subagents and multi-session hosts pin a parent/foreign root) or else its own
 * artifacts dir and session id, so `local://` never falls through to another
 * session's root. Takes a tool session or a `SessionManager`.
 */
export function sessionLocalProtocolOptions(
	session: Pick<ToolSession, "localProtocolOptions" | "getArtifactsDir" | "getSessionId">,
): LocalProtocolOptions {
	return (
		session.localProtocolOptions ?? {
			getArtifactsDir: () => session.getArtifactsDir?.() ?? null,
			getSessionId: () => session.getSessionId?.() ?? null,
		}
	);
}

/**
 * Router-facing `local://` mapping: a session with neither pinned options nor
 * its own artifacts dir defers to the process mapping (LocalProtocolHandler
 * override, then the registry's main session) instead of pinning a null root.
 */
export function contextLocalProtocolOptions(session: ToolSession): LocalProtocolOptions | undefined {
	if (!session.localProtocolOptions && !session.getArtifactsDir) return undefined;
	return sessionLocalProtocolOptions(session);
}

/** The router `session` resolves through: its own schemes, then the built-ins. No session: the built-ins only. */
export function sessionUrlRouter(session: Pick<ToolSession, "urlRouter"> | undefined): InternalUrlRouter {
	return session?.urlRouter ?? InternalUrlRouter.builtins();
}

/** The router a handler routes nested URLs through: the caller's ({@link ResolveContext.router}), else the built-ins. */
export function contextUrlRouter(context: Pick<ResolveContext, "router"> | undefined): InternalUrlRouter {
	return context?.router ?? InternalUrlRouter.builtins();
}

/** The single ResolveContext builder for a tool session; replaces per-tool literal assembly. */
export function sessionResolveContext(
	session: ToolSession,
	options: { signal?: AbortSignal; skipDirectoryListing?: boolean; containSkillPaths?: boolean } = {},
): ResolveContext {
	return {
		cwd: session.cwd,
		settings: session.settings,
		signal: options.signal,
		sessionFile: session.getSessionFile() ?? undefined,
		experimentalContextManagement: cfgCompactionExperimentalContextManagement.get(session.settings) === true,
		getSessionBranch: () => getExperimentalContextSession(session).getBranch(),
		sessionId: owningSessionId(session),
		agentRegistry: session.agentRegistry,
		localProtocolOptions: contextLocalProtocolOptions(session),
		skills: session.skills,
		containSkillPaths: options.containSkillPaths,
		rules: session.activeRules,
		session,
		router: sessionUrlRouter(session),
		skipDirectoryListing: options.skipDirectoryListing,
	};
}

/** The single WriteContext builder for a tool session; replaces per-tool literal assembly. */
export function sessionWriteContext(
	session: ToolSession,
	options: { signal?: AbortSignal; toolCall?: WriteContext["toolCall"] } = {},
): WriteContext {
	return {
		cwd: session.cwd,
		signal: options.signal,
		localProtocolOptions: contextLocalProtocolOptions(session),
		session,
		toolCall: options.toolCall,
	};
}
