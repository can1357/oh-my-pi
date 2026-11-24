/**
 * What a draft can hold besides typed text: collapsed pastes and attachment
 * chips. Both are atoms in the text: deleting into one deletes all of it.
 *
 * - A paste of more than 10 lines or 1000 characters collapses to
 *   `[Paste #N, +L lines]` / `[Paste #N, C chars]`; the content comes back on
 *   submit.
 * - A chip (`📄 #1`, `📷 #1`, `🎬 #2`: the symbol preset's `chip.*` glyph and
 *   a number) stands for a text attachment, an image or a video. In the
 *   terminal each chip takes its own color from a fixed palette.
 */

export type ChipKind = "paste" | "image" | "video";

/** An image the draft carries (base64 bytes). */
export interface DraftImage {
	readonly type: "image";
	readonly data: string;
	readonly mimeType: string;
}

/** One atom of the draft. */
export interface Atom {
	/** The text the atom occupies in the draft. */
	readonly label: string;
	/** A chip (attachment), a collapsed paste's marker, or a token chip (`/skill:name`) standing for its command. */
	readonly kind: ChipKind | "marker" | "token";
	/** Its number among its kind (`#N`). */
	readonly n: number;
	/** What the atom expands to on submit (pasted text, an image reference); the label itself when absent. */
	readonly expansion?: string;
	/** What a text chip shows when it differs from what it submits (a wrapped paste). */
	readonly content?: string;
	readonly image?: DraftImage;
	/** A token chip's span style (a theme style token). */
	readonly s?: string;
	/** A token chip's file (a path) and the line it opens at, linked where the terminal draws links. */
	readonly link?: { readonly path: string; readonly line?: number };
}

/** Lines over which a paste collapses into a marker. */
export const PASTE_MAX_LINES = 10;
/** Characters over which a paste collapses into a marker. */
export const PASTE_MAX_CHARS = 1000;

/** Whether pasted `text` collapses into a marker. */
export function collapsesPaste(text: string): boolean {
	return text.split("\n").length > PASTE_MAX_LINES || text.length > PASTE_MAX_CHARS;
}

/** The marker of paste `n` holding `text`. */
export function pasteMarker(n: number, text: string): string {
	const lines = text.split("\n").length;
	return lines > PASTE_MAX_LINES ? `[Paste #${n}, +${lines} lines]` : `[Paste #${n}, ${text.length} chars]`;
}

/** Default chip glyphs (the unicode symbol preset). */
const CHIP_GLYPHS: Record<ChipKind, string> = { image: "📷", video: "🎬", paste: "📄" };

/** A chip label: the kind's glyph from `symbol` (a symbol-key lookup) and its number. */
export function chipLabel(kind: ChipKind, n: number, symbol?: (key: string) => string): string {
	return `${symbol?.(`chip.${kind}`) || CHIP_GLYPHS[kind]} #${n}`;
}

const PALETTE: readonly string[] = ["#ffb366", "#7dcfff", "#bd93f9", "#69dc9e", "#ff8dbc", "#f0df78"];

/** The color of chip `n` of `kind` (each kind starts at its own palette offset). */
export function chipColor(kind: ChipKind, n: number): string {
	const offset = kind === "image" ? -1 : kind === "video" ? 1 : 2;
	return PALETTE[(((n + offset) % PALETTE.length) + PALETTE.length) % PALETTE.length]!;
}

/** Ranges of the atoms present in `text`, in text order. */
export function atomRanges(text: string, atoms: readonly Atom[]): { from: number; to: number; atom: Atom }[] {
	const out: { from: number; to: number; atom: Atom }[] = [];
	for (const atom of atoms) {
		let at = text.indexOf(atom.label);
		while (at !== -1) {
			out.push({ from: at, to: at + atom.label.length, atom });
			at = text.indexOf(atom.label, at + atom.label.length);
		}
	}
	return out.sort((a, b) => a.from - b.from);
}

/** `text` with every atom replaced by its expansion. */
export function expandAtoms(text: string, atoms: readonly Atom[]): string {
	let out = "";
	let at = 0;
	for (const range of atomRanges(text, atoms)) {
		if (range.from < at) continue;
		out += text.slice(at, range.from) + (range.atom.expansion ?? range.atom.label);
		at = range.to;
	}
	return out + text.slice(at);
}
