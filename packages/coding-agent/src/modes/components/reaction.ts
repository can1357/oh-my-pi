/**
 * Agent reactions. A reply whose text opens with an emoji is reacting to the
 * transcript block before it: the emoji is lifted out of the prose and shown as
 * a badge on that block instead. While the reply streams, an incomplete opening
 * run is withheld until it either completes an emoji or proves to be ordinary
 * text, so the emoji never flashes inside the reply.
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
const REACTION_HEAD_RE = /^(?:\p{RGI_Emoji}|\p{Extended_Pictographic}\uFE0F?)/v;
/** Unicode characters that can extend a preceding emoji code point into a longer grapheme. */
const EMOJI_EXTENSION_RE = /^(?:[\p{Emoji_Modifier}\u{E0020}-\u{E007F}]|\uFE0F|\u200D|\u20E3)/u;
/** A still-streaming run that can only ever be an emoji grapheme (plus trailing blanks): pictographs, skin tones, flag letters, tag letters, VS16, ZWJ, keycap. */
const REACTION_PREFIX_RE =
	/^(?:[\p{Extended_Pictographic}\p{Emoji_Modifier}\p{Regional_Indicator}\u{E0020}-\u{E007F}]|\uFE0F|\u200D|\u20E3)*[ \t]*$/u;
/** Whitespace immediately following the opening emoji to consume: an inline newline or a run of horizontal spaces/tabs. */
const NEXT_WHITESPACE_RE = /^[ \t]*\r?\n|^[ \t]+/;

export interface ReactionSplit {
	/** The reaction emoji when the text opens with an emoji. */
	emoji?: string;
	/** Text with the opening emoji and any following whitespace removed; the input when there is none. */
	body: string;
	/** True while the text could still grow into an emoji. */
	pending: boolean;
}

/**
 * Split an opening reaction emoji off the front of assistant text, consuming
 * the next whitespace if any. Leading whitespace is tolerated.
 */
export function splitReaction(text: string): ReactionSplit {
	const start = text.length - text.trimStart().length;
	const head = text.slice(start);
	if (head.length === 0) {
		return { body: text, pending: true };
	}
	const match = head.match(REACTION_HEAD_RE);
	if (match) {
		const rest = head.slice(match[0].length);
		if (head.length <= MAX_REACTION_UNITS && EMOJI_EXTENSION_RE.test(rest)) {
			return { body: text, pending: true };
		}
		const wsMatch = rest.match(NEXT_WHITESPACE_RE);
		const body = rest.slice(wsMatch ? wsMatch[0].length : 0);
		return { emoji: match[0], body, pending: false };
	}
	return { body: text, pending: head.length <= MAX_REACTION_UNITS && REACTION_PREFIX_RE.test(head) };
}
