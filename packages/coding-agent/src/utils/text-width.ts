import {
	Ellipsis,
	type ExtractSegmentsResult,
	extractSegments as nativeExtractSegments,
	sliceWithWidth as nativeSliceWithWidth,
	truncateToWidth as nativeTruncateToWidth,
	wrapTextWithAnsi as nativeWrapTextWithAnsi,
	type SliceResult,
} from "@oh-my-pi/pi-natives";
import { DEFAULT_TAB_WIDTH } from "@oh-my-pi/pi-utils";

export function sliceWithWidth(line: string, startCol: number, length: number, strict?: boolean | null): SliceResult {
	return nativeSliceWithWidth(line, startCol, length, strict ?? null, DEFAULT_TAB_WIDTH);
}

const SGR_SEQUENCE = /\x1b\[([0-9:;]*)m/g;

const SGR_RESET = "\x1b[0m";

function ellipsisText(kind: Ellipsis): string {
	switch (kind) {
		case Ellipsis.Ascii:
			return "...";
		case Ellipsis.Omit:
			return "";
		default:
			return "…";
	}
}

/**
 * Background SGR active at the end of `prefix`, or undefined when the row has
 * no background. Native truncation resets every attribute before its ellipsis,
 * so only the background needs restoring there.
 */
function activeBackground(prefix: string): string | undefined {
	let background: string | undefined;
	for (const match of prefix.matchAll(SGR_SEQUENCE)) {
		const params = match[1]!.split(";");
		for (let i = 0; i < params.length; i++) {
			const raw = params[i]!;
			if (raw.includes(":")) {
				if (raw.startsWith("48:")) background = `\x1b[${raw}m`;
				continue;
			}
			const code = Number(raw);
			if (raw === "" || code === 0 || code === 49) {
				background = undefined;
			} else if (code === 38 || code === 48) {
				const mode = params[i + 1];
				const extra = mode === "5" ? 2 : mode === "2" ? 4 : 0;
				if (extra > 0 && i + extra < params.length) {
					if (code === 48) {
						background = `\x1b[${params.slice(i, i + extra + 1).join(";")}m`;
					}
					i += extra;
				}
			} else if ((code >= 40 && code <= 47) || (code >= 100 && code <= 107)) {
				background = `\x1b[${code}m`;
			}
		}
	}
	return background;
}

/**
 * Native truncation closes styling with a full reset before its ellipsis. On a
 * tinted row that reset also drops the background, so the ellipsis and native
 * padding lose the row's fill. Re-open the background after the reset and keep
 * it through the padding.
 */
function preserveTruncatedBackground(text: string, truncated: string, kind: Ellipsis): string {
	// The native fast path returns the original row plus plain padding when it
	// fits; any reset/ellipsis in it came from the caller, not truncation.
	if (truncated.startsWith(text) || !text.includes("\x1b")) return truncated;
	const ellipsis = ellipsisText(kind);
	const marker = `${SGR_RESET}${ellipsis}`;
	const at = truncated.lastIndexOf(marker);
	if (at < 0) return truncated;
	const suffix = truncated.slice(at + marker.length);
	if (!/^ *$/.test(suffix)) return truncated;
	const prefix = truncated.slice(0, at);
	const background = activeBackground(prefix);
	if (background === undefined) return truncated;
	return `${prefix}${SGR_RESET}${background}${ellipsis}${suffix}\x1b[49m`;
}

export function truncateToWidth(
	text: string,
	maxWidth: number,
	ellipsisKind?: Ellipsis | null | "",
	pad?: boolean | null,
): string {
	maxWidth = Math.max(0, maxWidth | 0);
	// Fast path: every UTF-16 unit is at most 3 cells wide, so a plain string
	// whose `length * 3` already fits within `maxWidth` cannot need truncation.
	// OSC 66 spans are excluded because their display width is metadata-driven,
	// not proportional to their UTF-16 length.
	if (!pad && !text.includes("\x1b]66") && text.length * 3 <= maxWidth) {
		return text;
	}
	const kind = (typeof ellipsisKind === "string" ? Ellipsis.Omit : ellipsisKind) ?? Ellipsis.Unicode;
	const truncated = nativeTruncateToWidth(text, maxWidth, kind, pad ?? false, DEFAULT_TAB_WIDTH);
	return preserveTruncatedBackground(text, truncated, kind);
}

export function wrapTextWithAnsi(text: string, width: number): string[] {
	return nativeWrapTextWithAnsi(text, width, DEFAULT_TAB_WIDTH);
}

export function extractSegments(
	line: string,
	beforeEnd: number,
	afterStart: number,
	afterLen: number,
	strictAfter: boolean,
): ExtractSegmentsResult {
	return nativeExtractSegments(line, beforeEnd, afterStart, afterLen, strictAfter, DEFAULT_TAB_WIDTH);
}

const TAB_SPACES = " ".repeat(DEFAULT_TAB_WIDTH);

/*
 * Replace tabs with the fixed display tab width for consistent rendering.
 */
export function replaceTabs(text: string): string {
	return text.replaceAll("\t", TAB_SPACES);
}

/** Tabs expanded and line breaks collapsed to spaces, for text confined to one rendered row. */
export function singleLine(text: string): string {
	return replaceTabs(text).replace(/[\r\n]+/g, " ");
}

// Grapheme segmenter (shared instance)
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * Get the shared grapheme segmenter instance.
 */
export function getSegmenter(): Intl.Segmenter {
	return segmenter;
}
