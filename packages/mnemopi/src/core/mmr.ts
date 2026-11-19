import { mmrRerankIndices } from "@oh-my-pi/pi-natives";

export interface MmrResult {
	readonly content?: string;
	readonly score?: number;
	readonly [key: string]: unknown;
}

export type SimilarityFn = (textA: string, textB: string) => number;

export function jaccardSimilarity(textA: string, textB: string): number {
	const wordsA = new Set(textA.toLowerCase().split(/\s+/).filter(Boolean));
	const wordsB = new Set(textB.toLowerCase().split(/\s+/).filter(Boolean));

	if (wordsA.size === 0 || wordsB.size === 0) return 0.0;

	let intersection = 0;
	for (const word of wordsA) {
		if (wordsB.has(word)) intersection += 1;
	}

	return intersection / (wordsA.size + wordsB.size - intersection);
}
export function mmrRerank<T extends MmrResult>(
	results: readonly T[],
	lambdaParam = 0.7,
	topK = 10,
	similarityFn: SimilarityFn = jaccardSimilarity,
): T[] {
	const limit = Math.max(0, Math.trunc(topK));
	if (limit <= 0) return [];
	if (results.length <= 1) return results.slice(0, limit);

	const sortedResults = results.slice().sort((left, right) => (right.score ?? 0) - (left.score ?? 0));
	const first = sortedResults[0];
	if (first === undefined) return [];

	// Native batch kernel: one N-API crossing selects all indices. Only valid
	// for the default Jaccard similarity; custom similarity functions stay in
	// TS. Lone-surrogate contents also stay in TS: N-API converts them to
	// U+FFFD, which would merge distinct tokens. NaN topK stays in TS so the
	// pre-native contract (loop guard is false, first result still returned)
	// is preserved.
	if (
		similarityFn === jaccardSimilarity &&
		!Number.isNaN(limit) &&
		sortedResults.every(result => (result.content ?? "").isWellFormed())
	) {
		// Pre-lowercase with JS semantics so contextual mappings (Final_Sigma:
		// "ΟΣ" -> "ος") are applied before the context-insensitive native
		// lowercase, which is idempotent on already-lowercased text.
		const contents = sortedResults.map(result => (result.content ?? "").toLowerCase());
		const scores = Float64Array.from(sortedResults, result => result.score ?? 0);
		// Clamp before the u32 N-API boundary: Infinity or >= 2**32 would
		// otherwise wrap (ToUint32) and silently return nothing.
		const nativeLimit = Math.min(limit, sortedResults.length);
		const picked = mmrRerankIndices(contents, scores, lambdaParam, nativeLimit);
		const out: T[] = [];
		for (const index of picked) {
			const item = sortedResults[index];
			if (item !== undefined) out.push(item);
		}
		return out;
	}

	const selected: T[] = [first];
	const remaining = sortedResults.slice(1);

	while (remaining.length > 0 && selected.length < limit) {
		let bestIdx = 0;
		let bestScore = Number.NEGATIVE_INFINITY;

		for (let idx = 0; idx < remaining.length; idx += 1) {
			const candidate = remaining[idx];
			if (candidate === undefined) continue;

			let maxSimilarity = 0.0;
			const candidateContent = candidate.content ?? "";
			for (const selectedResult of selected) {
				const similarity = similarityFn(candidateContent, selectedResult.content ?? "");
				if (similarity > maxSimilarity) maxSimilarity = similarity;
			}

			const relevance = candidate.score ?? 0;
			const mmrScore = lambdaParam * relevance - (1.0 - lambdaParam) * maxSimilarity;
			if (mmrScore > bestScore) {
				bestScore = mmrScore;
				bestIdx = idx;
			}
		}

		const chosen = remaining.splice(bestIdx, 1)[0];
		if (chosen !== undefined) selected.push(chosen);
	}

	if (selected.length < limit) {
		selected.push(...remaining.slice(0, limit - selected.length));
	}

	return selected;
}
