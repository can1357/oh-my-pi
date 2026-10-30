import type { AgentSession } from "../session/agent-session";

const disposalSignals = new WeakMap<AgentSession, AbortSignal>();

/**
 * Aborts when `session` begins to dispose. Memory work outlives the turn that
 * started it (a retain flush, a background extraction, an embedding), so this
 * is what ends a memory request held for `/pause` once its session is gone:
 * the request fails instead of being sent, and paid for, on resume. One
 * signal per session, so states rebuilt over its life add no teardown.
 */
export function sessionDisposalSignal(session: AgentSession): AbortSignal {
	let signal = disposalSignals.get(session);
	if (signal) return signal;
	const controller = new AbortController();
	const dispose = () => controller.abort(new Error("Session disposed"));
	if (session.isDisposed) dispose();
	else session.addDisposer(dispose);
	signal = controller.signal;
	disposalSignals.set(session, signal);
	return signal;
}
