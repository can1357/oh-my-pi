/**
 * Cost of one local embedding with and without the embedding session's thread
 * budget ({@link applyEmbedSessionBudget}), plus a parity check of the vectors
 * the two sessions produce.
 *
 * Without the budget, fastembed leaves onnxruntime's defaults in place: one
 * spinning intra-op thread per core. The baseline session below is that
 * configuration, so this script is the measurement behind the budget.
 *
 * Run from the repo root (downloads the model into omp's shared fastembed cache
 * on first use): `bun packages/mnemopi/bench/embed-session-threads.bench.ts`
 * `MNEMOPI_EMBEDDING_MODEL` selects another bundled model.
 */
import { createRequire } from "node:module";
import * as os from "node:os";
import { getFastembedCacheDir } from "@oh-my-pi/pi-utils";
import type * as Fastembed from "fastembed";
import type * as Ort from "onnxruntime-node";
import { currentEmbeddingModel, fastembedModelName } from "../src/core/embeddings";
import { applyEmbedSessionBudget } from "../src/core/fastembed-runtime";

const QUERIES = [
	"what did we decide about the embedding worker thread budget?",
	"where does the shared embedding server keep its socket?",
	"which memories were retained for this project yesterday?",
	"how is the recall block budgeted against the prompt?",
	"who owns the release claim for the current cut?",
];
const ITERATIONS = 20;
/**
 * Parity floor between the two sessions. A smaller thread pool partitions the
 * same matrix multiplications differently, so individual components move in
 * the last few decimal places; what recall depends on is the direction of the
 * vector, which must stay the same.
 */
const PARITY_COSINE_FLOOR = 0.999999;

interface Measurement {
	label: string;
	wallMsPerQuery: number;
	cpuSecondsPerQuery: number;
	coresBusy: number;
	vectors: number[][];
}

async function embedOnce(model: Fastembed.FlagEmbedding, text: string): Promise<number[]> {
	for await (const batch of model.embed([text])) {
		const vector = batch[0];
		if (vector !== undefined) return [...vector];
	}
	throw new Error(`embedding produced no vector for ${JSON.stringify(text)}`);
}

async function measure(label: string, model: Fastembed.FlagEmbedding): Promise<Measurement> {
	for (const text of QUERIES) await embedOnce(model, text);
	const vectors: number[][] = [];
	const cpuBefore = process.cpuUsage();
	const wallBefore = Bun.nanoseconds();
	for (let i = 0; i < ITERATIONS; i += 1) {
		const text = QUERIES[i % QUERIES.length] ?? QUERIES[0];
		const vector = await embedOnce(model, text as string);
		if (i < QUERIES.length) vectors.push(vector);
	}
	const wallSeconds = (Bun.nanoseconds() - wallBefore) / 1e9;
	const cpu = process.cpuUsage(cpuBefore);
	const cpuSeconds = (cpu.user + cpu.system) / 1e6;
	return {
		label,
		wallMsPerQuery: (wallSeconds / ITERATIONS) * 1000,
		cpuSecondsPerQuery: cpuSeconds / ITERATIONS,
		coresBusy: cpuSeconds / wallSeconds,
		vectors,
	};
}

const requireBench = createRequire(import.meta.url);
const fastembedEntry = requireBench.resolve("fastembed");
const fastembed: typeof Fastembed = requireBench(fastembedEntry);
// The ORT copy fastembed's own dependency graph loads; a sibling copy of a
// different version fails to link against the library fastembed already opened.
const ort: typeof Ort = createRequire(fastembedEntry)("onnxruntime-node");
const modelName = fastembedModelName(currentEmbeddingModel());
if (modelName === null) throw new Error(`no bundled fastembed model for ${currentEmbeddingModel()}`);
const cacheDir = getFastembedCacheDir();
const initOptions = {
	model: modelName as Fastembed.EmbeddingModel,
	cacheDir,
	showDownloadProgress: false,
};

const baseline = await measure("onnxruntime defaults", await fastembed.FlagEmbedding.init(initOptions));
const release = applyEmbedSessionBudget(ort, os.availableParallelism(), cacheDir);
const budgeted = await measure("thread budget", await fastembed.FlagEmbedding.init(initOptions));
release();

let maxDelta = 0;
let minCosine = 1;
for (const [index, vector] of baseline.vectors.entries()) {
	const other = budgeted.vectors[index] ?? [];
	let dot = 0;
	let leftNorm = 0;
	let rightNorm = 0;
	for (const [component, value] of vector.entries()) {
		const otherValue = other[component] ?? 0;
		maxDelta = Math.max(maxDelta, Math.abs(value - otherValue));
		dot += value * otherValue;
		leftNorm += value * value;
		rightNorm += otherValue * otherValue;
	}
	minCosine = Math.min(minCosine, dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm)));
}

console.log(`model ${modelName} · ${os.availableParallelism()} available cores · ${ITERATIONS} queries each`);
console.table(
	[baseline, budgeted].map(row => ({
		session: row.label,
		"wall ms/query": row.wallMsPerQuery.toFixed(1),
		"CPU s/query": row.cpuSecondsPerQuery.toFixed(3),
		"cores busy": row.coresBusy.toFixed(1),
	})),
);
console.log(
	`CPU per query: ${(baseline.cpuSecondsPerQuery / budgeted.cpuSecondsPerQuery).toFixed(1)}x cheaper · lowest cosine ${minCosine.toFixed(9)} · max component delta ${maxDelta.toExponential(2)}`,
);
if (minCosine < PARITY_COSINE_FLOOR) {
	throw new Error(`budgeted vectors turned: cosine ${minCosine.toFixed(9)}, below ${PARITY_COSINE_FLOOR}`);
}
