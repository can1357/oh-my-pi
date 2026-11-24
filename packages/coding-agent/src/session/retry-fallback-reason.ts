import type { AssistantMessage, ModelUsageHealth } from "@oh-my-pi/pi-ai";
import { formatDuration } from "@oh-my-pi/pi-utils";
import type { ModelFallbackCause } from "./session-entries";

/** A fallback cause before the switch adds the model it leaves. */
export type RetryFallbackCause = Omit<ModelFallbackCause, "from">;

/** Why a failed turn moves the session off its model: a turn the agent loop stopped itself, or a failed request. */
export function failedTurnFallbackCause(message: AssistantMessage): RetryFallbackCause {
	return { trigger: message.errorFromAgentLoop ? "agent-loop" : "request-error", reason: message.errorMessage };
}

/** The reason `retry_fallback_applied` shows for a cause. */
export function describeFallbackCause(cause: RetryFallbackCause): string | undefined {
	switch (cause.trigger) {
		case "request-error":
			return `Request failed: ${cause.reason ?? "provider returned an error without details"}`;
		case "agent-loop":
			return `Turn stopped: ${cause.reason ?? "the agent loop gave no details"}`;
		default:
			return cause.reason;
	}
}

/** Describe the health snapshot that actually caused a preflight switch. */
export function describeUsageFallback(health: ModelUsageHealth, reservePercent: number): string {
	const condition =
		health.state === "reserve"
			? `available quota is at or below the ${reservePercent}% reserve`
			: health.accounts.length === 0
				? "no account is eligible for this model's plan requirements"
				: "all eligible accounts are quota-exhausted or temporarily blocked";
	const now = Date.now();
	let earliestReset = Infinity;
	for (const account of health.accounts) {
		const reset = account.resetsAt;
		if (reset !== undefined && Number.isFinite(reset) && reset > now && reset < earliestReset) {
			earliestReset = reset;
		}
	}
	const reset = Number.isFinite(earliestReset)
		? ` Earliest reported reset in ${formatDuration(earliestReset - now)}.`
		: "";
	return `Usage preflight: ${condition}.${reset} No request was sent to the source model for this attempt.`;
}
