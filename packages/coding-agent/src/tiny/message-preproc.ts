/**
 * Converts raw user text into bounded, low-noise input for tiny models.
 *
 * Tiny models copy literal noise verbatim and lose the task when only the head
 * of a long message survives. The shared pipeline strips ANSI escapes, paired
 * XML/tool envelopes, full commit hashes, and fenced code blocks, then preserves
 * both ends with an explicit omission marker. Title generation, auto-thinking,
 * and the title benchmark MUST use this same policy.
 */

/** Maximum characters emitted by {@link preprocessTinyMessage}. */
export const MAX_TINY_MESSAGE_CHARS = 2000;

/**
 * Minimum length of code-stripped input below which we fall back to the
 * original message. Guards against messages that are (almost) entirely a code
 * block — stripping would otherwise leave the model nothing to title from.
 */
const MIN_STRIPPED_TITLE_CHARS = 12;
/** Matches a fenced code block (3+ backticks), including an unterminated trailing fence. */
const FENCED_CODE_BLOCK = /```+[\s\S]*?(?:```+|$)/g;
/** Matches SGR ANSI escape sequences (colors/styles) that leak in from pasted terminal output. */
const ANSI_ESCAPE = /\u001b\[[0-9;]*m/g;
/** Matches a paired XML/HTML-ish block, e.g. `<user>…</user>` or a tool envelope. */
const XML_BLOCK = /<([a-zA-Z][\w-]*)(?:\s[^>]*)?>[\s\S]*?<\/\1>/g;
/** Matches a hex run long enough to be a full commit SHA rather than an ordinary word. */
const LONG_HEX_RUN = /\b[0-9a-fA-F]{12,}\b/g;
/** Short-hash prefix length kept after truncating a long hex run. */
const SHORT_HASH_CHARS = 7;
/**
 * Raw characters kept from each end of an oversized message before any cleanup.
 * Fenced-block stripping is linear, so this cap is generous: it only bounds total
 * work on pathological pastes while letting prose between large code blocks survive.
 */
const RAW_SCAN_EDGE_CHARS = 262_144;
/**
 * Characters kept from each end of the fence-stripped message before paired-tag
 * stripping. The paired-tag regex is quadratic on unclosed `<Tag>`s (TS generics,
 * JSX); output is bounded to {@link MAX_TINY_MESSAGE_CHARS} anyway, so the
 * dropped middle is never emitted.
 */
const CLEAN_WINDOW_EDGE_CHARS = 16_384;
/** Joins the head and tail windows of an oversized message. */
const WINDOW_SEPARATOR = "\n…\n";

/** Keep `edgeChars` from each end of `message` when it exceeds twice that. */
function windowEdges(message: string, edgeChars: number): string {
	if (message.length <= edgeChars * 2) return message;
	return `${message.slice(0, edgeChars)}${WINDOW_SEPARATOR}${message.slice(-edgeChars)}`;
}

/** Drop SGR ANSI escape sequences. */
export function stripAnsi(message: string): string {
	return message.replace(ANSI_ESCAPE, "");
}

/**
 * Remove paired XML/HTML-ish blocks (`<user>…</user>`, `<think>…</think>`,
 * tool envelopes). Self-closing and unpaired inline tags (`<Header/>`, a lone
 * `<div>`) are left in place — only fully paired blocks, whose contents would
 * otherwise dominate the title, are dropped.
 */
export function stripXmlBlocks(message: string): string {
	return message.replace(XML_BLOCK, " ");
}

/** Truncate full commit-hash-like hex runs (≥12 chars) to a short 7-char prefix. */
export function shortenHashes(message: string): string {
	return message.replace(LONG_HEX_RUN, match => match.slice(0, SHORT_HASH_CHARS));
}

/**
 * Middle-truncate cleaned text, preserving 2/3 of the available space from the
 * head and 1/3 from the tail. The omission marker counts toward the bound.
 */
export function truncateTinyMessage(message: string): string {
	if (message.length <= MAX_TINY_MESSAGE_CHARS) return message;
	let omitted = message.length - MAX_TINY_MESSAGE_CHARS;
	let marker = "";
	let headChars = 0;
	let tailChars = 0;
	// The omitted count changes the marker width; two passes converge because
	// only the decimal digit count can change.
	for (let pass = 0; pass < 2; pass++) {
		marker = `\n[… ${omitted} chars omitted …]\n`;
		const keptChars = Math.max(0, MAX_TINY_MESSAGE_CHARS - marker.length);
		headChars = Math.ceil((keptChars * 2) / 3);
		tailChars = keptChars - headChars;
		omitted = message.length - headChars - tailChars;
	}
	marker = `\n[… ${omitted} chars omitted …]\n`;
	return `${message.slice(0, headChars)}${marker}${message.slice(-tailChars)}`;
}

/**
 * Strip fenced code blocks from a message before titling.
 *
 * Small title models latch onto literal text inside code blocks — e.g. a pasted
 * UI mockup containing "Welcome to Claude Code v2.1.158" yields that string as
 * the title instead of the surrounding intent. Removing fenced blocks leaves the
 * prose that actually describes the task. Inline code (single backticks) is kept
 * — it is short, high-signal context like `/login`.
 *
 * Falls back to the original message when stripping leaves too little to title
 * (a message that is essentially just a code block).
 */
export function stripCodeBlocks(message: string): string {
	const cleaned = collapseWhitespace(message.replace(FENCED_CODE_BLOCK, " "));
	return cleaned.length >= MIN_STRIPPED_TITLE_CHARS ? cleaned : message;
}

/** Collapse horizontal whitespace runs and excess blank lines, then trim. */
function collapseWhitespace(message: string): string {
	return message
		.replace(/[ \t]+/g, " ")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

/**
 * Clean noise from message content without applying the length bound.
 * The raw input is capped at {@link RAW_SCAN_EDGE_CHARS} per end, fenced blocks
 * are stripped, and only then is the remainder windowed to
 * {@link CLEAN_WINDOW_EDGE_CHARS} per end before paired-tag stripping, so prose
 * between large code blocks is preserved.
 */
export function cleanTinyMessage(message: string): string {
	const fenceStripped = stripCodeBlocks(stripAnsi(windowEdges(message, RAW_SCAN_EDGE_CHARS)));
	return collapseWhitespace(shortenHashes(stripXmlBlocks(windowEdges(fenceStripped, CLEAN_WINDOW_EDGE_CHARS))));
}

/** Apply the shared tiny-model cleanup and middle-truncation policy. */
export function preprocessTinyMessage(message: string): string {
	return truncateTinyMessage(cleanTinyMessage(message));
}

/** Envelope produced by {@link formatTitleConversationContext}. Anchored to both
 *  ends so ordinary user text merely containing a chat snippet never matches. */
const CHAT_CONTEXT_ENVELOPE = /^\s*<chat>[\s\S]*<\/chat>\s*$/;
/** Structural tags emitted by {@link formatTitleConversationContext}. */
const CHAT_SCAFFOLD_TAG = /<\/?(?:chat|user|assistant|think)>/g;

/** True when `message` is a preformatted replan context from
 *  {@link formatTitleConversationContext} — already cleaned per turn and
 *  bounded, so it must bypass {@link preprocessTinyMessage} (whose paired-tag
 *  stripping would consume the entire envelope). */
export function isPreformattedChatContext(message: string): boolean {
	return CHAT_CONTEXT_ENVELOPE.test(message);
}

/** Drop the `<chat>`/`<user>`/`<assistant>`/`<think>` scaffolding, keeping turn
 *  text. Used for token-level signal checks on preformatted contexts. */
export function stripChatScaffolding(message: string): string {
	return message.replace(CHAT_SCAFFOLD_TAG, " ");
}

/** Wrap a preprocessed user message for title generation. Preformatted replan
 *  contexts pass through untouched. */
export function formatTitleUserMessage(message: string): string {
	if (isPreformattedChatContext(message)) return message;
	return `<user>\n${preprocessTinyMessage(message)}\n</user>`;
}

/** One recent conversation turn supplied to title refresh after replanning. */
export interface TitleConversationTurn {
	role: "user" | "assistant";
	text?: string;
	thinking?: string;
}

/** Format preprocessed recent context for title generation after a todo replan. */
export function formatTitleConversationContext(turns: readonly TitleConversationTurn[]): string {
	const formattedTurns: string[] = [];
	for (const turn of turns) {
		const sections: string[] = [];
		// Clean raw content before adding structural tags so paired-tag stripping
		// cannot consume the `<user>`/`<assistant>` scaffolding added below.
		const text = cleanTinyMessage(turn.text ?? "").trim();
		if (text) sections.push(text);
		const thinking = turn.role === "assistant" ? cleanTinyMessage(turn.thinking ?? "").trim() : "";
		if (thinking) sections.push(`<think>\n${thinking}\n</think>`);
		if (sections.length === 0) continue;
		formattedTurns.push(`<${turn.role}>\n${sections.join("\n\n")}\n</${turn.role}>`);
	}
	if (formattedTurns.length === 0) return "";
	return truncateTinyMessage(`<chat>\n${formattedTurns.join("\n\n")}\n</chat>`);
}
