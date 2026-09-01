import { SYMBOL_PRESETS } from "./theme/symbols";
import { theme } from "./theme/theme";

/** Attachment chip kinds staged in the composer: pasted images and large text pastes. */
export type ChipKind = "image" | "paste";

const CHIP_ICON_KEY = { image: "chip.image", paste: "chip.paste" } as const;

/** Compact atomic composer token for attachment `n` in the active symbol preset. */
export function chipLabel(kind: ChipKind, n: number): string {
	const icon =
		typeof theme === "undefined" ? SYMBOL_PRESETS.unicode[CHIP_ICON_KEY[kind]] : theme.symbol(CHIP_ICON_KEY[kind]);
	return `${icon} #${n}`;
}

/** Every glyph a chip token may start with, across all symbol presets. */
const CHIP_ICONS: Record<ChipKind, readonly string[]> = {
	image: [...new Set(Object.values(SYMBOL_PRESETS).map(m => m[CHIP_ICON_KEY.image]))],
	paste: [...new Set(Object.values(SYMBOL_PRESETS).map(m => m[CHIP_ICON_KEY.paste]))],
};

const CHIP_TOKEN_SOURCE = `(?:${[...CHIP_ICONS.image, ...CHIP_ICONS.paste]
	.map(icon => (/^[a-z]+$/i.test(icon) ? `(?<![A-Za-z])${RegExp.escape(icon)}` : RegExp.escape(icon)))
	.join("|")}) #[1-9]\\d*`;

/** Infers an attachment kind from a chip label emitted by any configured symbol preset. */
export function chipLabelKind(label: string): ChipKind {
	return CHIP_ICONS.image.some(icon => label.startsWith(icon)) ? "image" : "paste";
}

const ATTACHMENT_PALETTE: readonly [number, number, number][] = [
	[255, 179, 102],
	[125, 207, 255],
	[189, 147, 249],
	[105, 220, 158],
	[255, 141, 188],
	[240, 223, 120],
];

/** Stable RGB color assigned to attachment `n`; image and paste sequences use different offsets. */
export function attachmentRgb(kind: ChipKind, n: number): readonly [number, number, number] {
	const index = kind === "image" ? (n - 1) % ATTACHMENT_PALETTE.length : (n + 2) % ATTACHMENT_PALETTE.length;
	return ATTACHMENT_PALETTE[index];
}

/** ANSI truecolor foreground sequence for the color assigned by {@link attachmentRgb}. */
export function attachmentSgr(kind: ChipKind, n: number): string {
	const [r, g, b] = attachmentRgb(kind, n);
	return `\x1b[38;2;${r};${g};${b}m`;
}

/** Matches expanded image and paste markers, including optional marker metadata. */
export const PLACEHOLDER_REGEX = /\[(Image|Paste) #([1-9]\d*)(?:,[^\]\n]*)?\]/g;
/** Matches either an expanded attachment marker or a compact composer chip token. */
export const COMPOSER_TOKEN_REGEX = new RegExp(`${PLACEHOLDER_REGEX.source}|${CHIP_TOKEN_SOURCE}`, "gu");

const IMAGE_MARKER_REGEX = /\[Image #([1-9]\d*)((?:,[^\]\n]*)?)\](?: attachment:\/\/(\1))?/g;

/** Offsets image marker indices, including matching `attachment://` references. */
export function shiftImageMarkers(text: string, offset: number): string {
	if (offset === 0) return text;
	return text.replace(IMAGE_MARKER_REGEX, (_match, idx: string, tail: string, attachmentIdx: string | undefined) => {
		const marker = `[Image #${Number(idx) + offset}${tail}]`;
		return attachmentIdx === undefined ? marker : `${marker} attachment://${Number(attachmentIdx) + offset}`;
	});
}

/**
 * Replaces valid expanded image markers with compact tokens and registers each
 * token's original marker as its atomic editor expansion.
 */
export function collapseImageMarkers(
	text: string,
	imageCount: number,
	register: (label: string, expansion: string) => void,
): string {
	if (imageCount === 0) return text;
	return text.replace(IMAGE_MARKER_REGEX, (match, idx: string, tail: string) => {
		const n = Number(idx);
		if (n > imageCount) return match;
		const label = chipLabel("image", n);
		register(label, `[Image #${n}${tail}]`);
		return label;
	});
}

/**
 * Drops unreferenced images from a submission and densely remaps retained image
 * markers. Returns `null` when no compaction is needed.
 */
export function compactImageMarkers(text: string, imageCount: number): { text: string; keep: number[] } | null {
	if (imageCount === 0) return null;
	const referenced = new Set<number>();
	const scanner = new RegExp(IMAGE_MARKER_REGEX.source, "g");
	for (;;) {
		const match = scanner.exec(text);
		if (match === null) break;
		const n = Number(match[1]);
		if (n <= imageCount) referenced.add(n);
	}
	if (referenced.size === imageCount) return null;
	const keep = [...referenced].sort((a, b) => a - b);
	const remap = new Map<number, number>(keep.map((n, i) => [n, i + 1]));
	const rewritten = text.replace(
		IMAGE_MARKER_REGEX,
		(match, idx: string, tail: string, attachmentIdx: string | undefined) => {
			const mapped = remap.get(Number(idx));
			if (mapped === undefined) return match;
			const marker = `[Image #${mapped}${tail}]`;
			return attachmentIdx === undefined ? marker : `${marker} attachment://${mapped}`;
		},
	);
	return { text: rewritten, keep: keep.map(n => n - 1) };
}

/** Attachment kinds understood by placeholder renderers. */
export type PlaceholderKind = "image" | "paste";

/** Rendering callbacks for plain text and parsed attachment references. */
export interface PlaceholderRenderers {
	/** Renders text outside attachment references. */
	renderText: (text: string) => string;
	/** Renders one parsed marker or compact chip token. */
	renderReference: (label: string, kind: PlaceholderKind, index: number, form: "marker" | "chip") => string;
}

/** Renders text while treating expanded markers and compact chips as distinct references. */
export function renderPlaceholders(text: string, renderers: PlaceholderRenderers): string {
	COMPOSER_TOKEN_REGEX.lastIndex = 0;
	let result = "";
	let last = 0;
	let matched = false;

	for (;;) {
		const match = COMPOSER_TOKEN_REGEX.exec(text);
		if (match === null) break;
		matched = true;
		if (match.index > last) result += renderers.renderText(text.slice(last, match.index));
		const label = match[0];
		if (label.startsWith("[")) {
			const kind: PlaceholderKind = match[1] === "Paste" ? "paste" : "image";
			result += renderers.renderReference(label, kind, Number(match[2]), "marker");
		} else {
			const index = Number(label.slice(label.lastIndexOf("#") + 1));
			result += renderers.renderReference(label, chipLabelKind(label), index, "chip");
		}
		last = match.index + match[0].length;
	}

	if (!matched) return renderers.renderText(text);
	if (last < text.length) result += renderers.renderText(text.slice(last));
	return result;
}
