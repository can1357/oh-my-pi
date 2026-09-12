import { sanitizeText } from "@oh-my-pi/pi-utils";
import { shortenEmbeddedPaths } from "../utils/paths";

/** Maximum sanitized diagnostic text retained in daemon snapshots and model output. */
export const MAX_EXIT_REASON_LENGTH = 1_024;

function cleanExitReason(reason: string | undefined): string | undefined {
	if (reason === undefined) return undefined;
	const normalized = sanitizeText(reason).replace(/\s+/g, " ").trim();
	return normalized || undefined;
}

function limitExitReason(reason: string): string {
	return reason.length > MAX_EXIT_REASON_LENGTH ? `${reason.slice(0, MAX_EXIT_REASON_LENGTH - 1)}…` : reason;
}

/** Normalize a runtime exit diagnostic at the boundary where it becomes durable state. */
export function normalizeExitReason(reason: string | undefined): string | undefined {
	const normalized = cleanExitReason(reason);
	return normalized ? limitExitReason(shortenEmbeddedPaths(normalized)) : undefined;
}

/** Normalize an exit diagnostic for model and terminal display without exposing the home directory. */
export function displayExitReason(reason: string | undefined): string | undefined {
	return normalizeExitReason(reason);
}
