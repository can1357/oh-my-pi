/**
 * Per-thread directory of agent sessions by cross-thread identity.
 *
 * Every `AgentSession` registers itself here at construction under its
 * `instanceKey` (`${homeThreadId}:${snowflake}`), weakly, so the
 * `"agent-session"` codec can turn a {@link SessionToken} homed on this thread
 * back into the session object. Handles for sessions homed on other threads
 * (the main thread's `RemoteAgentSession` mirrors, a worker's
 * `PeerAgentSession` proxies) are canonical per key: the codec and the
 * publisher bridge look them up and store them here. A remote handle is held
 * strongly while its home keeps the session open ({@link holdRemoteSession})
 * and weakly otherwise, so identity survives as long as anyone holds it.
 *
 * Deliberately light (types and the logger only) so `AgentSession` can import it.
 */
import { logger } from "@oh-my-pi/pi-utils";
import type { AgentSession } from "../session/agent-session";
import type { AgentSessionHandle } from "../session/agent-session-handle";
import type { ThreadId } from "./identity";

/** Wire identity of an agent session: its home thread and instance key. */
export interface SessionToken {
	readonly home: ThreadId;
	readonly key: string;
}

const localSessions = new Map<string, WeakRef<AgentSession>>();
const localFinalizer = new FinalizationRegistry<string>(key => {
	if (!localSessions.get(key)?.deref()) localSessions.delete(key);
});
const localListeners = new Set<(session: AgentSession) => void>();

const remoteHeld = new Map<string, AgentSessionHandle>();
const remoteWeak = new Map<string, WeakRef<AgentSessionHandle>>();
const remoteFinalizer = new FinalizationRegistry<string>(key => {
	if (!remoteWeak.get(key)?.deref()) remoteWeak.delete(key);
});

/**
 * Record a session constructed on this thread and notify session observers
 * (the worker's publisher). Called once, at the end of the `AgentSession`
 * constructor, before the session can be referenced anywhere else.
 */
export function registerLocalSession(session: AgentSession): void {
	localSessions.set(session.instanceKey, new WeakRef(session));
	localFinalizer.register(session, session.instanceKey);
	for (const listener of localListeners) {
		try {
			listener(session);
		} catch (error) {
			logger.error("Agent session registration observer failed", { key: session.instanceKey, error });
		}
	}
}

/** The live session homed on this thread under `key`. */
export function findLocalSession(key: string): AgentSession | undefined {
	return localSessions.get(key)?.deref();
}

/** Whether `value` is a session registered on this thread (identity, not shape). */
export function isRegisteredLocalSession(value: unknown): value is AgentSession {
	if (typeof value !== "object" || value === null) return false;
	const key: unknown = Reflect.get(value, "instanceKey");
	return typeof key === "string" && findLocalSession(key) === value;
}

/** Observe sessions constructed on this thread from now on; returns the unsubscribe function. */
export function onLocalSessionRegistered(listener: (session: AgentSession) => void): () => void {
	localListeners.add(listener);
	return () => {
		localListeners.delete(listener);
	};
}

/** The canonical handle for a session homed on another thread, while anyone holds it. */
export function findRemoteSession(key: string): AgentSessionHandle | undefined {
	return remoteHeld.get(key) ?? remoteWeak.get(key)?.deref();
}

/** Make `handle` the canonical handle for `key`, held weakly. */
export function rememberRemoteSession(key: string, handle: AgentSessionHandle): void {
	remoteWeak.set(key, new WeakRef(handle));
	remoteFinalizer.register(handle, key);
}

/** Make `handle` canonical for `key` and keep it alive until {@link releaseRemoteSession}. */
export function holdRemoteSession(key: string, handle: AgentSessionHandle): void {
	rememberRemoteSession(key, handle);
	remoteHeld.set(key, handle);
}

/** Drop the strong hold on `key`; the handle stays canonical while referenced elsewhere. */
export function releaseRemoteSession(key: string): void {
	remoteHeld.delete(key);
}
