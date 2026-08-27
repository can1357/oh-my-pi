import {
	Ellipsis,
	type ExtractSegmentsResult,
	extractSegments as nativeExtractSegments,
	setHangulCompatJamoWidthOverride as nativeSetHangulCompatJamoWidthOverride,
	sliceWithWidth as nativeSliceWithWidth,
	truncateToWidth as nativeTruncateToWidth,
	wrapTextWithAnsi as nativeWrapTextWithAnsi,
	type SliceResult,
} from "@oh-my-pi/pi-natives";
import { DEFAULT_TAB_WIDTH } from "@oh-my-pi/pi-utils";

export { Ellipsis } from "@oh-my-pi/pi-natives";

export { DEFAULT_TAB_WIDTH } from "@oh-my-pi/pi-utils";

export type HangulCompatibilityJamoWidth = "platform" | "unicode" | 1 | 2;

let hangulCompatibilityJamoWidth: HangulCompatibilityJamoWidth = "platform";

// Wire encoding for the native override (see crates/pi-natives text.rs):
// 0 = platform default, 1 = narrow, 2 = wide, 3 = unicode (no correction).
function nativeHangulCompatibilityJamoOverride(width: HangulCompatibilityJamoWidth): number {
	if (width === "unicode") return 3;
	if (typeof width === "number") return width;
	return 0;
}

export function getHangulCompatibilityJamoWidth(): HangulCompatibilityJamoWidth {
	return hangulCompatibilityJamoWidth;
}

// Monotonic epoch for width-affecting runtime configuration. Any cache or
// carried-width sidecar derived from `visibleWidth` results must be stamped
// with the epoch at computation time and discarded on mismatch, so a Hangul
// Compatibility Jamo width change invalidates every derived width.
let widthConfigEpoch = 0;

export function getWidthConfigEpoch(): number {
	return widthConfigEpoch;
}

interface LineWidthsEntry {
	epoch: number;
	lines: readonly string[];
	widths: readonly number[];
}

// Per-render-result visible widths, keyed by the exact lines array a component
// returned. The copied strings and widths are the single publication snapshot:
// they cannot be changed through either publisher array and do not retain the
// WeakMap key. Entries therefore die with their lines-array owners.
const lineWidthSidecar = new WeakMap<readonly string[], LineWidthsEntry>();

/** Publish exact per-line visible widths for a rendered lines array. */
export function publishLineWidths(lines: readonly string[], widths: readonly number[]): void {
	if (lines.length !== widths.length) {
		throw new RangeError(`Cannot publish ${widths.length} widths for ${lines.length} lines`);
	}
	lineWidthSidecar.set(lines, {
		epoch: widthConfigEpoch,
		lines: [...lines],
		widths: Object.freeze([...widths]),
	});
}

/** Exact per-line visible widths for an unchanged `lines` array under the current width config. */
export function getPublishedLineWidths(lines: readonly string[]): readonly number[] | undefined {
	const entry = lineWidthSidecar.get(lines);
	if (entry === undefined || entry.epoch !== widthConfigEpoch || entry.lines.length !== lines.length) {
		return undefined;
	}
	for (let i = 0; i < lines.length; i++) {
		if (entry.lines[i] !== lines[i]) return undefined;
	}
	return entry.widths;
}

export function setHangulCompatibilityJamoWidth(width: HangulCompatibilityJamoWidth): boolean {
	const changed = hangulCompatibilityJamoWidth !== width;
	hangulCompatibilityJamoWidth = width;
	if (changed) widthConfigEpoch++;
	nativeSetHangulCompatJamoWidthOverride(nativeHangulCompatibilityJamoOverride(width));
	return changed;
}

export function resetHangulCompatibilityJamoWidthForTests(): void {
	if (hangulCompatibilityJamoWidth !== "platform") widthConfigEpoch++;
	hangulCompatibilityJamoWidth = "platform";
	nativeSetHangulCompatJamoWidthOverride(0);
}

export type TextSizingScale = 1 | 2 | 3;
export type TextSizingVerticalAlign = "top" | "bottom" | "center";
export type TextSizingHorizontalAlign = "left" | "right" | "center";

export interface TextSizingOptions {
	scale?: TextSizingScale;
	widthCells?: number;
	verticalAlign?: TextSizingVerticalAlign;
	horizontalAlign?: TextSizingHorizontalAlign;
}

const OSC66_UNSAFE = /[\x00-\x1f\x7f-\x9f]/u;
const OSC66_UNSAFE_GLOBAL = /[\x00-\x1f\x7f-\x9f]/gu;

function textSizingVerticalAlignValue(align: TextSizingVerticalAlign | undefined): number | undefined {
	switch (align) {
		case "top":
			return 0;
		case "bottom":
			return 1;
		case "center":
			return 2;
		default:
			return undefined;
	}
}

function textSizingHorizontalAlignValue(align: TextSizingHorizontalAlign | undefined): number | undefined {
	switch (align) {
		case "left":
			return 0;
		case "right":
			return 1;
		case "center":
			return 2;
		default:
			return undefined;
	}
}

/**
 * Encode a plain-text span using Kitty's OSC 66 text-sizing protocol. The TUI
 * emits only safe UTF-8 payloads and ST terminators so its ANSI parser and the
 * terminal agree on span boundaries.
 */
export function encodeTextSized(text: string, options: TextSizingOptions = {}): string {
	const metadata: string[] = [];
	if (options.scale !== undefined) metadata.push(`s=${options.scale}`);
	if (options.widthCells !== undefined && Number.isFinite(options.widthCells)) {
		metadata.push(`w=${Math.max(0, Math.trunc(options.widthCells))}`);
	}
	const verticalAlign = textSizingVerticalAlignValue(options.verticalAlign);
	if (verticalAlign !== undefined) metadata.push(`v=${verticalAlign}`);
	const horizontalAlign = textSizingHorizontalAlignValue(options.horizontalAlign);
	if (horizontalAlign !== undefined) metadata.push(`h=${horizontalAlign}`);

	const safeText = OSC66_UNSAFE.test(text) ? text.replace(OSC66_UNSAFE_GLOBAL, " ") : text;
	return `\x1b]66;${metadata.join(":")};${safeText}\x1b\\`;
}

export function sliceWithWidth(line: string, startCol: number, length: number, strict?: boolean | null): SliceResult {
	return nativeSliceWithWidth(line, startCol, length, strict ?? null, DEFAULT_TAB_WIDTH);
}

export function truncateToWidth(
	text: string,
	maxWidth: number,
	ellipsisKind?: Ellipsis | null | "",
	pad?: boolean | null,
): string {
	maxWidth = Math.max(0, maxWidth | 0);
	// Fast path: every UTF-16 unit is at most 3 cells wide, so a string whose
	// `length * 3` already fits within `safeWidth` cannot need truncation.
	if (!pad && text.length * 3 <= maxWidth) {
		return text;
	}
	return nativeTruncateToWidth(
		text,
		maxWidth,
		(typeof ellipsisKind === "string" ? Ellipsis.Omit : ellipsisKind) ?? Ellipsis.Unicode,
		pad ?? false,
		DEFAULT_TAB_WIDTH,
	);
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

// Pre-allocated space buffer for padding
const SPACE_BUFFER = " ".repeat(512);
const TAB_SPACES = " ".repeat(DEFAULT_TAB_WIDTH);

/*
 * Replace tabs with the fixed display tab width for consistent rendering.
 */
export function replaceTabs(text: string): string {
	return text.replaceAll("\t", TAB_SPACES);
}

/**
 * Returns a string of n spaces. Uses a pre-allocated buffer for efficiency.
 */
export function padding(n: number): string {
	if (n <= 0) return "";
	if (n <= 512) return SPACE_BUFFER.slice(0, n);
	return " ".repeat(n);
}

// Grapheme segmenter (shared instance)
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * Get the shared grapheme segmenter instance.
 */
export function getSegmenter(): Intl.Segmenter {
	return segmenter;
}

// Kitty OSC 66 text-sizing spans: `\x1b]66;<meta>;<payload>` terminated by BEL
// or ST. `Bun.stringWidth` strips the whole span (payload included) to zero
// cells, but the payload is visible and scales by the `s=` factor, so each is
// added back so width matches the native truncate/slice/wrap helpers.
const OSC66_SPAN_REGEX = /\x1b\]66;([^;]*);([\s\S]*?)(?:\x07|\x1b\\)/g;
const OSC66_PREFIX = "\x1b]66;";
// APC sequences (`ESC _ ... ST|BEL`) — Kitty graphics commands such as the
// virtual-placement prefix on Unicode-placeholder image lines, or the TUI's
// BEL-terminated cursor marker. `Bun.stringWidth` strips CSI/OSC but counts APC
// payloads as printable text, so they are removed before measuring (they occupy
// zero cells — matching the native width engine in pi-natives/text.rs).
const APC_SPAN_REGEX = /\x1b_[\s\S]*?(?:\x07|\x1b\\)/g;
const APC_PREFIX = "\x1b_";
const PRINTABLE_ASCII_REGEX = /^[\u0020-\u007e]*$/;

// Pin Bun.stringWidth semantics to the native width engine and guard against Bun
// default drift: strip ANSI/OSC (don't count escape bytes) and treat
// ambiguous-width East Asian chars as narrow (1 cell), matching `unicode-width`'s
// non-CJK tables that back truncate/slice/wrap. Hoisted so no per-call alloc.
const STRING_WIDTH_OPTS = { countAnsiEscapeCodes: false, ambiguousIsNarrow: true } as const;

// Hangul Compatibility Jamo (U+3131..=U+318E). `Bun.stringWidth` follows UAX#11
// and reports these at 2 cells (the U+3164 HANGUL FILLER at 0), but the actual
// rendered width is decided by the *client* terminal (1 cell on Terminal.app /
// iTerm2, 2 on Ghostty and most Linux terminals). The width is resolved from
// the terminal identity and pushed into the native engine through
// `setHangulCompatibilityJamoWidth`; mirror the same correction here so the TS
// width stays in parity with the native truncate/slice/wrap model — and so the
// hardware cursor column lands on the actual glyph during Korean IME input.
const HANGUL_FILLER_CODE_POINT = 0x3164;
// `Bun.stringWidth` counts every code point in the Compatibility Jamo block as
// 2 cells (even the U+3164 filler that `unicode-width` treats as zero-width).
const HANGUL_COMPAT_JAMO_BUN_WIDTH = 2;

// Effective target cell width for Compatibility Jamo, or `null` to follow the
// Unicode width (no correction). Mirrors `hangul_compat_jamo_target_width` in
// crates/pi-natives/src/text.rs.
function hangulCompatibilityJamoTargetWidth(): 1 | 2 | null {
	switch (hangulCompatibilityJamoWidth) {
		case 1:
			return 1;
		case 2:
			return 2;
		case "unicode":
			return null;
		default:
			// "platform": macOS terminals historically render these narrow.
			return process.platform === "darwin" ? 1 : null;
	}
}

// Reconcile the `Bun.stringWidth` count for Compatibility Jamo to the native
// width engine: subtract Bun's per-jamo cell count and add back the effective
// width — the runtime target when one is active, otherwise the `unicode-width`
// value. Mirrors `char_width_corrected` / `apply_hangul_compat_jamo_delta` in
// crates/pi-natives/src/text.rs, including the rule that the zero-width filler
// (U+3164) is never widened past the narrow correction (a wide terminal still
// renders it at its Unicode width of 0).
function correctHangulCompatibilityJamoWidth(
	width: number,
	compatibilityJamoCount: number,
	fillerCount: number,
): number {
	if (compatibilityJamoCount === 0) return width;
	const target = hangulCompatibilityJamoTargetWidth();
	return target === 1 ? width - compatibilityJamoCount : width - fillerCount * HANGUL_COMPAT_JAMO_BUN_WIDTH;
}

// Terminal redraws re-measure the same visible lines every frame, usually as
// the same string objects (JSC caches their hashes, so repeat lookups are
// O(1) — cheaper than even the ASCII fast scan). Strings longer than the
// length gate skip the cache entirely: hashing them costs as much as measuring
// them, and retaining them would pin large render buffers. Worst-case
// retention is MAX * MAX_LEN UTF-16 units (~2 MiB); cleared when the width
// configuration epoch changes.
const VISIBLE_WIDTH_CACHE_MAX = 2048;
const VISIBLE_WIDTH_CACHE_MAX_LEN = 512;
const visibleWidthCache = new Map<string, number>();
let visibleWidthCacheEpoch = widthConfigEpoch;

/**
 * Visible width of a string in terminal columns, excluding ANSI/OSC escapes.
 *
 * `Bun.stringWidth` does the heavy lifting (UAX#11 width tables + ANSI/OSC
 * stripping); this adds the corrections it omits — tabs (expanded to
 * `tabWidth` cells), OSC 66 text-sizing payloads (scaled by `s=`), and APC
 * sequences (counted as printable by Bun, actually zero cells).
 */
export function visibleWidth(str: string): number {
	if (!str) return 0;
	const cacheable = str.length <= VISIBLE_WIDTH_CACHE_MAX_LEN;
	if (cacheable) {
		if (visibleWidthCacheEpoch !== widthConfigEpoch) {
			visibleWidthCache.clear();
			visibleWidthCacheEpoch = widthConfigEpoch;
		}
		const cached = visibleWidthCache.get(str);
		if (cached !== undefined) return cached;
	}

	// This regex compiles to a native ASCII scan, cheaper than Bun's width
	// scanner for the overwhelmingly common source-code path.
	if (PRINTABLE_ASCII_REGEX.test(str)) {
		if (cacheable) {
			if (visibleWidthCache.size >= VISIBLE_WIDTH_CACHE_MAX) visibleWidthCache.clear();
			visibleWidthCache.set(str, str.length);
		}
		return str.length;
	}

	let tabCount = 0;
	let compatibilityJamoCount = 0;
	let fillerCount = 0;
	let hasEsc = false;
	for (let i = 0; i < str.length; i++) {
		const code = str.charCodeAt(i);
		if (code === 0x09) {
			tabCount++;
		} else if (code === 0x1b) {
			hasEsc = true;
		} else if (code >= 0x3131 && code <= 0x318e) {
			compatibilityJamoCount++;
			if (code === HANGUL_FILLER_CODE_POINT) fillerCount++;
		}
	}

	const measurable = hasEsc && str.includes(APC_PREFIX) ? str.replace(APC_SPAN_REGEX, "") : str;
	let width = Bun.stringWidth(measurable, STRING_WIDTH_OPTS);
	if (tabCount > 0) width += tabCount * DEFAULT_TAB_WIDTH;

	if (hasEsc && str.includes(OSC66_PREFIX)) {
		OSC66_SPAN_REGEX.lastIndex = 0;
		for (let m = OSC66_SPAN_REGEX.exec(str); m !== null; m = OSC66_SPAN_REGEX.exec(str)) {
			let scale = 1;
			let explicit: number | undefined;
			for (const part of m[1].split(":")) {
				if (part.indexOf("=") !== 1) continue;
				const value = Number.parseInt(part.slice(2), 10);
				if (!Number.isFinite(value)) continue;
				if (part[0] === "s") {
					if (value >= 1 && value <= 7) scale = value;
				} else if (part[0] === "w" && value > 0) {
					explicit = value;
				}
			}
			width += scale * (explicit ?? Bun.stringWidth(m[2], STRING_WIDTH_OPTS));
		}
	}

	width = correctHangulCompatibilityJamoWidth(width, compatibilityJamoCount, fillerCount);
	if (cacheable) {
		if (visibleWidthCache.size >= VISIBLE_WIDTH_CACHE_MAX) visibleWidthCache.clear();
		visibleWidthCache.set(str, width);
	}
	return width;
}

/**
 * Scaled spans must bypass wrapping/padding and, when scaled up, reserve the
 * terminal rows their multicell glyphs flow into.
 */
export function isOsc66Line(line: string): boolean {
	return line.includes(OSC66_PREFIX);
}

/**
 * Largest `s=` scale among the OSC 66 spans in a line (1 when none is scaled).
 * A scale-`s` heading occupies `s` terminal rows, so the `s - 1` blank rows
 * beneath it are the glyph's lower half and must never be erased or overdrawn.
 */
export function osc66MaxScale(line: string): number {
	if (!line.includes(OSC66_PREFIX)) return 1;
	let max = 1;
	OSC66_SPAN_REGEX.lastIndex = 0;
	for (let m = OSC66_SPAN_REGEX.exec(line); m !== null; m = OSC66_SPAN_REGEX.exec(line)) {
		for (const part of m[1].split(":")) {
			if (part.indexOf("=") !== 1 || part[0] !== "s") continue;
			const value = Number.parseInt(part.slice(2), 10);
			if (Number.isFinite(value) && value > max && value <= 7) max = value;
		}
	}
	return max;
}

const THAI_LAO_AM_GLOBAL_REGEX = /[\u0e33\u0eb3]/g;

/**
 * Normalize text for terminal output without changing logical editor content.
 * Some terminals render precomposed Thai/Lao AM vowels inconsistently during
 * differential repaint. Their compatibility decompositions have the same cell
 * width but avoid stale-cell artifacts in terminal renderers.
 */
export function normalizeTerminalOutput(str: string): string {
	if (str.indexOf("\u0e33") === -1 && str.indexOf("\u0eb3") === -1) return str;
	return str.replace(THAI_LAO_AM_GLOBAL_REGEX, char => (char === "\u0e33" ? "\u0e4d\u0e32" : "\u0ecd\u0eb2"));
}

const makeBoolArray = (chars: string): Uint8Array => {
	const table = new Uint8Array(128);
	for (let i = 0; i < chars.length; i++) {
		const code = chars.charCodeAt(i);
		if (code < table.length) {
			table[code] = 1;
		}
	}
	return table;
};

const ASCII_WHITESPACE = makeBoolArray("\x09\x0a\x0b\x0c\x0d\x20");

/**
 * Check if a character is whitespace.
 */
export function isWhitespaceChar(char: string): boolean {
	const code = char.codePointAt(0) ?? 0;
	return code < 128 && ASCII_WHITESPACE[code] === 1;
}

const ASCII_PUNCTUATION = makeBoolArray("(){}[]<>.,;:'\"!?+-=*/\\|&%^$#@~`");

/**
 * Check if a character is punctuation.
 */
export function isPunctuationChar(char: string): boolean {
	const code = char.codePointAt(0) ?? 0;
	return code < 128 && ASCII_PUNCTUATION[code] === 1;
}

export type WordNavKind = "whitespace" | "delimiter" | "cjk" | "word" | "other";

const WORD_NAV_RE_WHITESPACE = /^\p{White_Space}$/u;
const WORD_NAV_RE_PUNCT = /^\p{P}$/u;
const WORD_NAV_RE_SYMBOL = /^\p{S}$/u;
const WORD_NAV_RE_LETTER = /^\p{L}$/u;
const WORD_NAV_RE_NUMBER = /^\p{N}$/u;
const WORD_NAV_RE_HAN = /^\p{Script=Han}$/u;
const WORD_NAV_RE_HIRAGANA = /^\p{Script=Hiragana}$/u;
const WORD_NAV_RE_KATAKANA = /^\p{Script=Katakana}$/u;
const WORD_NAV_RE_HANGUL = /^\p{Script=Hangul}$/u;

function firstCodePointChar(str: string): string {
	const cp = str.codePointAt(0);
	if (cp === undefined) return "";
	return String.fromCodePoint(cp);
}

/**
 * Coarse Unicode-aware character classification for word navigation (Option/Alt + Left/Right).
 * This intentionally avoids language-specific word segmentation for predictability across scripts.
 */
export function getWordNavKind(grapheme: string): WordNavKind {
	if (!grapheme) return "other";
	const ch = firstCodePointChar(grapheme);
	if (!ch) return "other";
	if (WORD_NAV_RE_WHITESPACE.test(ch)) return "whitespace";
	if (ch === "_") return "word";
	if (WORD_NAV_RE_PUNCT.test(ch) || WORD_NAV_RE_SYMBOL.test(ch)) return "delimiter";
	if (
		WORD_NAV_RE_HAN.test(ch) ||
		WORD_NAV_RE_HIRAGANA.test(ch) ||
		WORD_NAV_RE_KATAKANA.test(ch) ||
		WORD_NAV_RE_HANGUL.test(ch)
	) {
		return "cjk";
	}
	if (WORD_NAV_RE_LETTER.test(ch) || WORD_NAV_RE_NUMBER.test(ch)) return "word";
	return "other";
}

const WORD_NAV_JOINERS = new Set(["'", "’", "-", "‐", "‑"]);

export function isWordNavJoiner(grapheme: string): boolean {
	const ch = firstCodePointChar(grapheme);
	return WORD_NAV_JOINERS.has(ch);
}

/**
 * Move the cursor one "word" to the left using Unicode-aware coarse navigation.
 *
 * Returns a new cursor index in the range [0, text.length].
 */
export function moveWordLeft(text: string, cursor: number): number {
	const len = text.length;
	if (len === 0) return 0;
	let i = Math.min(Math.max(cursor, 0), len);
	if (i === 0) return 0;

	const graphemes = [...segmenter.segment(text.slice(0, i))];
	if (graphemes.length === 0) return 0;

	// Skip trailing whitespace.
	while (graphemes.length > 0 && getWordNavKind(graphemes[graphemes.length - 1]?.segment || "") === "whitespace") {
		i -= graphemes.pop()?.segment.length || 0;
	}
	if (i === 0 || graphemes.length === 0) return i;

	const kind = getWordNavKind(graphemes[graphemes.length - 1]?.segment || "");
	if (kind === "delimiter" || kind === "cjk") {
		while (graphemes.length > 0 && getWordNavKind(graphemes[graphemes.length - 1]?.segment || "") === kind) {
			i -= graphemes.pop()?.segment.length || 0;
		}
		return i;
	}

	if (kind === "word") {
		// Skip word run (letters/numbers/underscore), keeping common joiners inside words.
		let hasRightWord = false;
		while (graphemes.length > 0) {
			const g = graphemes[graphemes.length - 1]?.segment || "";
			const k = getWordNavKind(g);
			if (k === "word") {
				hasRightWord = true;
				i -= graphemes.pop()?.segment.length || 0;
				continue;
			}
			if (hasRightWord && k === "delimiter" && isWordNavJoiner(g)) {
				const left = graphemes[graphemes.length - 2]?.segment || "";
				if (getWordNavKind(left) === "word") {
					i -= graphemes.pop()?.segment.length || 0;
					continue;
				}
			}
			break;
		}
		return i;
	}

	// Fallback: move by one grapheme.
	i -= graphemes.pop()?.segment.length || 0;
	return Math.max(0, i);
}

/**
 * Move the cursor one "word" to the right using Unicode-aware coarse navigation.
 *
 * Returns a new cursor index in the range [0, text.length].
 */
export function moveWordRight(text: string, cursor: number): number {
	const len = text.length;
	if (len === 0) return 0;
	let i = Math.min(Math.max(cursor, 0), len);
	if (i === len) return len;

	const iterator = segmenter.segment(text.slice(i))[Symbol.iterator]();
	let next = iterator.next();

	// Skip leading whitespace.
	while (!next.done && getWordNavKind(next.value.segment) === "whitespace") {
		i += next.value.segment.length;
		next = iterator.next();
	}
	if (next.done) return i;

	const firstKind = getWordNavKind(next.value.segment);
	if (firstKind === "delimiter" || firstKind === "cjk") {
		while (!next.done && getWordNavKind(next.value.segment) === firstKind) {
			i += next.value.segment.length;
			next = iterator.next();
		}
		return i;
	}

	if (firstKind === "word") {
		let hasLeftWord = false;
		while (!next.done) {
			const segment = next.value.segment;
			const k = getWordNavKind(segment);
			if (k === "word") {
				hasLeftWord = true;
				i += segment.length;
				next = iterator.next();
				continue;
			}
			if (hasLeftWord && k === "delimiter" && isWordNavJoiner(segment)) {
				const lookahead = iterator.next();
				if (!lookahead.done && getWordNavKind(lookahead.value.segment) === "word") {
					i += segment.length;
					next = lookahead;
					continue;
				}
			}
			break;
		}
		return i;
	}

	// Fallback: move by one grapheme.
	return i + next.value.segment.length;
}

/**
 * Apply background color to a line, padding to full width.
 *
 * @param line - Line of text (may contain ANSI codes)
 * @param width - Total width to pad to
 * @param bgFn - Background color function
 * @returns Line with background applied and padded to width
 */
export function applyBackgroundToLine(line: string, width: number, bgFn: (text: string) => string): string {
	// Calculate padding needed
	const visibleLen = visibleWidth(line);
	const paddingNeeded = Math.max(0, width - visibleLen);

	// Apply background to content + padding
	const withPadding = line + padding(paddingNeeded);
	return bgFn(withPadding);
}

/**
 * Extract a range of visible columns from a line. Handles ANSI codes and wide chars.
 *
 * @param strict - If true, exclude wide chars at boundary that would extend past the range
 */
export function sliceByColumn(line: string, startCol: number, length: number, strict = false): string {
	return sliceWithWidth(line, startCol, length, strict).text;
}

let globalTight = false;

export function setTuiTight(tight: boolean): void {
	globalTight = tight;
}

export function isTuiTight(): boolean {
	return globalTight;
}

export function getPaddingX(basePadding: number): number {
	return globalTight ? Math.max(0, basePadding - 1) : basePadding;
}
