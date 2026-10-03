/**
 * Detects tool calls the model transcribed as literal text in an assistant
 * message instead of emitting as structured `toolCall` blocks. A text channel
 * "envelope" is the foreign chat-template spelling: an open tag carrying
 * `function=NAME`, parameter pairs, and a matching close tag. Such text is
 * displayed to the user but never dispatched, which stalls the session at
 * "the call announced in prose".
 *
 * The scan is deliberately shallow: envelope-level structure and tool names
 * only, NEVER parameter values. Values in this markup family are not opaque —
 * an embedded close tag inside a value terminates the value and rebinds later
 * parameters — so any consumer that parsed values would silently corrupt
 * arguments. Feedback only needs names.
 *
 * Note: angle-bracket tag spellings are assembled from a fragment so this file
 * never contains a literal envelope tag sequence; such sequences inside
 * tool-call parameter values corrupt the parameter transport.
 */

const TAG_START = "<";
const TOOL_CALL_OPEN = `${TAG_START}function=`;
const TOOL_CALL_CLOSE = `${TAG_START}/function>`;

/** Cap the scan: a terminal text part can carry arbitrary megabytes. */
const SCAN_LIMIT = 256 * 1024;
/** Cap a transcribed name before it reaches logs or a rendered reminder. */
const MAX_NAME_LENGTH = 64;
/** Unicode "Other" category: control, format, surrogate, private-use bytes. */
const NON_TEXT_CHARS_RE = /\p{C}/gu;

export interface TextChannelToolCall {
	/** Tool name as transcribed; may not resolve to a registered tool. */
	name: string;
}

export interface TextChannelToolCallDetection {
	/** Complete envelopes (open + close pair) in emission order. */
	complete: readonly TextChannelToolCall[];
	/** True when an open tag never reaches its close tag (call cut in transit). */
	incomplete: boolean;
}

/**
 * Returns undefined when the text carries no envelope markup at all. A
 * complete entry requires a close tag before the next open tag, so a quoted
 * unclosed fragment cannot swallow the envelope that follows it; the fragment
 * is then reported through `incomplete` instead.
 */
export function detectTextChannelToolCalls(text: string): TextChannelToolCallDetection | undefined {
	const haystack = text.length > SCAN_LIMIT ? text.slice(0, SCAN_LIMIT) : text;
	const complete: TextChannelToolCall[] = [];
	let incomplete = false;
	let cursor = 0;
	for (;;) {
		const open = haystack.indexOf(TOOL_CALL_OPEN, cursor);
		if (open === -1) break;
		const nameStart = open + TOOL_CALL_OPEN.length;
		// Bound the name at the next tag start too, so an emission missing the
		// open tag's terminator cannot swallow following tags into the name.
		const tagEnd = haystack.indexOf(">", nameStart);
		const nextTagStart = haystack.indexOf(TAG_START, nameStart);
		const nameEnd = tagEnd === -1 ? nextTagStart : nextTagStart === -1 ? tagEnd : Math.min(tagEnd, nextTagStart);
		if (nameEnd === -1) {
			incomplete = true;
			break;
		}
		const close = haystack.indexOf(TOOL_CALL_CLOSE, nameEnd);
		const nextOpen = haystack.indexOf(TOOL_CALL_OPEN, nameStart);
		if (close === -1 || (nextOpen !== -1 && nextOpen < close)) {
			// Open tag whose close never arrives before another open: the call was
			// cut in transit (or the fragment is quoted prose). Skip to the next
			// open so a later well-formed envelope is still seen.
			incomplete = true;
			cursor = nextOpen === -1 ? nameEnd + 1 : nextOpen;
			continue;
		}
		cursor = close + TOOL_CALL_CLOSE.length;
		const name = haystack.slice(nameStart, nameEnd).trim().replace(NON_TEXT_CHARS_RE, "").slice(0, MAX_NAME_LENGTH);
		if (name.length > 0) {
			complete.push({ name });
		} else {
			incomplete = true;
		}
	}
	if (complete.length === 0 && !incomplete) return undefined;
	return { complete, incomplete };
}

/** Distinct transcribed tool names in emission order. */
export function textChannelToolCallNames(detection: TextChannelToolCallDetection): string[] {
	const names = new Set<string>();
	for (const call of detection.complete) {
		names.add(call.name);
	}
	return [...names];
}
