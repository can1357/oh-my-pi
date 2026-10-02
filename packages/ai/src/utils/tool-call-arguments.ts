import { parseJsonWithRepair } from "@oh-my-pi/pi-utils";
import type { ToolCall } from "../types";

/** Final arguments must not reuse the streaming parser's auto-closed preview. */
export function parseToolCallArguments(json: string | undefined): ToolCall["arguments"] {
	// Some providers omit arguments entirely for zero-argument tools.
	if (!json?.trim()) return {};
	try {
		return parseJsonWithRepair<ToolCall["arguments"]>(json);
	} catch (error) {
		return invalidToolCallArguments(json, error);
	}
}

/** Longest raw argument text kept in the parse-error diagnostic. */
export const INVALID_ARGUMENTS_RAW_LIMIT = 512;
const TRUNCATED_SUFFIX = /… \[truncated \d+ chars\]$/;

/** Bound raw argument text for a diagnostic. Text this function already bounded is returned unchanged. */
export function boundRawToolArguments(raw: string): string {
	if (raw.length <= INVALID_ARGUMENTS_RAW_LIMIT) return raw;
	if (TRUNCATED_SUFFIX.exec(raw)?.index === INVALID_ARGUMENTS_RAW_LIMIT) return raw;
	return `${raw.slice(0, INVALID_ARGUMENTS_RAW_LIMIT)}… [truncated ${raw.length - INVALID_ARGUMENTS_RAW_LIMIT} chars]`;
}

/** Preserve a bounded diagnostic, never any partially recovered executable keys. */
export function invalidToolCallArguments(raw: string, error: unknown): ToolCall["arguments"] {
	return {
		__parseError: error instanceof Error ? error.message : String(error),
		__rawJson: boundRawToolArguments(raw),
	};
}
