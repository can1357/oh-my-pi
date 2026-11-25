const QUEUE_PREFIXES: readonly string[] = ["->", "=>"];

/** A list item's indent, marker and punctuation (`  2.`, `b)`). */
const QUEUE_LIST_MARKER_RE = /^([\t ]*)(\d+|[A-Za-z]+)([.)])(?=[\t ]|$)/;

const CANONICAL_ROMAN_RE = /^(?=[MDCLXVI])M{0,3}(?:CM|CD|D?C{0,3})(?:XC|XL|L?X{0,3})(?:IX|IV|V?I{0,3})$/i;

interface EnumeratedItem {
	line: number;
	/** UTF-16 offset of the item's line in the list source. */
	offset: number;
	indent: string;
	marker: string;
	punctuation: string;
	content: string;
}

interface EnumeratedList {
	source: string;
	lines: string[];
	items: EnumeratedItem[];
}

/** A `[from, to)` UTF-16 range of a draft. */
export interface QueueRange {
	readonly from: number;
	readonly to: number;
}

/** Where a draft's yield-queue shorthand stands (see {@link queueShorthandMarks}). */
export interface QueueShorthandMarks {
	/** The `->` / `=>` prefix. */
	readonly prefix: QueueRange;
	/** Each item's marker (`1.`, `b)`) when the body is a sequential list; empty otherwise. */
	readonly markers: readonly QueueRange[];
}

/** Extract the message body from the `->` / `=>` yield-queue shorthand. */
export function parseQueueShorthand(text: string): string | undefined {
	const prefix = QUEUE_PREFIXES.find(candidate => text.startsWith(candidate));
	return prefix ? text.slice(prefix.length).trim() : undefined;
}

/** Whether `text` is a bare `->` / `=>` prefix, its body not begun. */
export function isBareQueuePrefix(text: string): boolean {
	return QUEUE_PREFIXES.includes(text);
}

/**
 * The prefix and list-item markers of `text`'s queue shorthand, the items {@link splitQueuedMessages}
 * would split it into; undefined when `text` is no queue shorthand. The composer highlights them.
 */
export function queueShorthandMarks(text: string): QueueShorthandMarks | undefined {
	const prefix = QUEUE_PREFIXES.find(candidate => text.startsWith(candidate));
	if (!prefix) return undefined;
	const body = text.slice(prefix.length);
	// The list source is the trimmed body.
	const start = prefix.length + body.length - body.trimStart().length;
	const markers = (parseEnumeratedList(body)?.items ?? []).map(item => {
		const from = start + item.offset + item.indent.length;
		return { from, to: from + item.marker.length + item.punctuation.length };
	});
	return { prefix: { from: 0, to: prefix.length }, markers };
}

/** Render messages as `->` / `=>` shorthand that {@link parseQueueShorthand} and {@link splitQueuedMessages} read back as the same messages. */
export function formatQueueShorthand(messages: readonly string[]): string {
	if (messages.length === 1) return `=> ${messages[0]}`;
	return `=>\n${messages.map((message, index) => `${index + 1}. ${message.replaceAll("\n", "\n   ")}`).join("\n")}`;
}

function parseEnumeratedItem(line: string, lineIndex: number, offset: number): EnumeratedItem | undefined {
	const match = QUEUE_LIST_MARKER_RE.exec(line);
	if (!match) return undefined;
	const [matched, indent, marker, punctuation] = match;
	if (indent === undefined || marker === undefined || punctuation === undefined) return undefined;
	return { line: lineIndex, offset, indent, marker, punctuation, content: line.slice(matched.length).trimStart() };
}

function decodeDecimal(marker: string): number | undefined {
	if (!/^\d+$/.test(marker)) return undefined;
	const value = Number(marker);
	return Number.isSafeInteger(value) ? value : undefined;
}

function decodeRoman(marker: string): number | undefined {
	if (!CANONICAL_ROMAN_RE.test(marker)) return undefined;
	const values: Readonly<Record<string, number>> = {
		I: 1,
		V: 5,
		X: 10,
		L: 50,
		C: 100,
		D: 500,
		M: 1000,
	};
	const upper = marker.toUpperCase();
	let value = 0;
	for (let index = 0; index < upper.length; index++) {
		const current = values[upper[index] ?? ""];
		if (current === undefined) return undefined;
		const next = values[upper[index + 1] ?? ""] ?? 0;
		value += current < next ? -current : current;
	}
	return value;
}

function decodeAlpha(marker: string): number | undefined {
	if (!/^[A-Za-z]+$/.test(marker)) return undefined;
	let value = 0;
	for (const char of marker.toUpperCase()) {
		value = value * 26 + char.charCodeAt(0) - 64;
		if (!Number.isSafeInteger(value)) return undefined;
	}
	return value;
}

function isSequential(markers: readonly string[], decode: (marker: string) => number | undefined): boolean {
	let previous = decode(markers[0] ?? "");
	if (previous === undefined) return false;
	for (let index = 1; index < markers.length; index++) {
		const current = decode(markers[index] ?? "");
		if (current === undefined || current !== previous + 1) return false;
		previous = current;
	}
	return true;
}

function isEnumeratedSequence(items: readonly EnumeratedItem[]): boolean {
	const markers = items.map(item => item.marker);
	if (markers.every(marker => /^\d+$/.test(marker))) return isSequential(markers, decodeDecimal);
	if (
		!markers.every(marker => marker === marker.toUpperCase()) &&
		!markers.every(marker => marker === marker.toLowerCase())
	) {
		return false;
	}
	return isSequential(markers, decodeRoman) || isSequential(markers, decodeAlpha);
}

function parseEnumeratedList(text: string): EnumeratedList | undefined {
	const source = text.trim();
	if (!source) return undefined;
	const lines = source.split(/\r?\n/);
	const first = parseEnumeratedItem(lines[0] ?? "", 0, 0);
	if (!first) return undefined;

	const items = [first];
	let offset = 0;
	for (let lineIndex = 1; lineIndex < lines.length; lineIndex++) {
		// Past the previous line and its `\n` or `\r\n` break.
		offset += (lines[lineIndex - 1] ?? "").length;
		offset += source[offset] === "\r" ? 2 : 1;
		const item = parseEnumeratedItem(lines[lineIndex] ?? "", lineIndex, offset);
		if (item?.indent === first.indent) items.push(item);
	}
	if (items.length < 2 || items.some(item => item.punctuation !== first.punctuation) || !isEnumeratedSequence(items)) {
		return undefined;
	}
	return { source, lines, items };
}

/** Whether text currently forms a sequential queue list, including an unfinished trailing item. */
export function isQueuedMessageList(text: string): boolean {
	return parseEnumeratedList(text) !== undefined;
}

/** Split a sequential numeric, Roman-numeral, or alphabetic list into queue entries. */
export function splitQueuedMessages(text: string): string[] {
	const list = parseEnumeratedList(text);
	if (!list) {
		const source = text.trim();
		return source ? [source] : [];
	}

	const messages = list.items.map((item, index) => {
		const nextLine = list.items[index + 1]?.line ?? list.lines.length;
		return [item.content, ...list.lines.slice(item.line + 1, nextLine)].join("\n").trim();
	});
	while (messages.at(-1) === "") messages.pop();
	return messages.length > 0 && messages.every(Boolean) ? messages : [list.source];
}
