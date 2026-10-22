import * as AIError from "@oh-my-pi/pi-ai/error";

/**
 * A *local* transport fault: the socket died, the connection was refused, DNS
 * failed, or the stream never produced its first event. The request never
 * reached a provider that could answer, so the failure says nothing about the
 * health of the model that was asked — every other model in `fallbackChains`
 * dials the same dead network and fails just as fast.
 *
 * Deliberately narrower than the generic transient-transport wording: that also
 * matches route-specific provider rejections (429, 5xx, "overloaded"), which
 * genuinely are worth switching model for without waiting.
 */
const LOCAL_TRANSPORT_FAILURE_RE =
	/socket (?:hang up|connection was closed)|other side closed|fetch failed|\b(?:ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ENETUNREACH|ENETDOWN|EHOSTUNREACH|EPIPE)\b|network.?error|connection.?error|connection.?refused|unable.?to.?connect|reset before headers|waiting for the first event/i;

/**
 * Whether a retryable failure is a *local* transport fault (dead socket,
 * refused connection, DNS failure, first-event timeout) rather than a
 * route-specific provider rejection.
 *
 * Switching models normally justifies skipping the retry backoff — a different
 * route is presumed healthy and ready to serve now. That assumption is wrong
 * when the network itself is down: the next model in `fallbackChains` fails
 * within milliseconds, the chain burns end-to-end, and the turn dies without
 * ever honoring `retry.baseDelayMs` (issue #9165).
 *
 * An HTTP status is the discriminator. A provider that answered — even with
 * 429 or 503 — was reachable, so the fault is route-specific and an instant
 * switch remains correct. A local transport fault carries no status at all.
 */
export function isLocalTransportFailure(
	errorId: number | undefined,
	errorMessage: string | undefined,
	errorStatus: number | undefined,
): boolean {
	if (!AIError.is(errorId, AIError.Flag.Transient) && !AIError.is(errorId, AIError.Flag.Timeout)) return false;
	// A usage/quota cap is account-scoped, not a network fault: rotating to
	// another model is exactly the right instant recovery.
	if (AIError.is(errorId, AIError.Flag.UsageLimit)) return false;
	if (!errorMessage) return false;
	if (!LOCAL_TRANSPORT_FAILURE_RE.test(errorMessage)) return false;
	return (errorStatus ?? AIError.status({ message: errorMessage })) === undefined;
}
