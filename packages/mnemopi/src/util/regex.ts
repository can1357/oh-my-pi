const RECALL_TOKEN_RE = /[a-z0-9][a-z0-9_.:/+-]*/g;
const CJK_RE = /[\u3040-\u30ff\u4e00-\u9fff\uac00-\ud7af]/;

export const FACT_MATCH_STOPWORDS = new Set([
	"a",
	"an",
	"and",
	"are",
	"as",
	"at",
	"be",
	"by",
	"can",
	"could",
	"did",
	"do",
	"does",
	"for",
	"from",
	"had",
	"has",
	"have",
	"how",
	"i",
	"in",
	"is",
	"it",
	"its",
	"me",
	"my",
	"of",
	"on",
	"or",
	"our",
	"related",
	"should",
	"that",
	"the",
	"their",
	"there",
	"this",
	"to",
	"totally",
	"unrelated",
	"use",
	"uses",
	"was",
	"we",
	"what",
	"when",
	"where",
	"which",
	"who",
	"why",
	"with",
	"you",
	"your",
]);

export const RECALL_SYNONYMS: Readonly<Record<string, readonly string[]>> = {
	branding: ["brand", "positioning", "identity", "wording"],
	preference: ["prefer", "prefers", "want", "wants", "reject", "rejects", "avoid", "grounded"],
	professional: ["software", "builder"],
	url: ["link", "profile"],
	current: ["now", "live", "latest"],
	feeling: ["feel", "feels"],
	imposter: ["self-doubt", "doubt", "insecure"],
};

export function isCjkChar(ch: string): boolean {
	return (
		(ch >= "\u4e00" && ch <= "\u9fff") || (ch >= "\u3040" && ch <= "\u30ff") || (ch >= "\uac00" && ch <= "\ud7af")
	);
}

export function hasCjk(text: string): boolean {
	return CJK_RE.test(text);
}

export const containsSpacelessCjk = hasCjk;

export function recallTokens(text: string): string[] {
	RECALL_TOKEN_RE.lastIndex = 0;
	const tokens: string[] = [];
	const lower = text.toLowerCase();
	let match = RECALL_TOKEN_RE.exec(lower);
	while (match !== null) {
		const token = match[0];
		if (token.length >= 3 && !FACT_MATCH_STOPWORDS.has(token) && !isAsciiDigits(token)) tokens.push(token);
		match = RECALL_TOKEN_RE.exec(lower);
	}
	return tokens;
}

export function factMatchTokens(text: string): Set<string> {
	return new Set(recallTokens(text));
}

export function expandedQueryTokens(tokens: readonly string[]): string[] {
	const expanded: string[] = [];
	const seen = new Set<string>();
	for (const token of tokens) {
		if (!seen.has(token)) {
			seen.add(token);
			expanded.push(token);
		}
		const synonyms = RECALL_SYNONYMS[token];
		if (synonyms === undefined) continue;
		for (const synonym of synonyms) {
			if (seen.has(synonym)) continue;
			seen.add(synonym);
			expanded.push(synonym);
		}
	}
	return expanded;
}

export function minimumRecallRelevance(queryTokens: readonly string[]): number {
	if (queryTokens.length >= 4) return 0.3;
	if (queryTokens.length === 3) return 0.5;
	return 0.15;
}

export function cjkFtsTerms(text: string): string[] {
	const chars: string[] = [];
	for (let i = 0; i < text.length; i++) {
		const ch = text.charAt(i);
		if (isCjkChar(ch)) chars.push(ch);
	}
	if (chars.length === 0) return [];
	const terms: string[] = [];
	const seen = new Set<string>();
	for (const ch of chars) {
		if (seen.has(ch)) continue;
		seen.add(ch);
		terms.push(ch);
	}
	for (let i = 1; i < chars.length; i++) {
		const previous = chars[i - 1];
		const current = chars[i];
		if (previous === undefined || current === undefined) continue;
		const bigram = `${previous}${current}`;
		if (seen.has(bigram)) continue;
		seen.add(bigram);
		terms.push(`"${bigram}"`);
	}
	return terms;
}

export function ftsQueryTerms(query: string): string[] {
	const terms: string[] = [];
	for (const term of expandedQueryTokens(recallTokens(query))) {
		const escaped = term.replaceAll('"', '""').trim();
		if (escaped) terms.push(`"${escaped}"`);
	}
	return terms;
}

function isAsciiDigits(value: string): boolean {
	for (let i = 0; i < value.length; i++) {
		const code = value.charCodeAt(i);
		if (code < 48 || code > 57) return false;
	}
	return value.length > 0;
}
