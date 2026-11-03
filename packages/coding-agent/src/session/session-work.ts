/** Each live session's entry into its request context (see `AgentSession.runInRequestContext`). */
const sessionRequestContexts = new WeakMap<object, <T>(fn: () => T) => T>();

/** Registers `run` as how `session`'s work enters its request context; a session does this when it is built. */
export function registerSessionWork(session: object, run: <T>(fn: () => T) => T): void {
	sessionRequestContexts.set(session, run);
}

/**
 * Runs `fn` as `session`'s work, in its request context: every model request `fn` starts waits
 * for the session's holds. For a host dispatching work for a session it holds as a value — a
 * command dispatcher, a subagent reviver. An object no session registered — no session at all —
 * runs `fn` as is.
 */
export function runAsSessionWork<T>(session: object | undefined, fn: () => T): T {
	const run = session ? sessionRequestContexts.get(session) : undefined;
	return run ? run(fn) : fn();
}
