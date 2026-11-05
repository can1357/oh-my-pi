import { parseJsonWithRepair } from "@oh-my-pi/pi-utils";
import { JsonSyntaxError } from "@oh-my-pi/pi-utils/json-lexer";
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

/**
 * Offset of a parse failure, preferring the one our own final parser carries
 * on the error ({@link JsonSyntaxError}) over the one V8's `JSON.parse` writes
 * into its message. Only read, never written: nothing here adds a number to an
 * error's text, because those texts reach HTTP-status classifiers that match a
 * bare `429` or `403` anywhere in them.
 */
const PARSE_ERROR_POSITION = /\bposition (\d+)/;

function parseErrorPosition(error: unknown, rawLength: number): number | undefined {
	const carried = error instanceof JsonSyntaxError ? error.position : Number.NaN;
	const position = Number.isInteger(carried)
		? carried
		: Number(PARSE_ERROR_POSITION.exec(error instanceof Error ? error.message : String(error))?.[1]);
	if (!Number.isInteger(position)) return undefined;
	return Math.min(Math.max(position, 0), rawLength);
}

/** Fixed-width window markers. No digit, so an excerpt never reads as an HTTP status. */
const OMITTED_BEFORE = "… [earlier text omitted] ";
const OMITTED_AFTER = " … [rest of the arguments omitted]";

/**
 * The excerpt a parse failure shows: the window around the reported offset,
 * not the head of the payload.
 *
 * A tool call that fails to parse is usually long and its fault is usually
 * near the end — a batch `task` brief, a `write` payload, a stream cut
 * mid-string. Showing the first {@link INVALID_ARGUMENTS_RAW_LIMIT}
 * characters then shows text that cannot contain the fault, and the model has
 * nothing to correct (dispatch://INFRA-1270). The window stays inside the same
 * budget, so {@link boundRawToolArguments} leaves it alone downstream.
 */
function excerptAroundParseError(raw: string, error: unknown): string {
	if (raw.length <= INVALID_ARGUMENTS_RAW_LIMIT) return raw;
	const position = parseErrorPosition(error, raw.length);
	// No offset to centre on: keep the head, with the same digit-free marker.
	// `boundRawToolArguments` would append `… [truncated N chars]` here, which
	// both exceeds the budget and puts a status-like number back into the text.
	if (position === undefined) {
		const head = INVALID_ARGUMENTS_RAW_LIMIT - OMITTED_AFTER.length;
		const kept = raw.slice(0, trimsNeeded(raw, 0, head) ? trimSeveredDigitsAtEnd(raw, head) : head);
		return `${kept}${OMITTED_AFTER}`;
	}
	const span = INVALID_ARGUMENTS_RAW_LIMIT - OMITTED_BEFORE.length - OMITTED_AFTER.length;
	let start = Math.max(0, Math.min(position - (span >> 1), raw.length - span));
	let end = Math.min(raw.length, start + span);
	if (trimsNeeded(raw, start, end)) {
		if (start > 0) start = trimSeveredDigitsAtStart(raw, start, end);
		if (end < raw.length) end = trimSeveredDigitsAtEnd(raw, end);
	}
	const head = start > 0 ? OMITTED_BEFORE : "";
	const tail = end < raw.length ? OMITTED_AFTER : "";
	return `${head}${raw.slice(start, end)}${tail}`;
}

/**
 * Whether this window would show a status the payload does not.
 *
 * Trimming unconditionally costs more than it buys: `'9'.repeat(600)` carries
 * no status at all, yet its whole window is one digit run, so an
 * unconditional trim consumed every character and left the model the marker
 * alone — losing exactly the offending text this change exists to show.
 *
 * The comparison is per status, not one boolean over the payload. Asking only
 * "does the raw contain any status" let a payload carrying `HTTP 403 denied`
 * suppress the trim entirely, so a cut through `x429"` elsewhere in the same
 * payload still minted `429` and turned an authentication failure into a
 * retryable one — round 6's defect returning across statuses instead of
 * within one.
 */
function trimsNeeded(raw: string, start: number, end: number): boolean {
	const inWindow = statusesIn(raw.slice(start, end));
	if (inWindow.size === 0) return false;
	const inRaw = statusesIn(raw);
	for (const status of inWindow) {
		if (!inRaw.has(status)) return true;
	}
	return false;
}

function statusesIn(text: string): Set<string> {
	const found = new Set<string>();
	for (const match of text.matchAll(STATUS_LIKE)) found.add(match[0]);
	return found;
}

/** The classifiers' own pattern, which is what decides whether a cut did harm. */
const STATUS_LIKE = /\b(?:401|403|429|500|502|503|504)\b/g;

function isDigit(code: number): boolean {
	return code >= 0x30 && code <= 0x39;
}

/** `\b`'s word class, which is what decides whether a cut invents a boundary. */
function isWordChar(code: number): boolean {
	return (
		isDigit(code) ||
		(code >= 0x41 && code <= 0x5a) ||
		(code >= 0x61 && code <= 0x7a) ||
		code === 0x5f ||
		Number.isNaN(code)
	);
}

/**
 * Move a cut off the inside of a word, so the excerpt cannot show a number the
 * payload never showed.
 *
 * The markers carry no digits, but the cut itself can still mint one. The
 * classifiers match `\b(?:401|403|429|500|502|503|504)\b`, and `\b` sits
 * between a word character and a non-word one — so `x429"` carries no boundary
 * before `429`, and neither does `1403`. Sever that `x` or that `1` and the
 * excerpt opens on `429` with the marker's space in front of it, which does.
 * Dropping the severed digits — never extending, so the budget is unaffected —
 * leaves no number the payload did not contain. Only the excerpt's own edges
 * can gain a boundary this way, so one run at each end is enough.
 *
 * `NaN` from `charCodeAt` past the end counts as a word character here: there
 * is no character to compare, and treating the absent one as a word char keeps
 * the trim conservative.
 */
function trimSeveredDigitsAtStart(raw: string, start: number, end: number): number {
	if (!isWordChar(raw.charCodeAt(start - 1))) return start;
	let next = start;
	while (next < end && isDigit(raw.charCodeAt(next))) next++;
	return next;
}

function trimSeveredDigitsAtEnd(raw: string, end: number): number {
	if (end >= raw.length || !isWordChar(raw.charCodeAt(end))) return end;
	let next = end;
	while (next > 0 && isDigit(raw.charCodeAt(next - 1))) next--;
	return next;
}

/** Preserve a bounded diagnostic, never any partially recovered executable keys. */
export function invalidToolCallArguments(raw: string, error: unknown): ToolCall["arguments"] {
	return {
		__parseError: error instanceof Error ? error.message : String(error),
		__rawJson: excerptAroundParseError(raw, error),
	};
}
