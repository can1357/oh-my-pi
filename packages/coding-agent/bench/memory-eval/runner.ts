/** Protocol runner: ingests each case into an engine, recalls every question, maps hits back to message ids and scores them. */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import { isRememberable } from "./datasets";
import type { EngineAdapter, EngineName, MnemopiRecall, ProtocolName, RecallHit, RememberItem } from "./engine";
import { cp, lmeMetrics, messageLevelMetrics } from "./score";
import type { DatasetName, EvalCase, EvalMessage, ExcludedQuestion } from "./types";

export interface RankedHit {
	messageIds: string[];
	tier: RecallHit["tier"];
	viaFallback: boolean;
	contentPrefix: string;
}

/** A row the engine returned but the runner does not rank; `gold` when it maps to a gold message. */
export interface DroppedHit {
	tier: string;
	messageIds: string[];
	rank: number;
	gold: boolean;
}

export interface QuestionResult {
	caseId: string;
	questionId: string;
	category: string;
	ranked: RankedHit[];
	dropped: DroppedHit[];
	metrics: Record<string, number>;
	latencyMs: number;
	/** The largest `top_k` the engine was asked for, when it widens past `k` (Mnemosyne; diagnostic). */
	fetchK?: number;
	lme?: { corpusIds: string[]; correctDocs: string[]; rankings: number[] };
	compat?: { question: string; rankedContents: string[]; goldContents: string[] };
	/** Hash of the searched corpus, query text and sorted gold ids, so `diff` can tell a changed question from a re-run; absent in older files. */
	definitionHash?: string;
}

export interface RunConfig {
	dataset: DatasetName;
	datasetRevision: string;
	/** SHA-256 of the prepared dataset file; `diff` refuses differing digests. Absent in older files. */
	datasetSha256?: string;
	/** upstream-compat only: `corpusSha256` of the conversations ingested, which calibration-check compares with Run A. */
	corpusSha256?: string;
	engine: EngineName;
	engineInfo: Record<string, string>;
	protocol: ProtocolName;
	k: number;
	/** How the mnemopi engine recalls (`--mnemopi-recall`); recorded for every engine, used by mnemopi only. */
	mnemopiRecall: MnemopiRecall;
	/** Polyphonic recall (`--polyphonic`), mnemopi and mnemosyne only. */
	polyphonic: boolean;
	gitCommit: string;
	/** Uncommitted or untracked changes at the start of the run: `gitCommit` alone does not name the code that ran. */
	gitDirty: boolean;
	/**
	 * Hash of the harness's own code (ingestion, hit mapping, scoring, engine adapters): `diff` refuses to pair runs
	 * scored by different harness code, whatever engine code each ran. Absent in older files.
	 */
	harnessHash?: string;
	startedAt: string;
}

export interface ResultFile {
	config: RunConfig;
	questions: QuestionResult[];
	aggregate: Record<string, number>;
	perCategory: Record<string, Record<string, number>>;
	fallbackRate: number;
	droppedRows: number;
	droppedGoldRows: number;
	/** Engine start, imports and model load, before the first case (0 for upstream-compat, which has no warmup). */
	warmupMs: number;
	excluded: ExcludedQuestion[];
	/** Messages the engine declined to store (`remember` returned null); their gold questions score them as misses. */
	unstoredMessages: UnstoredMessage[];
}

/** A message id is unique only within its case. */
export interface UnstoredMessage {
	caseId: string;
	messageId: string;
}

export interface RunOutput {
	questions: QuestionResult[];
	warmupMs: number;
	unstoredMessages: UnstoredMessage[];
}

const REMEMBER_BATCH = 500;
const CONTENT_PREFIX_CHARS = 80;
const FALLBACK_PREFIX_CHARS = 50;
/** A shorter prefix is a whole short message ("ok", "yes"), which an unrelated hit can easily contain. */
const MIN_FALLBACK_PREFIX_CHARS = 20;

const isBeam = (dataset: DatasetName): boolean => dataset.startsWith("beam");

export function primaryMetric(dataset: DatasetName): "recall@10" | "session.recall_all@5" {
	return isBeam(dataset) ? "recall@10" : "session.recall_all@5";
}

const normalize = (s: string): string => s.toLowerCase().replace(/\s+/g, " ").trim();

interface MappedHit {
	messageIds: string[];
	viaFallback: boolean;
}

/** Engine row id, else the rows it summarises, else a content-prefix match against the case's messages. */
function mapHit(
	hit: { engineId: string; content: string; summaryOf: readonly string[] },
	idMap: ReadonlyMap<string, string[]>,
	prefixes: readonly { messageId: string; prefix: string }[],
): MappedHit {
	const direct = idMap.get(hit.engineId);
	if (direct) return { messageIds: [...direct], viaFallback: false };
	const viaSummary = [...new Set(hit.summaryOf.flatMap(id => idMap.get(id) ?? []))];
	if (viaSummary.length > 0) return { messageIds: viaSummary, viaFallback: false };
	const content = normalize(hit.content);
	const messageIds = prefixes.filter(p => content.includes(p.prefix)).map(p => p.messageId);
	// A hit the fallback could not map is unmapped, not a fallback match.
	return { messageIds, viaFallback: messageIds.length > 0 };
}

function scoreQuestion(
	evalCase: EvalCase,
	goldMessageIds: readonly string[],
	ranked: readonly RankedHit[],
): Pick<QuestionResult, "metrics" | "lme"> {
	if (isBeam(evalCase.dataset)) {
		return {
			metrics: {
				...messageLevelMetrics(
					ranked.map(r => r.messageIds),
					goldMessageIds,
				),
			},
		};
	}
	const corpusIds = evalCase.messages.map(m => m.messageId);
	const indexOf = new Map(corpusIds.map((id, i) => [id, i]));
	const rankings: number[] = [];
	const seen = new Set<number>();
	for (const hit of ranked) {
		// An unmapped hit still took a rank: score it as a non-gold document in a session of its own, appended to the
		// corpus (the official scorer reads rankings as corpus indices).
		if (hit.messageIds.length === 0) {
			rankings.push(corpusIds.length);
			corpusIds.push(`<unmapped ${corpusIds.length}>_0`);
			continue;
		}
		for (const id of hit.messageIds) {
			const index = indexOf.get(id);
			if (index === undefined || seen.has(index)) continue;
			seen.add(index);
			rankings.push(index);
		}
	}
	const correctDocs = [...goldMessageIds];
	return { metrics: lmeMetrics(rankings, correctDocs, corpusIds), lme: { corpusIds, correctDocs, rankings } };
}

export async function runCases(
	engine: EngineAdapter,
	cases: readonly EvalCase[],
	protocol: Exclude<ProtocolName, "upstream-compat">,
	k: number,
	storeRoot: string,
): Promise<RunOutput> {
	// A summary hit covers several messages; LongMemEval ranks each as its own corpus document, so one summary could
	// push its own gold session out of @5. BEAM credits the summary in one slot.
	if (protocol === "with-sleep" && cases.some(c => !isBeam(c.dataset))) {
		throw new Error("with-sleep does not support LongMemEval datasets; use a BEAM dataset");
	}
	const warmupStart = performance.now();
	await engine.warmup(protocol);
	const warmupMs = performance.now() - warmupStart;

	const questions: QuestionResult[] = [];
	const unstoredMessages: UnstoredMessage[] = [];
	for (const [caseIndex, evalCase] of cases.entries()) {
		// The index, never the dataset's case id: an id such as `..` would put the store, and its deletion, outside storeRoot.
		const storeDir = path.join(storeRoot, String(caseIndex));
		await fs.mkdir(storeDir, { recursive: true });
		await engine.open(evalCase, { storeDir, protocol });

		const messages: EvalMessage[] = evalCase.messages.filter(isRememberable);
		const corpusHash = Bun.hash(JSON.stringify(messages.map(m => [m.messageId, m.role, m.content]))).toString(16);
		const idMap = new Map<string, string[]>();
		for (let i = 0; i < messages.length; i += REMEMBER_BATCH) {
			const batch = messages.slice(i, i + REMEMBER_BATCH);
			const items: RememberItem[] = batch.map(m => ({
				messageId: m.messageId,
				content: m.content,
				source: m.role,
				importance: 0.5,
			}));
			const engineIds = await engine.remember(items);
			for (const [j, engineId] of engineIds.entries()) {
				// The engine chose not to store it (Mnemosyne's write policy can); a miss on it is the engine's, but recorded.
				if (engineId === null) {
					unstoredMessages.push({ caseId: evalCase.caseId, messageId: batch[j].messageId });
					continue;
				}
				const ids = idMap.get(engineId);
				if (ids) ids.push(batch[j].messageId);
				else idMap.set(engineId, [batch[j].messageId]);
			}
		}
		// Before sleep the store holds only the rows remember() returned, so fewer vectors than rows means a gap.
		// shortcut: a count, not a per-id check; an engine that embedded extra rows could hide a gap, then check ids.
		if (protocol !== "fts-only") {
			const vectors = await engine.vectorCount();
			if (vectors < idMap.size) {
				throw new Error(
					`embeddings unavailable for ${engine.name}: ${idMap.size - vectors} of ${idMap.size} remembered rows in case ${evalCase.caseId} have no vector`,
				);
			}
		}
		if (protocol === "with-sleep") {
			await engine.sleep();
			// Sleep embeds its summaries in the background and Mnemopi swallows failures, so check them before recall.
			const missing = await engine.unembeddedSummaries();
			if (missing > 0) {
				throw new Error(
					`embeddings unavailable for ${engine.name}: ${missing} ${missing === 1 ? "summary" : "summaries"} written by sleep in case ${evalCase.caseId} ${missing === 1 ? "has" : "have"} no vector`,
				);
			}
		}

		const prefixes = messages
			.map(m => ({ messageId: m.messageId, prefix: normalize(cp(m.content, FALLBACK_PREFIX_CHARS)) }))
			.filter(p => Array.from(p.prefix).length >= MIN_FALLBACK_PREFIX_CHARS);
		// LongMemEval's session metrics widen past the turn cutoff until they see enough distinct sessions, and the
		// official retrieval runner ranks the whole corpus, so LongMemEval asks for that; BEAM scores the top k.
		const depth = isBeam(evalCase.dataset) ? k : Math.max(k, evalCase.messages.length);
		for (const question of evalCase.questions) {
			const start = performance.now();
			const hits = await engine.recall(question, depth);
			const latencyMs = performance.now() - start;
			const ranked: RankedHit[] = hits.map(hit => ({
				...mapHit(hit, idMap, prefixes),
				tier: hit.tier,
				contentPrefix: cp(hit.content, CONTENT_PREFIX_CHARS),
			}));
			const gold = new Set(question.goldMessageIds);
			const dropped: DroppedHit[] = (engine.lastDropped?.() ?? []).map(row => {
				const messageIds = row.sourceMemoryId === null ? [] : [...(idMap.get(row.sourceMemoryId) ?? [])];
				return { tier: row.tier, messageIds, rank: row.rank, gold: messageIds.some(id => gold.has(id)) };
			});
			questions.push({
				caseId: evalCase.caseId,
				questionId: question.questionId,
				category: question.category,
				definitionHash: Bun.hash(
					JSON.stringify([corpusHash, question.text, question.goldMessageIds.toSorted()]),
				).toString(16),
				ranked,
				dropped,
				latencyMs,
				fetchK: engine.lastFetchK?.(),
				...scoreQuestion(evalCase, question.goldMessageIds, ranked),
			});
		}

		await engine.close();
		// A store left behind costs disk space; losing the results of a multi-day run costs the run.
		await removeWithRetries(storeDir).catch(err => console.warn(`could not remove ${storeDir}: ${err}`));
	}

	return { questions, warmupMs, unstoredMessages };
}

function means(rows: readonly Record<string, number>[]): Record<string, number> {
	const sums: Record<string, number> = {};
	for (const row of rows) for (const [key, value] of Object.entries(row)) sums[key] = (sums[key] ?? 0) + value;
	return Object.fromEntries(Object.entries(sums).map(([key, sum]) => [key, sum / rows.length]));
}

/** Nearest-rank percentile of an ascending-sorted array. */
const percentile = (sorted: readonly number[], p: number): number =>
	sorted.length === 0 ? 0 : sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)];

export function buildResultFile(config: RunConfig, run: RunOutput, excluded: ExcludedQuestion[]): ResultFile {
	const { questions } = run;
	const latencies = questions.map(q => q.latencyMs).sort((a, b) => a - b);
	const byCategory: Record<string, Record<string, number>[]> = {};
	for (const q of questions) (byCategory[q.category] ??= []).push(q.metrics);
	const hits = questions.flatMap(q => q.ranked);
	const dropped = questions.flatMap(q => q.dropped);
	return {
		config,
		questions,
		aggregate: {
			...means(questions.map(q => q.metrics)),
			"latency.p50": percentile(latencies, 0.5),
			"latency.p95": percentile(latencies, 0.95),
		},
		perCategory: Object.fromEntries(Object.entries(byCategory).map(([cat, rows]) => [cat, means(rows)])),
		fallbackRate: hits.length === 0 ? 0 : hits.filter(h => h.viaFallback).length / hits.length,
		droppedRows: dropped.length,
		droppedGoldRows: dropped.filter(d => d.gold).length,
		warmupMs: run.warmupMs,
		excluded,
		unstoredMessages: run.unstoredMessages,
	};
}
