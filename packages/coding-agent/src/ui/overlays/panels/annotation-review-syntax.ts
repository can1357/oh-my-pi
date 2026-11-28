import { type HighlightedLine, highlightSpans, supportsLanguage } from "@oh-my-pi/pi-tui/text/highlight";
import { languageFromPath } from "@oh-my-pi/pi-tui/text/lang";
import { replaceTabs } from "@oh-my-pi/pi-tui/text/width";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import type {
	ReviewDiffFile,
	ReviewSourceRow,
	TextReviewSource,
} from "../../../extensibility/custom-commands/bundled/annotate/annotation-types";

/** One span row per logical source line; an absent row keeps its plain rendering. */
type ReviewSyntax = readonly (HighlightedLine | undefined)[];

function highlightLines(
	lines: readonly string[],
	language: string | undefined,
): readonly HighlightedLine[] | undefined {
	if (!language || !supportsLanguage(language) || lines.length === 0) return undefined;
	const display = lines.map(line => replaceTabs(sanitizeText(line)));
	const spans = highlightSpans(display.join("\n"), language);
	if (
		spans.length === display.length &&
		spans.every((line, index) => line.map(span => span.t).join("") === display[index])
	)
		return spans;
	return undefined;
}

function languageForText(source: TextReviewSource): string | undefined {
	if (source.provenance?.kind === "file") return languageFromPath(source.provenance.path);
	return source.language;
}

/** Style the display copy only; note quotes still come from the original source. */
export function highlightReviewText(source: TextReviewSource, lines: readonly string[]): ReviewSyntax | undefined {
	return highlightLines(lines, languageForText(source));
}

/** Tokenize the two sides of each hunk independently, then restore visible row order. */
export function highlightReviewDiff(file: ReviewDiffFile): ReviewSyntax | undefined {
	if (file.isBinary) return undefined;
	const oldLanguage = languageFromPath(file.oldPath ?? file.path);
	const newLanguage = languageFromPath(file.newPath ?? file.path);
	if (!oldLanguage && !newLanguage) return undefined;

	const syntax: (HighlightedLine | undefined)[] = [];
	const hunk: ReviewSourceRow[] = [];
	function flush(): void {
		if (hunk.length === 0) return;
		const oldLines = highlightLines(
			hunk.filter(row => row.kind !== "added").map(row => row.content),
			oldLanguage,
		);
		const newLines = highlightLines(
			hunk.filter(row => row.kind !== "removed").map(row => row.content),
			newLanguage,
		);
		let oldIndex = 0;
		let newIndex = 0;
		for (const row of hunk) {
			const before = row.kind !== "added" ? oldLines?.[oldIndex++] : undefined;
			const after = row.kind !== "removed" ? newLines?.[newIndex++] : undefined;
			syntax.push(after ?? before);
		}
		hunk.length = 0;
	}

	for (const row of file.rows) {
		if (row.kind === "hunk") flush();
		else if (row.kind !== "no-newline") hunk.push(row);
	}
	flush();
	return syntax.length > 0 ? syntax : undefined;
}
