import { describe, expect, test } from "bun:test";
import { cosineSimilarityPairs, mmrRerankIndices, vectorIndexTopK } from "@oh-my-pi/pi-natives";
import { jaccardSimilarity, mmrRerank } from "../src/core/mmr";
import { buildExactVectorIndex, searchExactVectorIndex } from "../src/core/vector-index";
import { cosineSimilarity } from "../src/core/vector-math";

/** Deterministic LCG so parity failures reproduce exactly. */
function makeRng(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state * 1664525 + 1013904223) >>> 0;
		return state / 4294967296;
	};
}

const REL_TOL = 1e-9;

function expectClose(actual: number, expected: number): void {
	if (expected === 0) {
		expect(actual).toBe(0);
		return;
	}
	expect(Math.abs(actual - expected) / Math.abs(expected)).toBeLessThanOrEqual(REL_TOL);
}

describe("native vector kernel parity", () => {
	test("cosineSimilarityPairs matches the TS pairwise threshold loop", () => {
		const rng = makeRng(0x9a175);
		const dim = 64;
		const count = 40;
		const flat = new Float64Array(count * dim);
		for (let i = 0; i < flat.length; i += 1) flat[i] = rng() * 2 - 1;
		const threshold = 0.02;
		const expected: number[] = [];
		for (let i = 0; i < count; i += 1) {
			for (let j = i + 1; j < count; j += 1) {
				if (
					cosineSimilarity(flat.subarray(i * dim, (i + 1) * dim), flat.subarray(j * dim, (j + 1) * dim)) >=
					threshold
				) {
					expected.push(i, j);
				}
			}
		}
		expect(Array.from(cosineSimilarityPairs(flat, count, dim, threshold))).toEqual(expected);
	});

	test("vectorIndexTopK matches the TS scoring loop and stable sort", () => {
		const rng = makeRng(0x70b1);
		const dims = 384;
		const count = 300;
		const matrix = new Float32Array(count * dims);
		for (let i = 0; i < matrix.length; i += 1) matrix[i] = rng() * 2 - 1;
		const query = Float64Array.from({ length: dims }, () => rng() * 2 - 1);
		let normSq = 0;
		for (const v of query) normSq += v * v;
		const norm = Math.sqrt(normSq);
		const hits: Array<{ row: number; score: number }> = [];
		for (let row = 0; row < count; row += 1) {
			let score = 0;
			for (let col = 0; col < dims; col += 1) {
				score += (matrix[row * dims + col] ?? 0) * ((query[col] ?? 0) / norm);
			}
			hits.push({ row, score });
		}
		hits.sort((a, b) => b.score - a.score);
		const limit = 25;
		const result = vectorIndexTopK(matrix, dims, query, limit);
		expect(Array.from(result.indices)).toEqual(hits.slice(0, limit).map(h => h.row));
		for (let i = 0; i < limit; i += 1) {
			expectClose(result.scores[i] ?? Number.NaN, hits[i]?.score ?? Number.NaN);
		}
	});

	test("mmrRerankIndices selects identical index sequences to the TS loop", () => {
		const rng = makeRng(0x33a11);
		const words = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta", "iota", "kappa"];
		const count = 60;
		const contents: string[] = [];
		const scores = new Float64Array(count);
		for (let i = 0; i < count; i += 1) {
			const n = 1 + Math.floor(rng() * 8);
			contents.push(Array.from({ length: n }, () => words[Math.floor(rng() * words.length)]).join(" "));
			scores[i] = rng();
		}
		scores[5] = scores[6] = 0.5; // exercise strict-> tie keeping the earlier candidate
		for (const lambda of [0.0, 0.3, 0.7, 1.0]) {
			for (const topK of [1, 10, count, count + 5]) {
				// TS reference selection over pre-sorted candidates (mirrors mmrRerank
				// after its sort step).
				const order = contents.map((_, i) => i).sort((a, b) => (scores[b] ?? 0) - (scores[a] ?? 0));
				const sortedContents = order.map(i => contents[i] ?? "");
				const sortedScores = order.map(i => scores[i] ?? 0);
				const selected: number[] = [0];
				const remaining = sortedContents.map((_, i) => i).slice(1);
				while (remaining.length > 0 && selected.length < topK) {
					let bestIdx = 0;
					let bestScore = Number.NEGATIVE_INFINITY;
					for (let idx = 0; idx < remaining.length; idx += 1) {
						const candidate = remaining[idx] ?? 0;
						let maxSimilarity = 0;
						for (const picked of selected) {
							const sim = jaccardSimilarity(sortedContents[candidate] ?? "", sortedContents[picked] ?? "");
							if (sim > maxSimilarity) maxSimilarity = sim;
						}
						const mmrScore = lambda * (sortedScores[candidate] ?? 0) - (1 - lambda) * maxSimilarity;
						if (mmrScore > bestScore) {
							bestScore = mmrScore;
							bestIdx = idx;
						}
					}
					selected.push(remaining.splice(bestIdx, 1)[0] ?? 0);
				}
				if (selected.length < topK) selected.push(...remaining.slice(0, topK - selected.length));
				const native = mmrRerankIndices(sortedContents, Float64Array.from(sortedScores), lambda, topK);
				expect(Array.from(native)).toEqual(selected.slice(0, topK));
			}
		}
	});

	test("mmrRerank wrapper preserves the pre-native limit contract at u32 boundaries", () => {
		const results = Array.from({ length: 8 }, (_v, i) => ({
			content: `item ${i} alpha beta`,
			score: (8 - i) / 10,
		}));
		const all = mmrRerank(results, 0.7, results.length);
		// Infinity and >= 2**32 previously walked every candidate; ToUint32
		// would have collapsed them to 0/1 without the TS-side clamp.
		expect(mmrRerank(results, 0.7, Number.POSITIVE_INFINITY)).toEqual(all);
		expect(mmrRerank(results, 0.7, 2 ** 32)).toEqual(all);
		expect(mmrRerank(results, 0.7, 2 ** 32 + 1)).toEqual(all);
		// NaN: loop guard is false but the first result is already selected.
		expect(mmrRerank(results, 0.7, Number.NaN)).toEqual([results[0] as (typeof results)[number]]);
		expect(mmrRerank(results, 0.7, 0)).toEqual([]);
		expect(mmrRerank(results, 0.7, -3)).toEqual([]);
	});

	test("mmrRerank matches the TS path on contextual-lowercase and lone-surrogate content", () => {
		// Force the TS selection loop by defeating the identity check.
		const tsJaccard = (a: string, b: string): number => jaccardSimilarity(a, b);
		// Final_Sigma: JS lowercases "ΟΣ" to "ος"; a context-insensitive
		// lowercase would produce "οσ" and score these words as distinct.
		const sigma = [
			{ content: "ΟΣ", score: 0.9 },
			{ content: "ος", score: 0.8 },
			{ content: "other words entirely", score: 0.7 },
		];
		for (const lambda of [0, 0.3, 0.7]) {
			expect(mmrRerank(sigma, lambda, 2)).toEqual(mmrRerank(sigma, lambda, 2, tsJaccard));
		}
		// Lone surrogates route to the TS path: N-API would convert them to
		// U+FFFD and merge the first two tokens.
		const surrogate = [
			{ content: "\ud800", score: 0.9 },
			{ content: "\ufffd", score: 0.8 },
			{ content: "other", score: 0.7 },
		];
		expect(mmrRerank(surrogate, 0, 2)).toEqual(mmrRerank(surrogate, 0, 2, tsJaccard));
	});

	test("searchExactVectorIndex preserves the pre-native limit contract at u32 boundaries", () => {
		const rows = Array.from({ length: 6 }, (_v, i) => ({
			id: i,
			vector: Array.from({ length: 8 }, (_x, j) => Math.sin(i * 8 + j)),
		}));
		const index = buildExactVectorIndex(rows);
		const query = Array.from({ length: 8 }, (_x, j) => Math.cos(j));
		const all = searchExactVectorIndex(index, query, index.count);
		expect(all.length).toBe(index.count);
		expect(searchExactVectorIndex(index, query, Number.POSITIVE_INFINITY)).toEqual(all);
		expect(searchExactVectorIndex(index, query, 2 ** 32)).toEqual(all);
		expect(searchExactVectorIndex(index, query, Number.NaN)).toEqual([]);
		expect(searchExactVectorIndex(index, query, 0)).toEqual([]);
	});
});
