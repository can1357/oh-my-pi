/** Run B of the upstream calibration: replays upstream Mnemosyne's `benchmark_mnemosyne` through the engine adapter. */
import * as fs from "node:fs/promises";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import * as os from "node:os";
import * as path from "node:path";
import type { EngineAdapter, RememberItem } from "./engine";
import type { UpstreamCompatOps } from "./engines/mnemosyne";
import type { QuestionResult, ResultFile } from "./runner";
import { compatRecall, cp } from "./score";
import type { UpstreamCompatConversation } from "./types";

const TOP_K = 10;
const REMEMBER_BATCH = 500;
const CONSOLIDATE_ROWS = 200;
const SUMMARY_ROWS = 5;
const SUMMARY_ROW_CHARS = 80;
const SUMMARY_CHARS = 500;

/** Run A's dump (`py/upstream_run_a.py`). */
export interface CalibrationDump {
	questions: {
		conversation: number;
		question: string;
		/** Upstream's gold message contents ("" for an index past the conversation); absent in older dumps. */
		goldContents?: string[];
		rankedContents: string[];
		recall: number;
	}[];
	meanRecall: number;
	/** `corpusSha256` of the conversations upstream's loader produced (`py/model_digest.py`); absent in older dumps. */
	corpusSha256?: string;
	/** The model files Run A loaded (`py/model_digest.py`); absent in dumps from before it was recorded. */
	embeddingModelSha256?: string;
	/** `fastembed_version` and `onnxruntime_version` of Run A's venv, under Run B's `engineInfo` names; may be absent. */
	runtime?: Record<string, string>;
}

/** One store and one session for every conversation, ingested, consolidated and queried exactly as upstream does. */
export async function runUpstreamCompat(
	engine: EngineAdapter & UpstreamCompatOps,
	conversations: readonly UpstreamCompatConversation[],
): Promise<QuestionResult[]> {
	const storeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "memory-eval-compat-"));
	try {
		await engine.open(
			{ caseId: "upstream-compat", dataset: "beam-100k", messages: [], questions: [] },
			{ storeDir: storeRoot, protocol: "upstream-compat" },
		);

		const items: RememberItem[] = [];
		for (const conv of conversations) {
			for (const content of conv.messages) {
				if (content.trim() === "") continue;
				items.push({ messageId: String(items.length), content, source: "bench", importance: 0.5 });
			}
		}
		const ids = new Set<string>();
		for (let i = 0; i < items.length; i += REMEMBER_BATCH) {
			for (const id of await engine.remember(items.slice(i, i + REMEMBER_BATCH))) if (id !== null) ids.add(id);
		}
		// Without vectors on every row the FTS-only fallback would calibrate a mixed store, or pass vacuously.
		const covered = await engine.vectorCoverage([...ids]);
		if (ids.size === 0 || covered < ids.size) {
			throw new Error(
				`embeddings unavailable for ${engine.name}: ${ids.size - covered} of ${ids.size} remembered rows have no vector`,
			);
		}

		const rows = await engine.oldestWorking(CONSOLIDATE_ROWS);
		if (rows.length > 0) {
			const summary = cp(
				rows
					.slice(0, SUMMARY_ROWS)
					.map(r => cp(r.content, SUMMARY_ROW_CHARS))
					.join(" | "),
				SUMMARY_CHARS,
			);
			const summaryId = await engine.consolidate(
				summary,
				rows.map(r => r.engineId),
				"bench_consolidation",
				0.4,
				"global",
			);
			if (summaryId === null || (await engine.vectorCoverage([summaryId])) < 1) {
				throw new Error(
					`embeddings unavailable for ${engine.name}: the consolidated summary ${summaryId} has no vector`,
				);
			}
		}

		const results: QuestionResult[] = [];
		for (const [conversation, conv] of conversations.entries()) {
			for (const [index, q] of conv.questions.entries()) {
				if (q.text === "" || q.goldIndices.length === 0) continue;
				const start = performance.now();
				const rankedContents = await engine.recallRaw(q.text, TOP_K);
				const latencyMs = performance.now() - start;
				// Upstream keeps gold as a set, divides by its size, and only matches indices inside the conversation.
				const goldContents = [...new Set(q.goldIndices)].map(i =>
					i < conv.messages.length ? conv.messages[i] : "",
				);
				results.push({
					caseId: "upstream-compat",
					questionId: `${conversation}:${index}`,
					category: "upstream-compat",
					ranked: [],
					dropped: [],
					metrics: { "compat.recall@10": compatRecall(rankedContents, goldContents, TOP_K) },
					latencyMs,
					compat: { question: q.text, rankedContents, goldContents },
				});
			}
		}
		await engine.close();
		return results;
	} finally {
		await removeWithRetries(storeRoot).catch(err => console.warn(`could not remove ${storeRoot}: ${err}`));
	}
}

/**
 * SHA-256 over each conversation's message count, then each message as `<utf-8 byte length>\n<bytes>`, in order. Must
 * match `corpus_digest` in py/model_digest.py, so Run A and Run B can show they ingested the same corpus.
 */
export function corpusSha256(conversations: readonly { messages: readonly string[] }[]): string {
	const hasher = new Bun.CryptoHasher("sha256");
	const encoder = new TextEncoder();
	for (const { messages } of conversations) {
		hasher.update(`${messages.length}\n`);
		for (const message of messages) {
			const bytes = encoder.encode(message);
			hasher.update(`${bytes.length}\n`);
			hasher.update(bytes);
		}
	}
	return hasher.digest("hex");
}

// Means are averages of identical per-question floats; only summation order can differ.
const MEAN_TOLERANCE = 1e-9;

/** Mismatches between Run A's dump and Run B's result file, paired by position. Empty means calibrated. */
export function compareCalibration(
	a: CalibrationDump,
	b: Pick<ResultFile, "questions" | "aggregate"> & {
		config: { engineInfo: Record<string, string>; corpusSha256?: string };
	},
): string[] {
	const mismatches: string[] = [];
	// A store that differs only outside every top ten leaves rankings, recalls and gold equal: compare the corpus.
	const corpusA = a.corpusSha256;
	const corpusB = b.config.corpusSha256;
	if (!corpusA || !corpusB) {
		mismatches.push(`corpus: ${corpusA ? "B" : "A"} records no corpus digest; re-run it with this harness`);
	} else if (corpusA !== corpusB) {
		mismatches.push(`corpus: A ${corpusA.slice(0, 12)}, B ${corpusB.slice(0, 12)}`);
	}
	// Equal rankings from two different models would calibrate nothing: both runs must name the same model files.
	const modelA = a.embeddingModelSha256;
	const modelB = b.config.engineInfo.embedding_model_sha256;
	if (!modelA || !modelB) {
		mismatches.push(`embedding model: ${modelA ? "B" : "A"} records no model digest; re-run it with this harness`);
	} else if (modelA !== modelB) {
		mismatches.push(`embedding model: A ${modelA.slice(0, 12)}, B ${modelB.slice(0, 12)}`);
	}
	// The same model under another numerical runtime can reorder near-ties: both runs must name the same versions.
	for (const key of ["fastembed_version", "onnxruntime_version"]) {
		const [versionA, versionB] = [a.runtime?.[key], b.config.engineInfo[key]];
		if (!versionA || !versionB)
			mismatches.push(`${key}: ${versionA ? "B" : "A"} records none; re-run it with this harness`);
		else if (versionA !== versionB) mismatches.push(`${key}: A ${versionA}, B ${versionB}`);
	}
	if (a.questions.length !== b.questions.length) {
		mismatches.push(`question count: A ${a.questions.length}, B ${b.questions.length}`);
	}
	for (const [i, qa] of a.questions.entries()) {
		const qb = b.questions[i];
		if (!qb) break;
		if (!qb.compat) throw new Error(`B question ${qb.questionId} has no compat data: not an upstream-compat result`);
		const label = `[${i}] conversation ${qa.conversation} "${cp(qa.question, 60)}"`;
		if (!qb.questionId.startsWith(`${qa.conversation}:`)) {
			mismatches.push(`${label}: conversation, A ${qa.conversation}, B questionId ${qb.questionId}`);
		}
		if (qa.question !== qb.compat.question) mismatches.push(`${label}: question text differs`);
		// The same recall from another gold set would pass unnoticed: compare the sets themselves (order-free).
		const goldA = qa.goldContents?.toSorted();
		const goldB = qb.compat.goldContents.toSorted();
		if (!goldA) mismatches.push(`${label}: A records no gold contents; re-run it with this harness`);
		else if (goldA.length !== goldB.length || goldA.some((g, j) => g !== goldB[j])) {
			mismatches.push(`${label}: gold contents differ (A ${goldA.length}, B ${goldB.length})`);
		}
		const rankedA = qa.rankedContents;
		const rankedB = qb.compat.rankedContents;
		const rank = Array.from({ length: Math.max(rankedA.length, rankedB.length) }, (_, r) => r).find(
			r => rankedA[r] !== rankedB[r],
		);
		if (rank !== undefined) {
			const show = (s: string | undefined): string => (s === undefined ? "<none>" : JSON.stringify(cp(s, 80)));
			mismatches.push(
				`${label}: rankedContents (A ${rankedA.length}, B ${rankedB.length}) first differ at rank ${rank}: A ${show(rankedA[rank])} B ${show(rankedB[rank])}`,
			);
		}
		const recallB = qb.metrics["compat.recall@10"];
		if (qa.recall !== recallB) mismatches.push(`${label}: recall A ${qa.recall}, B ${recallB}`);
	}
	const meanB = b.aggregate["compat.recall@10"];
	if (!(Math.abs(a.meanRecall - meanB) <= MEAN_TOLERANCE)) {
		mismatches.push(`meanRecall: A ${a.meanRecall}, B ${meanB}`);
	}
	return mismatches;
}
