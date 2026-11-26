/**
 * Terminal look of a status-bar segment (`seg`'s `term` prop): the pieces its
 * row is drawn from, which the `omp.status.*` look paints. Native terminals
 * draw the `seg`'s own spans and icon instead.
 *
 * Style tokens are theme tokens plus `sessionAccent`: the session accent when
 * the look names its `title` (the accent's seed), else the theme accent.
 */

/** Text in a style, linked when `href` is set and the terminal links. */
export interface TextPiece {
	readonly t: string;
	readonly s?: string;
	readonly href?: string;
}

/** A named icon glyph (the first of several the preset has) in a style. */
export interface IconPiece {
	readonly icon: string | readonly string[];
	readonly s?: string;
	/** Where the space separating it from its neighbour goes (default after); none when the preset has no glyph. */
	readonly space?: "after" | "before" | "none";
	/** The separating space stays unstyled. */
	readonly bare?: boolean;
	/** Text drawn instead when the preset has no glyph. */
	readonly else?: string;
	/** Only the glyph's lead up to its first space (`◒ high` → `◒`). */
	readonly lead?: boolean;
	readonly href?: string;
}

/** Extension statuses (their SGR kept), joined by a dim dot, in the `s` color. */
export interface StatusesPiece {
	readonly statuses: readonly string[];
	readonly s: string;
}

/**
 * The brand: the `omp` glyph while idle (`brand: null`); while a turn runs, a
 * spinner frame (`?` while awaiting an answer) and the turn timer since
 * `brand` (terminal-clock ms). `profile` tags the glyph (`π-work`).
 */
export interface BrandPiece {
	readonly brand: number | null;
	/** The brand's color eases from `fadeFrom`'s into `s`' over the moment after `fadeAt` (terminal-clock ms). */
	readonly fadeFrom?: string;
	readonly fadeAt?: number;
	readonly awaiting?: boolean;
	readonly profile?: string;
	readonly s: string;
}

/** One piece of a segment row. */
export type LookPiece = TextPiece | IconPiece | StatusesPiece | BrandPiece;

/** A segment's terminal look. */
export type SegLook = {
	readonly pieces: readonly LookPiece[];
	/** Which end gives way when the segment is cut (default `end`). */
	readonly truncate?: "start" | "end";
	/** Seed of the session accent (`sessionAccent` tokens). */
	readonly title?: string;
};
