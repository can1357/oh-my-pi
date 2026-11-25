/**
 * What a draft can hold besides typed text: attachment chips, atoms in the
 * text (deleting into one deletes all of it).
 *
 * A chip (`📄 #1`, `📷 #1`, `🎬 #2`: the symbol preset's `chip.*` glyph and a
 * number) stands for a text attachment, an image or a video. A paste of more
 * than 10 lines or 1000 characters collapses into a text chip; the content
 * comes back on submit. In the terminal each chip takes its own color from a
 * fixed palette.
 */
import { registerBlob } from "@oh-my-pi/pi-tui/native/blobs";

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
	/** A chip (attachment) or a token chip (`/skill:name`) standing for its command. */
	readonly kind: ChipKind | "token";
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

/** A draft image's blob id, riding on the image so its bytes are hashed and registered once. */
const kBlob = Symbol("composer.imageBlob");

interface DraftImageWithBlob extends DraftImage {
	[kBlob]?: string;
}

/**
 * The blob id of a draft image, its bytes registered so a terminal can be sent them: what the
 * chip's token in the field and the picture on its card name.
 */
export function draftImageBlob(image: DraftImage): string {
	const tagged = image as DraftImageWithBlob;
	tagged[kBlob] ??= registerBlob(Buffer.from(image.data, "base64"), image.mimeType);
	return tagged[kBlob];
}

/** A pixel size. */
export interface PixelSize {
	readonly w: number;
	readonly h: number;
}

/**
 * The draft image and pixel size of a picture the terminal handed back (Tern's annotator, a
 * `change` event's value), when `value` is one: a PNG or JPEG with base64 bytes, whole positive
 * width and height.
 */
export function pictureDraftImage(
	value: unknown,
): { readonly image: DraftImage; readonly size: PixelSize } | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	if (!("mime" in value && "data" in value && "w" in value && "h" in value)) return undefined;
	const { mime, data, w, h } = value;
	if (mime !== "image/png" && mime !== "image/jpeg") return undefined;
	if (typeof data !== "string" || data === "") return undefined;
	if (typeof w !== "number" || typeof h !== "number") return undefined;
	if (!Number.isSafeInteger(w) || !Number.isSafeInteger(h) || w < 1 || h < 1) return undefined;
	return { image: { type: "image", data, mimeType: mime }, size: { w, h } };
}

/** An image or video marker's head up to its pixel size (`[Image #1, `), then the size, before `]` or `,`. */
const MARKER_SIZE = /^(\[(?:Image|Video) #\d+, )(\d+)x(\d+)(?=[\],])/;

/** The pixel size an image or video chip's marker states (`[Image #1, 800x600]`), when it states one. */
export function markerPixelSize(marker: string | undefined): PixelSize | undefined {
	const size = marker === undefined ? null : MARKER_SIZE.exec(marker);
	return size ? { w: Number(size[2]), h: Number(size[3]) } : undefined;
}

/** `marker` stating pixel size `size` instead of the one it states (unchanged when it states none). */
export function withMarkerPixelSize(marker: string, size: PixelSize): string {
	return marker.replace(MARKER_SIZE, (_, head: string) => `${head}${size.w}x${size.h}`);
}

/** Lines over which a paste collapses into a text chip. */
export const PASTE_MAX_LINES = 10;
/** Characters over which a paste collapses into a text chip. */
export const PASTE_MAX_CHARS = 1000;

/** Whether pasted `text` collapses into a text chip. */
export function collapsesPaste(text: string): boolean {
	return text.split("\n").length > PASTE_MAX_LINES || text.length > PASTE_MAX_CHARS;
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
