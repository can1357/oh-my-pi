import type { AssistantMessage, ModelUsageHealth } from "@oh-my-pi/pi-ai";
import * as AIError from "@oh-my-pi/pi-ai/error";
import type { TaskFallbackReason } from "@oh-my-pi/pi-tui/tools/task";
import { formatDuration } from "@oh-my-pi/pi-utils";

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

/** Reuse the retry classifier; retain only a bounded provider message head. */
export function providerFallbackReason(message: AssistantMessage): TaskFallbackReason {
	const id = AIError.classifyMessage(message);
	const status = message.errorStatus ?? (Number(/^\s*(\d{3})\b/.exec(message.errorMessage ?? "")?.[1]) || undefined);
	return {
		class:
			AIError.is(id, AIError.Flag.UsageLimit) || status === 429
				? "quota"
				: AIError.is(id, AIError.Flag.AuthFailed)
					? "auth"
					: "other",
		...(status !== undefined ? { status } : {}),
		message: (message.errorMessage ?? "provider returned an error without details").split("\n", 1)[0]!.slice(0, 400),
		source: "provider-error",
	};
}
