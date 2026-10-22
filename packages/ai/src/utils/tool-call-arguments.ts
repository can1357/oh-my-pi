import { parseJsonWithRepair } from "@oh-my-pi/pi-utils";
import type { ToolCall } from "../types";

/** Remainder safe to drop after one complete object: whitespace and stray closers only. */
const STRAY_CLOSING_RE = /^[\s}\]]*$/;

/** Final arguments must not reuse the streaming parser's auto-closed preview. */
export function parseToolCallArguments(json: string | undefined): ToolCall["arguments"] {
	// Some providers omit arguments entirely for zero-argument tools.
	if (!json?.trim()) return {};
	try {
		return parseJsonWithRepair<ToolCall["arguments"]>(json);
	} catch (error) {
		if (error instanceof Error) {
			const trailingAt = /Unexpected trailing characters at position (\d+)/.exec(error.message);
			const pos = trailingAt ? Number(trailingAt[1]) : NaN;
			if (Number.isSafeInteger(pos) && (pos as number) < json.length) {
				// Duplicated/stray closing token after one complete object:
				// accept the first object. Anything carrying content keeps the
				// rejection so no answer bytes are silently dropped.
				if (STRAY_CLOSING_RE.test(json.slice(pos as number))) {
					try {
						return parseJsonWithRepair<ToolCall["arguments"]>(json.slice(0, pos as number));
					} catch {
						// Fall through to the diagnostic below.
					}
				} else {
					return invalidToolCallArguments(
						json,
						new Error(`${error.message}. Resend exactly one JSON object with no trailing text.`),
					);
				}
			}
		}
		return invalidToolCallArguments(json, error);
	}
}

/**
 * Native Responses `function_call.arguments` to persist for replay.
 *
 * {@link parseToolCallArguments} repairs some invalid JSON (e.g. `"name": ,`) and the tool runs with the
 * repaired value; replay must carry what was executed (#14155), not the {@link invalidToolCallArguments}
 * diagnostic it substitutes for stored arguments that do not parse (#15568).
 * Returns `raw` when it already parses or the arguments were unrepairable, else the executed arguments.
 */
export function replayableToolCallArguments(raw: string, executed: ToolCall["arguments"]): string {
	try {
		JSON.parse(raw);
		return raw;
	} catch {
		return executed && typeof executed === "object" && "__parseError" in executed ? raw : JSON.stringify(executed);
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
