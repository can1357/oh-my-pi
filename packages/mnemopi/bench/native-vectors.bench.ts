/**
 * Crossing-inclusive benchmark of native batch vector kernels vs the TS
 * reference loops, at realistic mnemopi recall shapes (fastembed
 * bge-small-en-v1.5, dim=384; binarized stride=48 bytes).
 *
 * Run from the repo root: `bun packages/mnemopi/bench/native-vectors.bench.ts`
 */
import * as os from "node:os";
import { cosineSimilarityPairs } from "@oh-my-pi/pi-natives";
import { jaccardSimilarity, mmrRerank } from "../src/core/mmr";
import { searchExactVectorIndex } from "../src/core/vector-index";
import { cosineSimilarity } from "../src/core/vector-math";

const DIM = 384;
const STRIDE = DIM / 8;
const COUNTS = [10, 100, 1000, 10000];
const WARMUP = 20;
const ITERATIONS = 200;

function makeRng(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state * 1664525 + 1013904223) >>> 0;
		return state / 4294967296;
	};
}

let sink = 0;

function timeNs(fn: () => void, iterations = ITERATIONS, warmup = WARMUP): { ns: number; iterations: number } {
	for (let i = 0; i < warmup; i += 1) fn();
	const start = Bun.nanoseconds();
	for (let i = 0; i < iterations; i += 1) fn();
	return { ns: (Bun.nanoseconds() - start) / iterations, iterations };
}

interface Row {
	kernel: string;
	count: number;
	tsNs: number;
	nativeNs: number;
	speedup: number;
	tsIterations: number;
	nativeIterations: number;
}

function pushRow(
	kernel: string,
	count: number,
	ts: { ns: number; iterations: number },
	native: { ns: number; iterations: number },
): void {
	rows.push({
		kernel,
		count,
		tsNs: ts.ns,
		nativeNs: native.ns,
		speedup: ts.ns / native.ns,
		tsIterations: ts.iterations,
		nativeIterations: native.iterations,
	});
}

const rows: Row[] = [];
const rng = makeRng(0xbe4c4);

// vectorIndexTopK is measured through the public wrapper searchExactVectorIndex,
// so the native side pays the production per-call query conversion, guards, and
// hit-array construction. The TS side replicates the pre-native wrapper body.
for (const count of COUNTS) {
	const matrix = new Float32Array(count * DIM);
	for (let i = 0; i < matrix.length; i += 1) matrix[i] = rng() * 2 - 1;
	const queryArr: number[] = Array.from({ length: DIM }, () => rng() * 2 - 1);
	const ids: number[] = Array.from({ length: count }, (_v, i) => i);
	const index = { ids, matrix, dimensions: DIM, count };
	const limit = 10;

	const ts = timeNs(() => {
		let queryNormSq = 0;
		for (const value of queryArr) queryNormSq += value * value;
		const queryNorm = Math.sqrt(queryNormSq);
		const hits: Array<{ id: number; score: number }> = [];
		for (let row = 0; row < count; row += 1) {
			const offset = row * DIM;
			let score = 0;
			for (let col = 0; col < DIM; col += 1) {
				score += (matrix[offset + col] ?? 0) * ((queryArr[col] ?? 0) / queryNorm);
			}
			hits.push({ id: ids[row] ?? 0, score });
		}
		hits.sort((a, b) => b.score - a.score);
		sink += hits.slice(0, limit)[0]?.score ?? 0;
	});
	const native = timeNs(() => {
		sink += searchExactVectorIndex(index, queryArr, limit)[0]?.score ?? 0;
	});
	pushRow("searchExactVectorIndex (topK wrapper)", count, ts, native);
}

// cosineSimilarityPairs: O(n²) pair scan. The TS baseline is the pre-native
// clusterBySimilarity loop over per-item vectors; the native side pays the
// production flatten (dim scan + Float64Array fill) before crossing. Capped at
// 1k candidates with adaptive iterations (the TS side at n=1000 is ~500k pair
// cosines × 384 dims per run).
for (const count of COUNTS.filter(n => n <= 1000)) {
	const vectors: number[][] = Array.from({ length: count }, () => Array.from({ length: DIM }, () => rng() * 2 - 1));
	const threshold = 0.15;

	const pairIterations = count >= 1000 ? 10 : ITERATIONS;
	const pairWarmup = count >= 1000 ? 2 : WARMUP;
	const ts = timeNs(
		() => {
			// Pre-native clusterBySimilarity: adjacency unions built inline
			// during the pair scan.
			const adjacency: number[][] = Array.from({ length: count }, () => []);
			for (let i = 0; i < count; i += 1) {
				const a = vectors[i] ?? [];
				for (let j = i + 1; j < count; j += 1) {
					if (cosineSimilarity(a, vectors[j] ?? []) >= threshold) {
						adjacency[i]?.push(j);
						adjacency[j]?.push(i);
					}
				}
			}
			sink += adjacency[0]?.length ?? 0;
		},
		pairIterations,
		pairWarmup,
	);
	const native = timeNs(
		() => {
			// Current clusterBySimilarity: flatten, one crossing, then adjacency
			// built from the materialized pair list.
			let dim = 0;
			for (const vector of vectors) if (vector.length > dim) dim = vector.length;
			const flat = new Float64Array(vectors.length * dim);
			for (let i = 0; i < vectors.length; i += 1) {
				const vector = vectors[i];
				if (vector === undefined) continue;
				for (let col = 0; col < vector.length; col += 1) flat[i * dim + col] = vector[col] ?? 0;
			}
			const pairs = cosineSimilarityPairs(flat, vectors.length, dim, threshold);
			const adjacency: number[][] = Array.from({ length: count }, () => []);
			for (let p = 0; p < pairs.length; p += 2) {
				adjacency[pairs[p] ?? 0]?.push(pairs[p + 1] ?? 0);
				adjacency[pairs[p + 1] ?? 0]?.push(pairs[p] ?? 0);
			}
			sink += adjacency[0]?.length ?? 0;
		},
		pairIterations,
		pairWarmup,
	);
	pushRow("cosineSimilarityPairs (incl. flatten+adjacency)", count, ts, native);
}

// mmrRerank production paths: the TS side wraps jaccardSimilarity in a lambda,
// defeating the identity check so the exact pre-native selection loop runs; the
// native side calls mmrRerank with the default similarity, exercising the real
// fast path including its sort and wrapper overhead.
const tsJaccard = (a: string, b: string): number => jaccardSimilarity(a, b);
for (const count of COUNTS.filter(n => n <= 1000)) {
	const words = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta", "iota", "kappa"];
	const results: Array<{ content: string; score: number }> = [];
	for (let i = 0; i < count; i += 1) {
		const n = 5 + Math.floor(rng() * 20);
		results.push({
			content: Array.from({ length: n }, () => words[Math.floor(rng() * words.length)]).join(" "),
			score: rng(),
		});
	}
	const topK = 10;

	const ts = timeNs(() => {
		sink += mmrRerank(results, 0.7, topK, tsJaccard).length;
	});
	const native = timeNs(() => {
		sink += mmrRerank(results, 0.7, topK).length;
	});
	pushRow("mmrRerankIndices (via mmrRerank)", count, ts, native);
}

const sha = Bun.env.BENCH_SHA ?? Bun.spawnSync(["git", "rev-parse", "HEAD"]).stdout.toString().trim();
const report = {
	sha,
	date: new Date().toISOString(),
	scenario: `dim=${DIM}, stride=${STRIDE}B, warmup=${WARMUP}, iterations=${ITERATIONS} (adaptive for O(n²) rows, see per-row fields), crossing-inclusive`,
	runtime: `bun ${Bun.version}`,
	host: `${os.cpus()[0]?.model ?? "unknown"}, ${os.platform()}-${os.arch()}`,
	rows: rows.map(r => ({
		kernel: r.kernel,
		count: r.count,
		ts_us: +(r.tsNs / 1000).toFixed(2),
		native_us: +(r.nativeNs / 1000).toFixed(2),
		speedup: +r.speedup.toFixed(2),
		ts_iterations: r.tsIterations,
		native_iterations: r.nativeIterations,
	})),
	sink,
};

console.log(JSON.stringify(report, null, 2));
