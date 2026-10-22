/**
 * Shared continuation-text precedence for the two stop hooks.
 *
 * `session_stop` (main session) and `subagent_stop` (task/subagent run) accept
 * the same handler result and apply the same rules, so the mapping lives here
 * rather than being re-derived per host: a reason-less refusal gets the host's
 * diagnostic text, an explicit refusal outranks an advisory request, and an
 * advisory request without model-visible context is ignored.
 */
import type { SessionStopEventResult } from "../shared-events";

/**
 * Map a stop-hook result to the model-visible continuation text.
 *
 * @param result Handler result from the runner's stop aggregation.
 * @param blockedFallback Diagnostic shown when a handler refused the stop
 *   without supplying a reason; the caller owns its wording (each host names
 *   its own event).
 * @returns The continuation text, or undefined when the stop is allowed.
 */
export function resolveStopContinuationText(
	result: SessionStopEventResult | undefined,
	blockedFallback: string,
): string | undefined {
	if (!result) return undefined;
	// Guard the type, not just emptiness: a plain-JS handler can return a
	// non-string, and that value would otherwise be pushed into a continuation
	// message as model-visible content.
	const additionalContext =
		typeof result.additionalContext === "string" && result.additionalContext.length > 0
			? result.additionalContext
			: undefined;
	const reason = typeof result.reason === "string" && result.reason.length > 0 ? result.reason : undefined;
	if (result.decision === "block") {
		return reason ?? additionalContext ?? blockedFallback;
	}
	if (result.continue === true) {
		return additionalContext ?? reason;
	}
	return undefined;
}
