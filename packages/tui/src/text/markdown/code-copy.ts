/**
 * Clickable copy buttons for fenced Markdown code blocks.
 *
 * When `codeCopy` is enabled on Markdown rendering, each fenced code block's
 * opening fence row includes a right-aligned `[Copy]` button (or `[Copied]`
 * after a click) wrapped in an OSC 8 marker under the reserved id
 * {@link CODE_COPY_ID} carrying the block's normalized content hash. Painters
 * strip the marker with {@link takeCodeCopyMarkers} and turn its cell range
 * into a mouse hit with `act = CODE_COPY_ACT_PREFIX + hash`, so left-clicking
 * bubbles an `action` event without leaking any OSC 8 escape to the terminal.
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

/** Deterministic content hash of a code block's normalized (trailing-space-free) code. */
export function codeBlockHash(code: string): string {
	return Bun.hash(stripTrailingSpaces(code)).toString(36);
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

/** A fenced code block extracted from Markdown source. */
export interface FencedCodeBlock {
	/** Info string after the opening fence (language id), trimmed. */
	readonly lang: string;
	/** Code body with trailing horizontal whitespace stripped from every line. */
	readonly code: string;
	/** Deterministic hash matching {@link codeBlockHash}. */
	readonly hash: string;
}

export interface ExtractFencedCodeBlocksOptions {
	/** Also descend into blockquotes (default false, matching transcript copy targets). */
	readonly includeQuotes?: boolean;
}

/**
 * Fenced code blocks in `source` in document order (handles nested backtick
 * and tilde fences via the Markdown lexer, plus fences inside list items and
 * optionally blockquotes), with trailing spaces stripped from every line.
 */
export function extractFencedCodeBlocks(
	source: string,
	options: ExtractFencedCodeBlocksOptions = {},
): FencedCodeBlock[] {
	const blocks: FencedCodeBlock[] = [];
	const walk = (tokens: readonly Token[] | undefined): void => {
		for (const token of tokens ?? []) {
			if (token.type === "code") {
				const codeToken = token as Tokens.Code;
				if (codeToken.codeBlockStyle !== "indented") {
					const code = stripTrailingSpaces(codeToken.text);
					blocks.push({
						lang: (codeToken.lang ?? "").trim(),
						code,
						hash: codeBlockHash(code),
					});
				}
			} else if (token.type === "list") {
				walk((token as Tokens.List).items);
			} else if (token.type === "list_item") {
				walk((token as Tokens.ListItem).tokens);
			} else if (options.includeQuotes && token.type === "blockquote") {
				walk((token as Tokens.Blockquote).tokens);
			}
		}
	};
	walk(lexMarkdown(source));
	return blocks;
}
