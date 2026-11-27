/** A cyclic literal search over the transcript's logical lines. No document-wide paint or match index. */
import { scheduler } from "node:timers/promises";
import type { UiNode } from "../node";
import type { BlockPosition } from "./fullscreen-history";
import type { Block } from "./paint";
import { type TextModel, textModel } from "./transcript-text";

/** A match keeps only its source coordinates and spelling, never a Block or image placement. */
export interface TranscriptMatch {
	readonly node: UiNode;
	readonly index: number;
	readonly start: number;
	readonly value: string;
	readonly query: string;
	/** First painted block row of the match at the width searched. */
	readonly row: number;
}

interface Cursor {
	readonly index: number;
	readonly offset: number;
}

type Direction = -1 | 1;
type Scan = Generator<void, TranscriptMatch | undefined>;

/** First or last source position painted at the window's top, skipping chrome in the search direction. */
function readingCursor(model: TextModel, top: number, direction: Direction): Cursor {
	let row = direction > 0 ? Math.max(0, top) : Math.min(top, model.rows.length - 1);
	for (; row >= 0 && row < model.rows.length; row += direction) {
		const entry = model.rows[row];
		const index = model.rowLine[row];
		if (!entry || index === undefined) continue;
		let offset = direction > 0 ? Infinity : -1;
		for (const span of entry.spans ?? [entry]) {
			if (span.end > span.start) offset = direction > 0 ? Math.min(offset, span.start) : Math.max(offset, span.end);
		}
		if (Number.isFinite(offset) && offset >= 0) return { index, offset };
	}
	return { index: direction > 0 ? model.lines.length : -1, offset: 0 };
}

interface Run {
	readonly start: number;
	readonly end: number;
	readonly row: number;
}

/** Runs in source order (a wrapped table cell can follow a later cell on the preceding screen row). */
function sourceRuns(model: TextModel, index: number): Run[] {
	const runs: Run[] = [];
	const end = model.firstRow[index + 1] ?? model.rows.length;
	let ordered = true;
	for (let row = model.firstRow[index]!; row < end; row++) {
		const entry = model.rows[row];
		if (!entry) continue;
		for (const span of entry.spans ?? [entry]) {
			if (span.end <= span.start) continue;
			if (runs.length && runs[runs.length - 1]!.end > span.start) ordered = false;
			runs.push({ start: span.start, end: span.end, row });
		}
	}
	return ordered ? runs : runs.sort((a, b) => a.start - b.start);
}

/** A match may cross elided whitespace at a soft wrap, but not omitted text or a table's grid lines. */
function paintedRow(runs: readonly Run[], text: string, start: number, end: number): number | undefined {
	let lo = 0;
	let hi = runs.length;
	while (lo < hi) {
		const mid = (lo + hi) >>> 1;
		if (runs[mid]!.end <= start) lo = mid + 1;
		else hi = mid;
	}
	let offset = start;
	let first: number | undefined;
	for (let i = lo; i < runs.length && runs[i]!.start < end; i++) {
		const run = runs[i]!;
		if (run.start > offset && text.slice(offset, run.start).trim()) return undefined;
		first = first === undefined ? run.row : Math.min(first, run.row);
		offset = Math.max(offset, run.end);
		if (offset >= end) return first;
	}
	return first !== undefined && !text.slice(offset, end).trim() ? first : undefined;
}

/** Find a start in [lower, upper), measured in logical line/UTF-16 coordinates. */
function* scanBlock(
	model: TextModel,
	node: UiNode,
	query: string,
	pattern: RegExp,
	direction: Direction,
	lower?: Cursor,
	upper?: Cursor,
): Scan {
	const lo = Math.max(0, lower?.index ?? 0);
	const hi = Math.min(model.lines.length - 1, upper?.index ?? model.lines.length - 1);
	let work = 0;
	for (let index = direction > 0 ? lo : hi; index >= lo && index <= hi; index += direction) {
		const text = model.lines[index]!.text;
		const from = lower?.index === index ? lower.offset : 0;
		const to = upper?.index === index ? upper.offset : text.length;
		let last: TranscriptMatch | undefined;
		let runs: Run[] | undefined;
		pattern.lastIndex = from;
		let hit: RegExpExecArray | null;
		while (pattern.lastIndex < to && (hit = pattern.exec(text)) && hit.index < to) {
			// Search original UTF-16 coordinates, not a lowercased copy (case folding can change its length).
			const row = paintedRow((runs ??= sourceRuns(model, index)), text, hit.index, pattern.lastIndex);
			if (row !== undefined) {
				last = { node, index, start: hit.index, value: hit[0], query, row };
				if (direction > 0) return last;
			}
			// Include overlapping occurrences, moving by a whole Unicode code point even for a surrogate pair.
			pattern.lastIndex = hit.index + (text.codePointAt(hit.index)! > 0xffff ? 2 : 1);
			if (++work % 64 === 0) yield;
		}
		if (last) return last;
		if (++work % 64 === 0) yield;
	}
	return undefined;
}

function* scan(
	nodes: readonly UiNode[],
	read: (node: UiNode) => Block,
	origin: BlockPosition,
	repeat: TranscriptMatch | undefined,
	query: string,
	direction: Direction,
): Scan {
	const pattern = new RegExp(RegExp.escape(query), "giu");
	let cut: Cursor | undefined;
	let i = origin.i;
	// Visit the starting block twice: the near side of the cut on entry, the other side after wrapping.
	for (let step = 0; step <= nodes.length; step++) {
		const node = nodes[i]!;
		const model = textModel(read(node));
		if (step === 0) {
			if (repeat && model.lines[repeat.index]?.text.startsWith(repeat.value, repeat.start)) {
				// Partition by match start, not end, so overlapping matches are reachable in both directions.
				const point = repeat.value.codePointAt(0)!;
				const after = repeat.start + (point > 0xffff ? 2 : 1);
				cut = { index: repeat.index, offset: direction > 0 ? after : repeat.start };
			} else cut = readingCursor(model, origin.row, direction);
		}
		const lower = (direction > 0 ? step === 0 : step === nodes.length) ? cut : undefined;
		const upper = (direction < 0 ? step === 0 : step === nodes.length) ? cut : undefined;
		const match = yield* scanBlock(model, node, query, pattern, direction, lower, upper);
		if (match) return match;
		i = (i + direction + nodes.length) % nodes.length;
		yield;
	}
	return undefined;
}

/** Yield before painting cold blocks and between bounded slices, including a single block with many lines. */
export async function findTranscriptMatch(
	nodes: readonly UiNode[],
	read: (node: UiNode) => Block,
	origin: BlockPosition,
	repeat: TranscriptMatch | undefined,
	query: string,
	direction: Direction,
	current: () => boolean,
): Promise<TranscriptMatch | undefined> {
	const search = scan(nodes, read, origin, repeat, query, direction);
	for (;;) {
		await scheduler.yield();
		if (!current()) return undefined;
		const deadline = performance.now() + 8;
		for (let steps = 0; steps < 16; steps++) {
			const step = search.next();
			if (step.done) return step.value;
			if (performance.now() >= deadline) break;
		}
	}
}
