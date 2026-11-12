/**
 * Local BM25 ranking: the deterministic backend's retrieval and the candidate shortlist a judge
 * evaluates. No model, no network.
 */

const BM25_K1 = 1.5;
const BM25_B = 0.75;
const TOKEN_SPLIT = /[^\p{L}\p{N}]+/u;

export function tokenize(text: string): string[] {
	return text
		.toLowerCase()
		.split(TOKEN_SPLIT)
		.filter(token => token.length > 0);
}

export interface LexicalRanking {
	index: number;
	score: number;
}

export interface LexicalRankOptions {
	/**
	 * Query tokens occurring in more documents than this are ignored, so common words ("the", "file")
	 * do not make every candidate a match. When every query token is common, all of them count.
	 */
	maxDocumentFrequency?: number;
}

/** BM25 ranking of `documents` against `query`, highest score first; ties keep document order. */
export function lexicalRank(
	query: string,
	documents: readonly string[],
	options: LexicalRankOptions = {},
): LexicalRanking[] {
	const queryTokens = tokenize(query);
	const docTokens = documents.map(tokenize);
	const avgLength =
		docTokens.length > 0 ? docTokens.reduce((sum, tokens) => sum + tokens.length, 0) / docTokens.length : 0;
	const documentFrequency = new Map<string, number>();
	for (const tokens of docTokens) {
		for (const token of new Set(tokens)) documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1);
	}
	const maxFrequency = options.maxDocumentFrequency;
	const specific =
		maxFrequency === undefined
			? queryTokens
			: queryTokens.filter(token => {
					const frequency = documentFrequency.get(token) ?? 0;
					return frequency > 0 && frequency <= maxFrequency;
				});
	const scoring = specific.length > 0 ? specific : queryTokens;
	const total = documents.length;
	const ranked = docTokens.map((tokens, index) => {
		const counts = new Map<string, number>();
		for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
		let score = 0;
		for (const token of scoring) {
			const frequency = counts.get(token);
			if (!frequency) continue;
			const df = documentFrequency.get(token) ?? 0;
			const idf = Math.log(1 + (total - df + 0.5) / (df + 0.5));
			const norm = frequency + BM25_K1 * (1 - BM25_B + (BM25_B * tokens.length) / (avgLength || 1));
			score += idf * ((frequency * (BM25_K1 + 1)) / norm);
		}
		return { index, score };
	});
	ranked.sort((a, b) => b.score - a.score || a.index - b.index);
	return ranked;
}
