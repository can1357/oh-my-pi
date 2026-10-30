import * as AIError from "../error";
import type { DispatchHold } from "../types";
import { raceWithSignal } from "./abort";

/**
 * Await a caller's dispatch hold immediately before one request-producing
 * transport operation, and let a cancellation interrupt it.
 *
 * Every site that puts bytes on the wire for an inference request funnels
 * through this: the provider-dispatch chokepoint, the one transport fetch, and
 * each transport whose request is not an HTTP fetch (the Codex websocket, the
 * Cursor HTTP/2 stream, the GitLab Duo workflow socket). Call it *after* that
 * site's own asynchronous preparation — a handshake, a payload build, a
 * request-debug dump — so no await of ours can still follow the hold.
 *
 * An indefinite hold is legitimate (`/pause` holds until a human resumes); an
 * indefinite hold after the request was cancelled is not. `signal` therefore
 * ends the wait with the caller's own abort reason, which fails that attempt
 * like any other dispatch error and lets its caller release whatever it holds
 * (a provider in-flight permit, a socket). The hold itself keeps running — it
 * is the caller's shared gate, not this request's — and stays observed, so a
 * later rejection is never unhandled.
 */
export async function holdBeforeDispatch(hold: DispatchHold | undefined, signal?: AbortSignal | null): Promise<void> {
	if (!hold) return;
	if (signal?.aborted) throw signal.reason ?? new AIError.AbortError("Request aborted before dispatch");
	const pending = hold();
	if (pending) await raceWithSignal(pending, signal ?? undefined);
	if (signal?.aborted) throw signal.reason ?? new AIError.AbortError("Request aborted before dispatch");
}
