/** Protocol runner: ingests each case into an engine, recalls every question, maps hits back to message ids and scores them. */
import * as fs from "node:fs/promises";
import * as path from "node:path";
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
}

export interface RunConfig {
	dataset: DatasetName;
	datasetRevision: string;
	engine: EngineName;
	engineInfo: Record<string, string>;
	protocol: ProtocolName;
	k: number;
	/** How the mnemopi engine recalls (`--mnemopi-recall`); recorded for every engine, used by mnemopi only. */
	mnemopiRecall: MnemopiRecall;
	/** Polyphonic recall (`--polyphonic`), mnemopi and mnemosyne only. */
	polyphonic: boolean;
	gitCommit: string;
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
}

export interface RunOutput {
	questions: QuestionResult[];
	warmupMs: number;
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
	return {
		messageIds: prefixes.filter(p => content.includes(p.prefix)).map(p => p.messageId),
		viaFallback: true,
	};
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
	const warmupStart = performance.now();
	await engine.warmup(protocol);
	const warmupMs = performance.now() - warmupStart;

	const questions: QuestionResult[] = [];
	for (const [caseIndex, evalCase] of cases.entries()) {
		// The index, never the dataset's case id: an id such as `..` would put the store, and its deletion, outside storeRoot.
		const storeDir = path.join(storeRoot, String(caseIndex));
		await fs.mkdir(storeDir, { recursive: true });
		await engine.open(evalCase, { storeDir, protocol });

		const messages: EvalMessage[] = evalCase.messages.filter(isRememberable);
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
				if (engineId === null) continue;
				const ids = idMap.get(engineId);
				if (ids) ids.push(batch[j].messageId);
				else idMap.set(engineId, [batch[j].messageId]);
			}
		}
		if (protocol === "with-sleep") await engine.sleep();
		if (caseIndex === 0 && protocol !== "fts-only" && (await engine.vectorCount()) <= 0) {
			throw new Error(`embeddings unavailable for ${engine.name}`);
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
				ranked,
				dropped,
				latencyMs,
				fetchK: engine.lastFetchK?.(),
				...scoreQuestion(evalCase, question.goldMessageIds, ranked),
			});
		}

		await engine.close();
		await fs.rm(storeDir, { recursive: true, force: true });
	}

	return { questions, warmupMs };
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
	};
}
