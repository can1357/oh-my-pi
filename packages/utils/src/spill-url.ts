/**
 * The internal URL of a spill: a tool output, shaped original, or other text a session
 * saved past what it showed the model. Spill `N` is the file `<N>.log` at the session's
 * `local://` root, so it reads, lists, and completes like any other `local://` file.
 *
 * These helpers are the only code that spells the URL.
 */

const SCHEME = "local://";
const SUFFIX = ".log";
/** `local://N.log`, then an optional `:selector` (`:raw:5-9`, `:1-30,:-30`). */
const LEADING_SPILL_RE = /^local:\/\/(\d+)\.log(?=$|:)/i;
/** Every `local://N.log` in free text; the id must not run on into a longer name. */
const EMBEDDED_SPILL_RE = /local:\/\/(\d+)\.log(?![\w.-])/gi;

/** The `local://` URL of spill `id`. */
export function spillUrl(id: number | string): string {
	return `${SCHEME}${id}${SUFFIX}`;
}

/**
 * The spill id `text` names when it is a spill URL, optionally followed by a read
 * selector (`local://7.log:raw:1-30`); undefined for anything else.
 */
export function parseSpillUrl(text: string): number | undefined {
	const match = LEADING_SPILL_RE.exec(text.trim());
	return match ? Number(match[1]) : undefined;
}

/** Distinct spill ids that `text` names anywhere, ascending. */
export function spillUrlIds(text: string): number[] {
	if (!text.includes(SCHEME)) return [];
	const ids = new Set<number>();
	for (const match of text.matchAll(EMBEDDED_SPILL_RE)) ids.add(Number(match[1]));
	return [...ids].sort((a, b) => a - b);
}

/** The file name spill `id` has at the `local://` root. */
export function spillFileName(id: number | string): string {
	return `${id}${SUFFIX}`;
}

/** The spill id a `local://` root file name carries (`7.log` → 7), if it is one. */
export function spillIdOfFileName(name: string): number | undefined {
	const match = /^(\d+)\.log$/.exec(name);
	return match ? Number(match[1]) : undefined;
}
