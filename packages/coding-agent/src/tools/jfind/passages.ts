/**
 * Byte-bounded source passages. A file is cut into contiguous whole-line
 * windows tagged with their original line numbers; the lexically strongest
 * windows are selected, sketched for routing, and finally judged verbatim.
 * Every reported range maps back to real line coordinates.
 */
import type { FindRange } from "@oh-my-pi/pi-tui/tools/find";
import { clipBytes, countOccurrences, lines } from "./text";

/** A contiguous run of tagged source lines (`L<n>| text`), 1-based inclusive. */
export interface Passage {
	start: number;
	end: number;
	text: string;
	/** Lexical score used for window selection and tie-breaking. */
	score: number;
}

/** A judged line range with its yes-probability and a one-line preview; the shape the renderer consumes. */
export type HeatRange = FindRange;

/**
 * Contiguous whole-line windows bounded by bytes, including the final line. A
 * single oversized line is clipped at a code-point boundary and keeps its real
 * line id.
 */
export function windows(
	text: string,
	bytes: number,
	keywords: readonly string[],
	weights: readonly number[],
): Passage[] {
	const source = lines(text);
	const passages: Passage[] = [];
	let start = 0;
	while (start < source.length) {
		let end = start;
		let content = "";
		let used = 0;
		while (end < source.length) {
			const line = source[end]!;
			const prefix = `L${end + 1}| `;
			const overhead = prefix.length + 1;
			if (end > start && used + Buffer.byteLength(line) + overhead > bytes) break;
			const piece = `${prefix}${clipBytes(line, Math.max(0, bytes - (used + overhead)))}\n`;
			content += piece;
			used += Buffer.byteLength(piece);
			end++;
			if (used >= bytes) break;
		}
		const lower = content.toLowerCase();
		let score = 0;
		for (let k = 0; k < keywords.length; k++) {
			score += weights[k]! * Math.log1p(countOccurrences(lower, keywords[k]!));
		}
		passages.push({ start: start + 1, end, text: content, score });
		start = end;
	}
	return passages;
}

/**
 * Keep the best lexical windows and, when no words match, distribute the
 * budget evenly through the file instead of always falling back to its
 * opening bytes. Returned in file order.
 */
export function selectWindows(passages: Passage[], limit: number): Passage[] {
	let selected = passages;
	if (selected.length > limit) {
		if (selected.every(passage => passage.score === 0)) {
			const len = selected.length;
			const step = Math.max(limit - 1, 1);
			const keep = new Set<number>();
			for (let k = 0; k < limit; k++) keep.add(Math.floor((k * (len - 1)) / step));
			selected = selected.filter((_, index) => keep.has(index));
		} else {
			selected = [...selected].sort((a, b) => b.score - a.score || a.start - b.start).slice(0, limit);
		}
	}
	return [...selected].sort((a, b) => a.start - b.start);
}

/** Passage text with the generated `L<n>| ` tags stripped; the caller owns the line coordinates. */
export function plainContent(passage: Passage): string {
	let out = "";
	const tagged = lines(passage.text);
	for (let i = 0; i < tagged.length; i++) {
		const line = tagged[i]!;
		const prefix = `L${passage.start + i}| `;
		out += `${line.startsWith(prefix) ? line.slice(prefix.length) : line}\n`;
	}
	return out;
}

/** Bytes reserved per selected sketch line for its `<line>: ` tag and separator. */
const SKETCH_LINE_OVERHEAD = 12;
/** Minimum bytes worth spending on one more sketch line. */
const SKETCH_MIN_LINE = 24;
/** Longest single sketch line. */
const SKETCH_MAX_LINE = 180;

/**
 * A budgeted map of verbatim source lines, not an invented summary. Lines are
 * ranked by keyword weight (plus a nudge for call-like lines) so deep
 * implementation text can outrank headers, then emitted in file order.
 */
export function sketch(
	passage: Passage,
	keywords: readonly string[],
	weights: readonly number[],
	budget: number,
): string {
	const plain = lines(plainContent(passage));
	const ranked: { index: number; score: number }[] = [];
	for (let index = 0; index < plain.length; index++) {
		const line = plain[index]!;
		if (line.trim().length === 0) continue;
		const lower = line.toLowerCase();
		let score = line.includes("(") ? 0.1 : 0;
		for (let k = 0; k < keywords.length; k++) {
			if (lower.includes(keywords[k]!)) score += weights[k]!;
		}
		ranked.push({ index, score });
	}
	ranked.sort((a, b) => b.score - a.score || a.index - b.index);
	const selected: { index: number; text: string }[] = [];
	let used = 0;
	for (const { index } of ranked) {
		const available = Math.max(0, budget - (used + SKETCH_LINE_OVERHEAD));
		if (available < SKETCH_MIN_LINE) break;
		const line = plain[index]!.trim();
		const text = `${passage.start + index}: ${clipBytes(line, Math.min(available, SKETCH_MAX_LINE))}`;
		used += Buffer.byteLength(text) + 1;
		selected.push({ index, text });
	}
	selected.sort((a, b) => a.index - b.index);
	return selected.map(entry => entry.text).join("\n");
}

/**
 * Union the judged-positive spans; never bridge an unjudged gap. A merged span
 * keeps the max probability so repeated or overlapping asks are not rewarded.
 * Strongest first, then earliest.
 */
export function mergeHeat(heat: readonly HeatRange[], threshold: number): HeatRange[] {
	const kept = heat
		.filter(range => range.p >= threshold && range.p > 0 && range.start <= range.end)
		.sort((a, b) => a.start - b.start || a.end - b.end);
	const merged: HeatRange[] = [];
	for (const range of kept) {
		const last = merged[merged.length - 1];
		if (last && range.start <= last.end + 1) {
			last.end = Math.max(last.end, range.end);
			if (range.p > last.p) last.p = range.p;
			continue;
		}
		merged.push({ ...range });
	}
	return merged.sort((a, b) => b.p - a.p || a.start - b.start);
}

/** The most relevant ranges, strongest first, then earliest. */
export function rankedHeat(heat: readonly HeatRange[], limit: number): HeatRange[] {
	return heat
		.filter(range => range.p > 0)
		.sort((a, b) => b.p - a.p || a.start - b.start)
		.slice(0, limit);
}
