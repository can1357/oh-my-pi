/**
 * Agent reactions. A reply whose text opens with a lone emoji line (`<emoji>\n`)
 * is reacting to the transcript block before it: the emoji is lifted out of the
 * prose and shown as a badge on that block instead. While the reply streams,
 * the opening run is withheld until it either completes a reaction line or
 * proves to be ordinary text, so the emoji never flashes inside the reply.
 *
 * Reactions are derived from the persisted assistant text, never stored, so a
 * rebuilt transcript reproduces them exactly.
 */
import type { Component } from "@oh-my-pi/pi-tui";

/** A transcript block that can display an agent reaction badge. */
export interface ReactionTarget {
	setReaction(emoji: string): void;
}

/** Whether `component` accepts a reaction badge. */
export function isReactionTarget(component: Component | undefined): component is Component & ReactionTarget {
	return component !== undefined && "setReaction" in component && typeof component.setReaction === "function";
}

/** Longest emoji grapheme (UTF-16 units) still worth withholding for. */
const MAX_REACTION_UNITS = 32;
/** One emoji grapheme: an RGI sequence, or a bare pictograph with optional VS16. */
const REACTION_RE = /^(?:\p{RGI_Emoji}|\p{Extended_Pictographic}\uFE0F?)$/v;
/** A still-streaming run that can only ever be an emoji grapheme (plus trailing blanks): pictographs, skin tones, flag letters, tag letters, VS16, ZWJ, keycap. */
const REACTION_PREFIX_RE =
	/^(?:[\p{Extended_Pictographic}\p{Emoji_Modifier}\p{Regional_Indicator}\u{E0020}-\u{E007F}]|\uFE0F|\u200D|\u20E3)*[ \t]*$/u;

export interface ReactionSplit {
	/** The reaction emoji when the text opens with `<emoji>\n`. */
	emoji?: string;
	/** Text with the reaction line removed; the input when there is none. */
	body: string;
	/** True while the (newline-less) text could still grow into a reaction line. */
	pending: boolean;
}

/**
 * Split a reaction line off the front of assistant text. Leading whitespace and
 * trailing blanks on the emoji line are tolerated; anything else on that line
 * makes it ordinary prose.
 */
export function splitReaction(text: string): ReactionSplit {
	const start = text.length - text.trimStart().length;
	const newline = text.indexOf("\n", start);
	if (newline < 0) {
		const head = text.slice(start);
		return { body: text, pending: head.length <= MAX_REACTION_UNITS && REACTION_PREFIX_RE.test(head) };
	}
	const head = text.slice(start, newline).trimEnd();
	if (head.length === 0 || head.length > MAX_REACTION_UNITS || !REACTION_RE.test(head)) {
		return { body: text, pending: false };
	}
	return { emoji: head, body: text.slice(newline + 1), pending: false };
}
