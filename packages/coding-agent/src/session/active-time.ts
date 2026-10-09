import type { SessionEntry } from "./session-entries";

/** Cumulative observed running windows, persisted at each run-state boundary. */
export const ACTIVE_TIME_CUSTOM_TYPE = "agent_active_time";

export interface ActiveTimeSummary {
	/** Sum of completed windows, excluding all idle and detached wall time. */
	durationMs: number;
	/** Earlier running windows could not be observed or safely closed. */
	historicalUnavailable: boolean;
	/** Start of an observed live window; never restored from transcript history. */
	runningSince?: number;
}

/**
 * Restore completed running time from the current transcript branch. A persisted
 * open window has no trustworthy end after a crash/resume: retain the completed
 * total, label the missing history, and never count the intervening wall span.
 * Only a live observer may expose an authoritative `runningSince`.
 */
export function readActiveTime(entries: readonly SessionEntry[]): ActiveTimeSummary {
	let hasAssistantHistory = false;
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry.type === "message" && entry.message.role === "assistant") hasAssistantHistory = true;
		if (entry.type !== "custom" || entry.customType !== ACTIVE_TIME_CUSTOM_TYPE) continue;
		const data = entry.data;
		if (!data || typeof data !== "object") continue;
		if (
			!("durationMs" in data) ||
			typeof data.durationMs !== "number" ||
			!Number.isFinite(data.durationMs) ||
			data.durationMs < 0 ||
			!("historicalUnavailable" in data) ||
			typeof data.historicalUnavailable !== "boolean"
		) {
			continue;
		}
		if (
			"runningSince" in data &&
			data.runningSince !== undefined &&
			(typeof data.runningSince !== "number" || !Number.isFinite(data.runningSince) || data.runningSince < 0)
		) {
			continue;
		}
		return {
			durationMs: data.durationMs,
			historicalUnavailable:
				data.historicalUnavailable || ("runningSince" in data && data.runningSince !== undefined),
		};
	}
	return { durationMs: 0, historicalUnavailable: hasAssistantHistory };
}
