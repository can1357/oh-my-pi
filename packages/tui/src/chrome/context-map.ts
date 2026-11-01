/** Pure occupancy calculations for contiguous token segments, independent of themes and renderers. */
export interface ContextMapSegment<T> {
	readonly id: T;
	readonly tokens: number;
}

export interface ContextMapCell<T> {
	readonly id: T;
	readonly full: boolean;
}

/**
 * Lays `segments` out in order over a `columns` × `rows` grid representing `windowTokens`; each cell takes the
 * segment covering most of it and is `full` at 70% coverage or more. Returns `[]` when the window or grid
 * size is unusable, and omits cells no segment touches.
 */
export function planContextMap<T>(
	segments: readonly ContextMapSegment<T>[],
	windowTokens: number,
	columns: number,
	rows: number,
): ContextMapCell<T>[] {
	if (
		!Number.isFinite(windowTokens) ||
		windowTokens <= 0 ||
		!Number.isInteger(columns) ||
		!Number.isInteger(rows) ||
		columns <= 0 ||
		rows <= 0
	)
		return [];
	const cellCount = columns * rows;
	const tokensPerCell = windowTokens / cellCount;
	const ranges: { id: T; start: number; end: number }[] = [];
	let cursor = 0;
	for (const segment of segments) {
		if (!Number.isFinite(segment.tokens) || segment.tokens <= 0) continue;
		const end = Math.min(windowTokens, cursor + segment.tokens);
		if (end > cursor) ranges.push({ id: segment.id, start: cursor, end });
		cursor = end;
		if (cursor >= windowTokens) break;
	}
	const cells: ContextMapCell<T>[] = [];
	let first = 0;
	for (let index = 0; index < cellCount; index++) {
		const start = index * tokensPerCell;
		const end = (index + 1) * tokensPerCell;
		while (first < ranges.length && ranges[first]!.end <= start) first++;
		let winner: T | undefined;
		let overlap = 0;
		for (let part = first; part < ranges.length && ranges[part]!.start < end; part++) {
			const range = ranges[part]!;
			const covered = Math.min(end, range.end) - Math.max(start, range.start);
			if (covered > overlap) {
				overlap = covered;
				winner = range.id;
			}
		}
		if (winner !== undefined) cells.push({ id: winner, full: overlap / tokensPerCell >= 0.7 });
	}
	return cells;
}
