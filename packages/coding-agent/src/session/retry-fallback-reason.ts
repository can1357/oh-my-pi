import type { ModelUsageHealth } from "@oh-my-pi/pi-ai";
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
