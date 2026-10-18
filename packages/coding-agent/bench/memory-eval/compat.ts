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
	questions: { conversation: number; question: string; rankedContents: string[]; recall: number }[];
	meanRecall: number;
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
		for (let i = 0; i < items.length; i += REMEMBER_BATCH) await engine.remember(items.slice(i, i + REMEMBER_BATCH));
		// Without vectors the FTS-only fallback would make the calibration pass vacuously.
		if ((await engine.vectorCount()) <= 0) throw new Error(`embeddings unavailable for ${engine.name}`);

		const rows = await engine.oldestWorking(CONSOLIDATE_ROWS);
		if (rows.length > 0) {
			const summary = cp(
				rows
					.slice(0, SUMMARY_ROWS)
					.map(r => cp(r.content, SUMMARY_ROW_CHARS))
					.join(" | "),
				SUMMARY_CHARS,
			);
			await engine.consolidate(
				summary,
				rows.map(r => r.engineId),
				"bench_consolidation",
				0.4,
				"global",
			);
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

// Means are averages of identical per-question floats; only summation order can differ.
const MEAN_TOLERANCE = 1e-9;

/** Mismatches between Run A's dump and Run B's result file, paired by position. Empty means calibrated. */
export function compareCalibration(a: CalibrationDump, b: Pick<ResultFile, "questions" | "aggregate">): string[] {
	const mismatches: string[] = [];
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
