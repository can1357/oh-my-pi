/** Scorers: message-level recall/MRR, the official LongMemEval retrieval metrics, and upstream Mnemosyne's substring hit test. */

export interface MessageMetrics {
	"recall@1": number;
	"recall@5": number;
	"recall@10": number;
	mrr: number;
}

export interface LmeRetrievalScore {
	recallAny: number;
	recallAll: number;
	ndcgAny: number;
}

/** `rankedMessageIds[i]` holds every message id behind the i-th ranked memory. */
export function messageLevelMetrics(
	rankedMessageIds: readonly (readonly string[])[],
	gold: readonly string[],
): MessageMetrics {
	const goldSet = new Set(gold);
	const recallAt = (k: number): number => {
		if (goldSet.size === 0) return 0;
		const found = new Set<string>();
		for (const ids of rankedMessageIds.slice(0, k)) for (const id of ids) if (goldSet.has(id)) found.add(id);
		return found.size / goldSet.size;
	};
	const first = rankedMessageIds.findIndex(ids => ids.some(id => goldSet.has(id)));
	return {
		"recall@1": recallAt(1),
		"recall@5": recallAt(5),
		"recall@10": recallAt(10),
		mrr: first < 0 ? 0 : 1 / (first + 1),
	};
}

/** Port of LongMemEval `dcg`: rel[0] + sum(rel[1:] / log2(arange(2, size + 1))). */
function dcg(relevances: readonly number[], k: number): number {
	const rel = relevances.slice(0, k);
	if (rel.length === 0) return 0;
	let sum = 0;
	for (let i = 1; i < rel.length; i++) sum += rel[i] / Math.log2(i + 1);
	return rel[0] + sum;
}

/** Port of LongMemEval `ndcg`: relevances span the whole corpus; `rankings` are corpus indices. */
function ndcg(
	rankings: readonly number[],
	correctDocs: ReadonlySet<string>,
	corpusIds: readonly string[],
	k: number,
): number {
	const relevances = corpusIds.map(id => (correctDocs.has(id) ? 1 : 0));
	const sortedRelevances = rankings.slice(0, k).map(idx => relevances[idx]);
	const idealDcg = dcg(
		relevances.toSorted((a, b) => b - a),
		k,
	);
	const actualDcg = dcg(sortedRelevances, k);
	return idealDcg === 0 ? 0 : actualDcg / idealDcg;
}

/** Port of LongMemEval `evaluate_retrieval` (Python `any([])` = false, `all([])` = true). */
export function lmeEvaluateRetrieval(
	rankings: readonly number[],
	correctDocs: readonly string[],
	corpusIds: readonly string[],
	k: number,
): LmeRetrievalScore {
	const recalled = new Set(rankings.slice(0, k).map(idx => corpusIds[idx]));
	return {
		recallAny: correctDocs.some(doc => recalled.has(doc)) ? 1 : 0,
		recallAll: correctDocs.every(doc => recalled.has(doc)) ? 1 : 0,
		ndcgAny: ndcg(rankings, new Set(correctDocs), corpusIds, k),
	};
}

/** Official `strip_turn_id`: `'_'.join(docid.split('_')[:-1])`. */
const stripTurnId = (docId: string): string => docId.split("_").slice(0, -1).join("_");

/** Port of LongMemEval `evaluate_retrieval_turn2session`, including the `effective_k` widening loop. */
export function lmeEvaluateTurn2Session(
	rankings: readonly number[],
	correctDocs: readonly string[],
	corpusIds: readonly string[],
	k: number,
): LmeRetrievalScore {
	const sessionCorrect = [...new Set(correctDocs.map(stripTurnId))];
	const sessionCorpus = corpusIds.map(stripTurnId);
	let effectiveK = k;
	let uniqueDocIds = new Set(rankings.slice(0, effectiveK).map(idx => sessionCorpus[idx]));
	while (effectiveK <= sessionCorpus.length && uniqueDocIds.size < k) {
		effectiveK += 1;
		uniqueDocIds = new Set(rankings.slice(0, effectiveK).map(idx => sessionCorpus[idx]));
	}
	return lmeEvaluateRetrieval(rankings, sessionCorrect, sessionCorpus, effectiveK);
}

export function lmeMetrics(
	rankings: readonly number[],
	correctDocs: readonly string[],
	corpusIds: readonly string[],
): Record<string, number> {
	const out: Record<string, number> = {};
	for (const k of [5, 10]) {
		const s = lmeEvaluateTurn2Session(rankings, correctDocs, corpusIds, k);
		out[`session.recall_any@${k}`] = s.recallAny;
		out[`session.recall_all@${k}`] = s.recallAll;
		out[`session.ndcg_any@${k}`] = s.ndcgAny;
	}
	for (const k of [5, 10, 50]) {
		const t = lmeEvaluateRetrieval(rankings, correctDocs, corpusIds, k);
		out[`turn.recall_all@${k}`] = t.recallAll;
		if (k === 10) out["turn.ndcg_any@10"] = t.ndcgAny;
	}
	return out;
}

/** First `n` code points (Python slices by code point; JS `.slice` slices by UTF-16 unit). */
export function cp(s: string, n: number): string {
	return Array.from(s).slice(0, n).join("");
}

/** Replica of upstream `benchmark_mnemosyne`: one hit per memory on the first gold whose `[:100][:50]` prefix is a substring. */
export function compatRecall(rankedContents: readonly string[], goldContents: readonly string[], k: number): number {
	if (goldContents.length === 0) return 0;
	const prefixes = goldContents.map(g => cp(cp(g, 100), 50));
	let hits = 0;
	for (const content of rankedContents.slice(0, k)) {
		if (prefixes.some(p => p !== "" && content.includes(p))) hits++;
	}
	return hits / goldContents.length;
}
