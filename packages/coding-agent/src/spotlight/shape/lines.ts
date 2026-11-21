/**
 * Line helpers shared by every shaping step: the normal form lines are compared in, the markers earlier shaping
 * writes, and the words lexical scores read.
 */

/** A line of earlier shaping (fold, gap, dump marker, note): cheap and says what is where, so never hidden or collapsed. */
export const MARKER = /^\s*(?:… \[|…\[|\[(?:display only|exit code|outline|cut|uniform)|\(\d+ rows\))/;

/** Lines shorter than this (normalised) are too generic to count as already seen, or as hidden by a cut. */
export const WITNESS_CHARS = 12;

/** Hidden lines shorter than this (normalised) are too generic to tell that the agent asks again. */
export const AGAIN_CHARS = 24;

/** A line without its `N:` / `cat -n` / `path:N:` prefix and surrounding blanks: the key lines are compared by. */
export function norm(line: string): string {
	return line.replace(/^(?:[\w./-]+:)?\s*\d+[\t:|-]\s?/, "").trim();
}

/** Key of normalised line `next` right after `prev` in one text: the order seen lines collapse in ({@link norm}). */
export function pairKey(prev: string, next: string): string {
	return `${prev}\n${next}`;
}

/** Words too generic in intents to say anything about a line. */
const STOP = new Set(
	"find check read inspect whether where what which with from that this into have does show lines line file files code output the and for are see used uses use need needs most least recent latest first last many much each every about some other only when been will would could should there their them they than then also just like more less decide decides contain contains name names cover covers mention mentions touch touches happen happens cause causes make makes work works mean means added adding exact exactly introduced introduce count counts number".split(
		" ",
	),
);

/**
 * Lowercase words of `text` (`[a-z_][a-z0-9_]{3,}`) without the stop words, and its compound tokens (`gen:rpc`,
 * `index.ts`, `shard-3`) of at least 4 characters: a name made of short parts is still a name.
 */
export function words(text: string): Set<string> {
	const out = new Set<string>();
	const lower = text.toLowerCase();
	for (const w of lower.match(/[a-z_][a-z0-9_]{3,}/g) ?? []) if (!STOP.has(w)) out.add(w);
	for (const w of lower.match(/[a-z0-9_]+(?:[:./-][a-z0-9_]+)+/g) ?? []) if (w.length >= 4) out.add(w);
	return out;
}

/** Identifiers of `text` (`[A-Za-z_$][\w$]*`), for "named in the conversation". */
export function identifiers(text: string): string[] {
	return text.match(/[A-Za-z_$][\w$]*/g) ?? [];
}

/** Leading whitespace of the first non-blank line of `lines` ("" when all are blank). */
export function indentOfFirst(lines: readonly string[]): string {
	return /^\s*/.exec(lines.find(l => l.trim()) ?? "")?.[0] ?? "";
}
