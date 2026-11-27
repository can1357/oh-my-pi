/**
 * Syntax highlighting as theme-token spans. The native highlighter colors
 * code with sentinel SGRs, one per token class; they are read back into
 * spans whose style is the theme key (`syntaxKeyword`, …), so the same
 * result serves TSP spans and terminal rows under any theme.
 */
import {
	type HighlightColors,
	HighlightStream,
	highlightCode as nativeHighlight,
	supportsLanguage as nativeSupports,
} from "@oh-my-pi/pi-natives";
import { LRUCache } from "@oh-my-pi/pi-utils/lru";
import type { TspSpan } from "@oh-my-pi/pi-wire";
import type { Theme } from "../theme/contract";
import { sgrParams, tokens } from "./ansi";

/** Theme keys of the token classes, in sentinel order (`38;5;<index + 1>`). */
const TOKEN_KEYS = [
	"syntaxComment",
	"syntaxKeyword",
	"syntaxFunction",
	"syntaxVariable",
	"syntaxString",
	"syntaxNumber",
	"syntaxType",
	"syntaxOperator",
	"syntaxPunctuation",
	"toolDiffAdded",
	"toolDiffRemoved",
] as const;

const sentinel = (index: number): string => `\x1b[38;5;${index + 1}m`;

const SENTINELS: HighlightColors = {
	comment: sentinel(0),
	keyword: sentinel(1),
	function: sentinel(2),
	variable: sentinel(3),
	string: sentinel(4),
	number: sentinel(5),
	type: sentinel(6),
	operator: sentinel(7),
	punctuation: sentinel(8),
	inserted: sentinel(9),
	deleted: sentinel(10),
};

/** One row of highlighted code. */
export type HighlightedLine = TspSpan[];

/** Whether `lang` (a name or alias: `ts`, `python`, `diff`) has a grammar. */
export function supportsLanguage(lang: string): boolean {
	return nativeSupports(lang);
}

/** Read sentinel-colored text back into spans, one list per line (open token state carries across). */
class SpanReader {
	#token: string | undefined;
	#lines: HighlightedLine[] = [[]];

	read(colored: string): void {
		for (const token of tokens(colored)) {
			if (token.escape) {
				const params = sgrParams(token.text);
				if (params === undefined) continue;
				const match = /^38;5;(\d+)$/.exec(params);
				this.#token = match === null ? undefined : TOKEN_KEYS[Number(match[1]) - 1];
				continue;
			}
			const parts = token.text.split("\n");
			for (let i = 0; i < parts.length; i++) {
				if (i > 0) this.#lines.push([]);
				const text = parts[i]!;
				if (text === "") continue;
				const line = this.#lines[this.#lines.length - 1]!;
				const last = line[line.length - 1];
				if (last !== undefined && last.s === this.#token) last.t += text;
				else line.push(this.#token === undefined ? { t: text } : { t: text, s: this.#token });
			}
		}
	}

	/** The complete lines read so far (all but the open last one), removed from the reader. */
	takeComplete(): HighlightedLine[] {
		return this.#lines.splice(0, this.#lines.length - 1);
	}

	takeAll(): HighlightedLine[] {
		const lines = this.#lines;
		this.#lines = [[]];
		return lines;
	}
}

/**
 * `code` as spans per line, styled with theme syntax keys. Unknown languages
 * (and no language) give unstyled lines.
 */
export function highlightSpans(code: string, lang: string | undefined): HighlightedLine[] {
	if (lang === undefined || lang === "" || !nativeSupports(lang)) {
		return code.split("\n").map(line => (line === "" ? [] : [{ t: line }]));
	}
	const reader = new SpanReader();
	reader.read(nativeHighlight(code, lang, SENTINELS));
	return reader.takeAll();
}

/** Spans as a styled terminal string. */
export function renderSpans(spans: readonly TspSpan[], theme: Theme): string {
	let out = "";
	for (const span of spans) out += span.s === undefined ? span.t : theme.style(span.s, span.t);
	return out;
}

/**
 * Highlighted rows by theme, keyed by `lang\0code`: the native highlighter is
 * the most expensive step of drawing a document, and the same code is drawn
 * again and again (every repaint of a streaming answer, every width). Bounded
 * by entry count and by total size (UTF-16 units of key and rows).
 */
const kHighlighted = Symbol("pi-tui.text.highlighted");
const HIGHLIGHT_CACHE_ENTRIES = 256;
const HIGHLIGHT_CACHE_SIZE = 8 * 1024 * 1024;

interface HighlightingTheme extends Theme {
	[kHighlighted]?: LRUCache<string, readonly string[]>;
}

function highlightCache(theme: HighlightingTheme): LRUCache<string, readonly string[]> {
	let cache = theme[kHighlighted];
	if (!cache) {
		cache = new LRUCache({
			max: HIGHLIGHT_CACHE_ENTRIES,
			maxSize: HIGHLIGHT_CACHE_SIZE,
			sizeCalculation: (rows, key) => {
				let size = key.length + 1;
				for (const row of rows) size += row.length;
				return size;
			},
		});
		theme[kHighlighted] = cache;
	}
	return cache;
}

/** `code` highlighted for a terminal: one styled string per line (plain lines for unknown languages). */
export function highlightCode(code: string, lang: string | undefined, theme: Theme): string[] {
	if (lang === undefined || lang === "" || !nativeSupports(lang)) return code.split("\n");
	const cache = highlightCache(theme);
	const key = `${lang}\0${code}`;
	let rows = cache.get(key);
	if (!rows) {
		rows = highlightSpans(code, lang).map(line => renderSpans(line, theme));
		cache.set(key, rows);
	}
	// A fresh array: callers append to it.
	return [...rows];
}

/**
 * Incremental highlighting of code that arrives in chunks (a file being
 * written): each `push` takes newline-terminated lines (only the last push
 * may end mid-line) and returns the lines it completed; `finish` returns the
 * rest. The result equals highlighting the whole text at once.
 */
export class Highlighter {
	readonly #stream: HighlightStream;
	readonly #reader = new SpanReader();

	constructor(lang: string | undefined) {
		this.#stream = new HighlightStream(lang ?? null, SENTINELS);
	}

	/** Whether the language resolved to a grammar (otherwise lines come back unstyled). */
	get supported(): boolean {
		return this.#stream.supported;
	}

	push(chunk: string): HighlightedLine[] {
		this.#reader.read(this.#stream.push(chunk));
		return this.#reader.takeComplete();
	}

	finish(): HighlightedLine[] {
		return this.#reader.takeAll();
	}
}
