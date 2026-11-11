/**
 * Session-derived caller contexts for the internal URL router. Tools build
 * their {@link ResolveContext}/{@link WriteContext} here instead of assembling
 * per-tool literals, so every handler sees the same caller identity.
 */
import type { ToolSession } from "../tools";
import { getExperimentalContextSession } from "../tools/context-notes";
import type { LocalProtocolOptions } from "./local-protocol";
import type { ResolveContext, WriteContext } from "./types";

import { cfgCompactionExperimentalContextManagement } from "../session/context-settings";

function nonEmptySessionId(value: string | null | undefined): string | undefined {
	return value ? value : undefined;
}

/**
 * Root session identifier for a {@link ToolSession}. Subagents inherit their
 * root parent's {@link LocalProtocolOptions}, so `localProtocolOptions` wins
 * over the child's own `sessionManager` id.
 */
export function resolveToolSessionRootId(session: ToolSession | undefined): string | undefined {
	if (!session) return undefined;
	return (
		nonEmptySessionId(session.localProtocolOptions?.getSessionId?.()) ??
		nonEmptySessionId(session.sessionManager?.getSessionId?.()) ??
		nonEmptySessionId(session.getSessionId?.())
	);
}

/** Root session identifier for an internal-URL {@link ResolveContext}. */
export function resolveCallerSessionId(context: ResolveContext | undefined): string | undefined {
	if (!context) return undefined;
	return (
		nonEmptySessionId(context.localProtocolOptions?.getSessionId?.()) ??
		nonEmptySessionId(context.sessionId) ??
		resolveToolSessionRootId(context.session)
	);
}

/**
 * The session's `local://` mapping: its pinned {@link LocalProtocolOptions}
 * (subagents and multi-session hosts pin a parent/foreign root) or else its own
 * artifacts dir and session id, so `local://` never falls through to another
 * session's root.
 */
export function sessionLocalProtocolOptions(session: ToolSession): LocalProtocolOptions {
	return (
		session.localProtocolOptions ?? {
			getArtifactsDir: () => session.getArtifactsDir?.() ?? null,
			getSessionId: () => session.getSessionId?.() ?? session.sessionManager?.getSessionId?.() ?? null,
			getArtifactEpoch: () => session.sessionManager?.getArtifactEpoch?.(),
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
		sessionId: session.sessionManager?.getSessionId?.() ?? session.getSessionId?.() ?? undefined,
		agentRegistry: session.agentRegistry,
		localProtocolOptions: contextLocalProtocolOptions(session),
		skills: session.skills,
		containSkillPaths: options.containSkillPaths,
		rules: session.activeRules,
		session,
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
