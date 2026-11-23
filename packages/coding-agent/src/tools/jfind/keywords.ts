/**
 * Query-derived keywords for the lexical prior: quoted phrases whole, then
 * alphanumeric tokens minus stopwords, cheaply stemmed and deduplicated.
 */

const STOPWORDS: Record<string, true> = Object.fromEntries(
	[
		"the",
		"a",
		"an",
		"or",
		"and",
		"to",
		"is",
		"are",
		"be",
		"when",
		"where",
		"how",
		"that",
		"this",
		"of",
		"in",
		"on",
		"at",
		"for",
		"with",
		"by",
		"its",
		"it",
		"as",
		"from",
		"into",
		"like",
		"gets",
		"get",
		"up",
		"which",
		"what",
		"does",
		"do",
		"code",
		"file",
		"files",
		"over",
		"all",
		"user",
		"using",
		"then",
		"than",
		"there",
		"their",
		"they",
		"them",
		"you",
		"your",
		"we",
		"our",
		"has",
		"have",
		"had",
		"was",
		"were",
		"been",
		"being",
		"will",
		"would",
		"should",
		"can",
		"could",
		"not",
		"but",
		"if",
		"so",
		"such",
		"via",
		"per",
		"any",
		"some",
		"each",
		"every",
		"also",
		"just",
		"only",
		"more",
		"most",
		"other",
		"out",
		"off",
		"about",
		"after",
		"before",
		"between",
		"through",
		"during",
		"without",
		"within",
		"one",
		"two",
		"new",
		"used",
		"use",
		"make",
		"makes",
		"made",
		"run",
		"runs",
		"way",
		"thing",
		"things",
		"something",
		"actually",
		"really",
		"still",
		"yet",
	].map(word => [word, true]),
);

/** Cheap stem so a substring match covers inflections: spawned→spawn, compacted→compact. */
function stem(token: string): string {
	for (const suffix of ["ing", "ed", "es", "s"]) {
		if (token.endsWith(suffix)) {
			const base = token.slice(0, -suffix.length);
			if (base.length >= 4) return base;
		}
	}
	return token;
}

/** Unicode letter, digit, or underscore — the token alphabet of the query. */
const TOKEN_RE = /[^\p{L}\p{N}_]+/u;
const DIGITS_RE = /^[0-9]+$/;

/** Keywords for the grep prior: quoted phrases whole, then tokens minus stopwords. */
export function keywordsFromQuery(query: string): string[] {
	const out: string[] = [];
	let rest = "";
	const chars = Array.from(query);
	for (let i = 0; i < chars.length; i++) {
		const c = chars[i]!;
		if (c !== '"' && c !== "'") {
			rest += c;
			continue;
		}
		let phrase = "";
		let closed = false;
		while (++i < chars.length) {
			if (chars[i] === c) {
				closed = true;
				break;
			}
			phrase += chars[i];
		}
		phrase = phrase.trim().toLowerCase();
		if (closed && Buffer.byteLength(phrase) >= 3) {
			out.push(phrase);
			rest += " ";
			continue;
		}
		rest += `${phrase} `;
	}
	for (const token of rest.split(TOKEN_RE)) {
		const lower = token.toLowerCase();
		if (Buffer.byteLength(lower) < 3 || Object.hasOwn(STOPWORDS, lower) || DIGITS_RE.test(lower)) continue;
		const stemmed = stem(lower);
		if (!out.includes(stemmed)) out.push(stemmed);
	}
	return out;
}

/** {@link keywordsFromQuery} plus the caller's extra keywords, lowercased and deduplicated. */
export function keywords(query: string, extra: readonly string[]): string[] {
	const out = keywordsFromQuery(query);
	for (const raw of extra) {
		const keyword = raw.trim().toLowerCase();
		if (keyword.length > 0 && !out.includes(keyword)) out.push(keyword);
	}
	return out;
}
