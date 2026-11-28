/**
 * Detects tool calls the model transcribed as literal text in an assistant
 * message instead of emitting as structured `toolCall` blocks. A text channel
 * "envelope" is the foreign chat-template spelling: an open tag carrying
 * `function=NAME`, `parameter=NAME` pairs, and a matching close tag. Such text
 * is displayed to the user but never dispatched, which stalls the session at
 * "the call announced in prose".
 *
 * The scan is deliberately shallow: envelope-level structure and tool names
 * only, NEVER parameter values. Values in this markup family are not opaque —
 * an embedded close tag inside a value terminates the value and rebinds later
 * parameters — so any consumer that parsed values would silently corrupt
 * arguments. Feedback only needs names.
 *
 * Detection requires at least one COMPLETE call envelope (open tag with a
 * `parameter=NAME` pair before its close tag). Bare mentions of the grammar in
 * prose or code spans — documenting or reviewing this markup — must not fire:
 * fenced blocks and inline code spans are stripped first, and an unclosed open
 * tag alone is never enough evidence.
 */

const TOOL_CALL_OPEN = "<" + "function=";
const TOOL_CALL_CLOSE = "<" + "/" + "function>";
const PARAM_OPEN = "<" + "parameter=";
const PARAM_CLOSE = "<" + "/" + "parameter>";

/** Fenced blocks (```/~~~) and inline code spans carry examples, not calls. */
const FENCED_BLOCK_RE = /(```|~~~)[\s\S]*?\1[^\S\n]*(?:\n|$)/g;
const INLINE_CODE_RE = /`[^`\n]*`/g;

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
	/** Complete envelopes (open + close tag with a parameter pair) in order. */
	complete: readonly TextChannelToolCall[];
	/**
	 * True when an open tag never reaches a complete form (cut in transit).
	 * Annotation only: a detection fires on `complete` alone.
	 */
	incomplete: boolean;
}

/**
 * Returns undefined when the text carries no complete call envelope. A
 * complete entry requires a close tag before the next open tag and at least
 * one `parameter=NAME` pair, so a quoted unclosed fragment cannot swallow the
 * envelope that follows it and prose mentions of the bare grammar never fire.
 */
export function detectTextChannelToolCalls(text: string): TextChannelToolCallDetection | undefined {
	const scannable = text.replace(FENCED_BLOCK_RE, "\n").replace(INLINE_CODE_RE, " ");
	const haystack = scannable.length > SCAN_LIMIT ? scannable.slice(0, SCAN_LIMIT) : scannable;
	const complete: TextChannelToolCall[] = [];
	let incomplete = false;
	let cursor = 0;
	for (;;) {
		const open = haystack.indexOf(TOOL_CALL_OPEN, cursor);
		if (open === -1) break;
		const nameStart = open + TOOL_CALL_OPEN.length;
		const nameEnd = haystack.indexOf(">", nameStart);
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
		const paramOpen = haystack.indexOf(PARAM_OPEN, nameEnd);
		const paramClose = haystack.indexOf(PARAM_CLOSE, nameEnd);
		if (paramOpen === -1 || paramOpen > close || paramClose === -1 || paramClose > close) {
			// Open + close without a parameter pair is not a call envelope (the
			// observed grammar always carries `parameter=NAME` pairs).
			incomplete = true;
			continue;
		}
		const name = haystack.slice(nameStart, nameEnd).trim().replace(NON_TEXT_CHARS_RE, "").slice(0, MAX_NAME_LENGTH);
		if (name.length > 0) {
			complete.push({ name });
		} else {
			incomplete = true;
		}
	}
	if (complete.length === 0) return undefined;
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
