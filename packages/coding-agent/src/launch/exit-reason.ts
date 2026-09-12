import { sanitizeText } from "@oh-my-pi/pi-utils";

/** Maximum sanitized diagnostic text retained in daemon snapshots and model output. */
export const MAX_EXIT_REASON_LENGTH = 1_024;

/** Normalize a runtime exit diagnostic at the boundary where it becomes durable state. */
export function normalizeExitReason(reason: string | undefined): string | undefined {
	if (reason === undefined) return undefined;
	const normalized = sanitizeText(reason).replace(/\s+/g, " ").trim();
	if (!normalized) return undefined;
	return normalized.length > MAX_EXIT_REASON_LENGTH
		? `${normalized.slice(0, MAX_EXIT_REASON_LENGTH - 1)}…`
		: normalized;
}
