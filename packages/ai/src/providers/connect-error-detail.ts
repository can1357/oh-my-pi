import { truncate } from "@oh-my-pi/pi-utils";

/**
 * Connect-protocol end-stream error formatting.
 *
 * A Connect end-of-stream trailer carries an error object of the shape
 * code / message / details. Some backends collapse the useful part into a
 * generic message (for example just "Error"), which previously surfaced
 * verbatim as "Connect error invalid_argument: Error" — an unactionable
 * string that hid both the failing argument and which transport produced it
 * (Refs #4813). This module keeps the existing "Connect error code: message"
 * prefix byte-for-byte and appends what the trailer actually contained:
 * typed detail entries are summarized, and when the message is generic the
 * remaining trailer fields are appended (truncated) so the server's real
 * rejection is visible in logs and bug reports.
 */

/** Messages that carry no diagnostic content on their own. */
const GENERIC_CONNECT_ERROR_MESSAGES = new Set(["", "error", "unknown", "unknown error", "internal", "internal error"]);

/** Upper bound for appended trailer context so errors stay log-line sized. */
const MAX_EXTRA_DETAIL_CHARS = 400;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeJson(value: unknown): string | undefined {
	try {
		const text = typeof value === "string" ? value : JSON.stringify(value);
		return text || undefined;
	} catch {
		return undefined;
	}
}

/**
 * Summarizes Connect error detail entries (objects with type / value / debug
 * fields per the Connect JSON error model). Returns undefined when nothing
 * usable is present.
 */
export function summarizeConnectErrorDetails(details: unknown): string | undefined {
	if (!Array.isArray(details) || details.length === 0) return undefined;
	const parts: string[] = [];
	for (const entry of details) {
		if (!isRecord(entry)) continue;
		const type = typeof entry.type === "string" && entry.type ? entry.type : undefined;
		const debug = entry.debug !== undefined ? safeJson(entry.debug) : undefined;
		const value = entry.value !== undefined ? safeJson(entry.value) : undefined;
		const diagnostic = debug ?? value;
		if (type && diagnostic) parts.push(`${type}: ${diagnostic}`);
		else if (type) parts.push(type);
		else if (diagnostic) parts.push(diagnostic);
	}
	if (parts.length === 0) return undefined;
	return truncate(parts.join("; "), MAX_EXTRA_DETAIL_CHARS);
}

/**
 * Formats a Connect end-stream error object into a diagnosable message.
 * The "Connect error code: message" prefix is preserved exactly; detail
 * entries are appended when present, and when the message itself is generic
 * the remaining trailer fields are inlined so the error names what the
 * server actually sent instead of a bare "Error".
 */
export function formatConnectEndStreamError(error: unknown): string {
	const record = isRecord(error) ? error : {};
	const code = typeof record.code === "string" && record.code ? record.code : "unknown";
	const message = typeof record.message === "string" ? record.message : "";
	const detail = summarizeConnectErrorDetails(record.details);
	const parts: string[] = [`Connect error ${code}: ${message || "Unknown error"}`];
	if (detail) parts.push(`[details: ${detail}]`);
	else if (GENERIC_CONNECT_ERROR_MESSAGES.has(message.trim().toLowerCase())) {
		const extras: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(record)) {
			if (key === "code" || key === "message") continue;
			extras[key] = value;
		}
		const raw = Object.keys(extras).length > 0 ? safeJson(extras) : undefined;
		if (raw && raw !== "{}") parts.push(`[trailer: ${truncate(raw, MAX_EXTRA_DETAIL_CHARS)}]`);
	}
	return parts.join(" ");
}
