/** One inline construct. */
export interface InlineRule {
	/** File name in `src/rules/` and section name in docs/syntax.md. */
	name: string;
	/** Rewrites every occurrence in already-safe text into HTML. */
	apply(html: string): string;
}
