import { indentOfFirst } from "./lines";

/** File lines [first, last] (1-based, inclusive) a shown line stands for; null for a line of no file. */
export type Span = [number, number] | null;

/** Text being shaped, as lines, with the file lines each stands for when the text is a file's (read results). */
export interface View {
	lines: string[];
	/** Per line, its file span; null when the text is command output (hidden runs then point at a saved copy). */
	spans: Span[] | null;
}

/** The pi call that prints lines `from`–`to` of `target` (a path or `artifact://N`). */
export function readCall(target: string, from: number, to: number): string {
	return `read ${target}:${from}-${to}`;
}

/** The file lines a run of shown lines [i, j) stands for, or null when none of them is a file line. */
export function runSpan(spans: readonly Span[], i: number, j: number): [number, number] | null {
	let from = 0;
	let to = 0;
	for (let k = i; k < j; k++) {
		const s = spans[k];
		if (!s) continue;
		if (!from) from = s[0];
		to = s[1];
	}
	return from ? [from, to] : null;
}

/** Lines `first`… of a file as a view: line i stands for file line `first + i`. */
export function fileSpans(count: number, first: number): Span[] {
	return Array.from({ length: count }, (_, i): Span => [first + i, first + i]);
}

/**
 * `shown` (a file's lines from file line `first`, as printed) with each fold [from, to] (0-based indexes) replaced
 * by one `… [lines A-B]` marker, indented like the first non-blank line it replaces when `indent` is set.
 */
export function renderFolds(
	content: readonly string[],
	shown: readonly string[],
	first: number,
	folds: readonly { from: number; to: number }[],
	indent: boolean,
): View {
	const lines: string[] = [];
	const spans: Span[] = [];
	let i = 0;
	for (const f of folds) {
		while (i < f.from) {
			lines.push(shown[i]);
			spans.push([first + i, first + i]);
			i++;
		}
		const pad = indent ? indentOfFirst(content.slice(f.from, f.to + 1)) : "";
		lines.push(`${pad}… [lines ${first + f.from}-${first + f.to}]`);
		spans.push([first + f.from, first + f.to]);
		i = f.to + 1;
	}
	while (i < shown.length) {
		lines.push(shown[i]);
		spans.push([first + i, first + i]);
		i++;
	}
	return { lines, spans };
}
