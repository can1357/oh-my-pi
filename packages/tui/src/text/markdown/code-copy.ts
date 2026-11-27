/**
 * Clickable copy buttons for fenced Markdown code blocks.
 *
 * When `codeCopy` is enabled on Markdown rendering, each fenced code block's
 * opening fence row includes a right-aligned `[Copy]` button wrapped in an
 * OSC 8 marker under the reserved id {@link CODE_COPY_ID} carrying the block's
 * normalized content hash. Painters strip the marker with
 * {@link takeCodeCopyMarkers}, turn its cell range into a mouse hit with
 * `act = CODE_COPY_ACT_PREFIX + hash`, and swap the label to `[Copied]` via
 * {@link replaceCodeCopyLabel} when that hash is active — keeping both the
 * markdown block cache and completed frame cache free of click state.
 */
import { tokens as ansiTokens } from "../ansi";
import { visibleWidth } from "../width";
import { lexMarkdown, type Token, type Tokens } from "./lexer";

/** OSC 8 `id` of fenced code-block copy button markers. */
export const CODE_COPY_ID = "pi-code-copy";

/** Action prefix emitted by mouse hits on code-block copy buttons. */
export const CODE_COPY_ACT_PREFIX = "code-copy:";

const MARKER_OPEN = `\x1b]8;id=${CODE_COPY_ID};`;
const OSC8 = "\x1b]8;";
const CONTROL = /[\x00-\x1f\x7f-\x9f]/g;

/** Strip trailing horizontal whitespace (spaces and tabs) from every line. */
export function stripTrailingSpaces(text: string): string {
	return text.replace(/[ \t]+(?=\r?$)/gm, "");
}

/**
 * Deterministic content hash of a code block's normalized code.
 * Tabs are expanded to three spaces to match the Markdown renderer's
 * `normalizeSource` before hashing, and trailing horizontal whitespace is
 * stripped per line.
 */
export function codeBlockHash(code: string): string {
	const tabbed = code.includes("\t") ? code.replaceAll("\t", "   ") : code;
	return Bun.hash(stripTrailingSpaces(tabbed)).toString(36);
}

/** `label` (already styled) inside the code-copy marker for `hash`. */
export function codeCopyMarker(hash: string, label: string): string {
	return `${MARKER_OPEN}${hash.replace(CONTROL, "")}\x07${label}\x1b]8;;\x07`;
}

/** A code-block copy button's cells on one row. */
export interface CodeCopySpan {
	readonly hash: string;
	/** First cell of the button on the row. */
	readonly start: number;
	/** Cell just past it. */
	readonly end: number;
}

/** `row` without its code-copy markers (other OSC 8 sequences stay), and the button spans they marked. */
export function takeCodeCopyMarkers(row: string): { readonly row: string; readonly buttons: CodeCopySpan[] } {
	if (!row.includes(MARKER_OPEN)) return { row, buttons: [] };
	const buttons: CodeCopySpan[] = [];
	let out = "";
	let col = 0;
	let open: { hash: string; start: number } | undefined;
	for (const token of ansiTokens(row)) {
		if (token.escape && token.text.startsWith(OSC8)) {
			if (token.text.startsWith(MARKER_OPEN)) {
				const body = token.text.slice(MARKER_OPEN.length, token.text.endsWith("\x07") ? -1 : -2);
				open = { hash: body, start: col };
				continue;
			}
			if (open && /^\x1b\]8;[^;]*;(?:\x07|\x1b\\)$/.test(token.text)) {
				if (col > open.start) buttons.push({ ...open, end: col });
				open = undefined;
				continue;
			}
		}
		out += token.text;
		col += visibleWidth(token.text);
	}
	if (open && col > open.start) buttons.push({ ...open, end: col });
	return { row: out, buttons };
}

/**
 * Swap the button label at cell range `[start, end)` on `row` with
 * `copiedLabel` (e.g. styled `[Copied]`), borrowing any extra width from plain
 * spaces immediately before `start` so the row width stays unchanged.
 */
export function replaceCodeCopyLabel(
	row: string,
	start: number,
	end: number,
	copiedLabel: string,
): { readonly row: string; readonly start: number; readonly end: number } {
	const oldWidth = end - start;
	const newWidth = visibleWidth(copiedLabel);
	const extra = Math.max(0, newWidth - oldWidth);
	if (start < extra) return { row, start, end };
	const replaceStart = start - extra;
	let col = 0;
	let before = "";
	let after = "";
	let leadingSpaces = 0;
	for (const token of ansiTokens(row)) {
		if (token.escape) {
			if (col <= replaceStart) before += token.text;
			else if (col >= end) after += token.text;
			continue;
		}
		for (const ch of token.text) {
			const w = visibleWidth(ch);
			const next = col + w;
			if (next <= replaceStart) {
				before += ch;
			} else if (col >= end) {
				after += ch;
			} else if (col >= replaceStart && next <= start && ch === " ") {
				leadingSpaces += w;
			}
			col = next;
		}
	}
	if (leadingSpaces < extra) return { row, start, end };
	return { row: `${before}${copiedLabel}${after}`, start: replaceStart, end: replaceStart + newWidth };
}

/** A fenced code block extracted from Markdown source. */
export interface FencedCodeBlock {
	/** Info string after the opening fence (language id), trimmed. */
	readonly lang: string;
	/** Code body with trailing horizontal whitespace stripped from every line. */
	readonly code: string;
	/** Deterministic hash matching {@link codeBlockHash} on the renderer's tab-normalized source. */
	readonly hash: string;
}

export interface ExtractFencedCodeBlocksOptions {
	/** Also descend into blockquotes (default false, matching transcript copy targets). */
	readonly includeQuotes?: boolean;
}

function collectFencedCodeTokens(source: string, includeQuotes: boolean): Tokens.Code[] {
	const out: Tokens.Code[] = [];
	const walk = (tokens: readonly Token[] | undefined): void => {
		for (const token of tokens ?? []) {
			if (token.type === "code") {
				const codeToken = token as Tokens.Code;
				if (codeToken.codeBlockStyle !== "indented") out.push(codeToken);
			} else if (token.type === "list") {
				walk((token as Tokens.List).items);
			} else if (token.type === "list_item") {
				walk((token as Tokens.ListItem).tokens);
			} else if (includeQuotes && token.type === "blockquote") {
				walk((token as Tokens.Blockquote).tokens);
			}
		}
	};
	walk(lexMarkdown(source));
	return out;
}

/**
 * Fenced code blocks in `source` in document order (handles nested backtick
 * and tilde fences via the Markdown lexer, plus fences inside list items and
 * optionally blockquotes), with trailing spaces stripped from every line.
 *
 * Hashes are derived from the same 3-space tab-normalized source that the
 * Markdown renderer feeds to the lexer, so blocks containing non-trailing tabs
 * still match their rendered `[Copy]` button hash.
 */
export function extractFencedCodeBlocks(
	source: string,
	options: ExtractFencedCodeBlocksOptions = {},
): FencedCodeBlock[] {
	const includeQuotes = options.includeQuotes === true;
	const rawTokens = collectFencedCodeTokens(source, includeQuotes);
	const hashTokens = source.includes("\t")
		? collectFencedCodeTokens(source.replaceAll("\t", "   "), includeQuotes)
		: rawTokens;
	return rawTokens.map((codeToken, index) => {
		const code = stripTrailingSpaces(codeToken.text);
		const hashSource = hashTokens[index]?.text ?? codeToken.text;
		return {
			lang: (codeToken.lang ?? "").trim(),
			code,
			hash: codeBlockHash(hashSource),
		};
	});
}
