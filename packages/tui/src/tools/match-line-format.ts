/**
 * Format a single line of match output for grep/ast-grep style results.
 *
 * Matched lines are prefixed with `*`; context lines are prefixed with a single
 * space so line numbers align in column. In hashline mode the line uses the
 * editable `LINE:content` shape under a snapshot-tag header; in plain mode it
 * keeps the legacy `LINE|content` display-only shape. Line numbers are never padded.
 */
export function formatMatchLine(
	lineNumber: number,
	line: string,
	isMatch: boolean,
	options: { useHashLines: boolean },
): string {
	const marker = isMatch ? "*" : " ";
	if (options.useHashLines) {
		return `${marker}${lineNumber}:${line}`;
	}
	return `${marker}${lineNumber}|${line}`;
}
