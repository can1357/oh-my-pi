import { afterRequestHolds, type RequestHolds, type RequestHoldView } from "@oh-my-pi/pi-ai";
import type { AgentSessionHandle } from "../../session/agent-session-handle";

/** The session bridge's home-side check, including the session's inherited holds. */
export function waitForSessionRequestHolds(session: AgentSessionHandle, signal: AbortSignal): Promise<void> {
	return session.runInRequestContext(() => afterRequestHolds(signal, () => undefined));
}

/**
 * A session homed elsewhere holds local requests through the existing session
 * bridge. Opening a view starts one cancellable home-side check; `check` only
 * reports its result, never starts RPC between the gate's final check and send.
 * A home-side release permits this request, not future requests: each opens a
 * fresh view, so a hold re-armed after that release is checked again.
 */
export class RemoteRequestHolds implements RequestHolds {
	readonly #wait: (signal: AbortSignal) => Promise<void>;

	constructor(wait: (signal: AbortSignal) => Promise<void>) {
		this.#wait = wait;
	}

	open(): RequestHoldView {
		const controller = new AbortController();
		let released = false;
		const pending = this.#wait(controller.signal).then(() => {
			released = true;
		});
		// Opening can precede checking (or cancellation). Keep a rejected check
		// observed even when the gate releases this view without waiting on it.
		pending.catch(() => {});
		return {
			check: () => (released ? undefined : pending),
			// Transport abort, send, failure, and an abandoned borrowed view all
			// release here; the mirrored signal ends the home-side wait and views.
			release: () => controller.abort(),
		};
	}
}
