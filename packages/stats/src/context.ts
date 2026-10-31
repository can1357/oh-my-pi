import * as path from "node:path";
import { getSessionsDir } from "@oh-my-pi/pi-utils";
import { getTimeRangeConfig } from "./aggregator";
import { initDb, unpricedRequestSql } from "./db";
import { extractFolderFromPath } from "./parser";
import type { ContextModelRow, ContextOverview, ContextSessionRow, TimeRange } from "./shared-types";
import { readSessionMetadata } from "./trace";

export {
	buildSessionContextResponse,
	buildSessionContextTimeline,
	CONTEXT_ETAG_VERSION,
	contextFingerprintForEtag,
	type ContextFingerprint,
	type ContextSessionTimelineResult,
} from "./session-context";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const SESSION_LIMIT = 200;

interface RootBucketRow {
	file: string;
	bucket: number;
	requests: number;
	totalTokens: number;
	promptTokens: number;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	costTotal: number;
	unpricedRequests: number;
	peakPromptTokens: number;
	startedAt: number;
	endedAt: number;
	models: string;
}

interface SessionModelRow {
	file: string;
	model: string;
	requests: number;
	totalTokens: number;
	promptTokens: number;
	costTotal: number;
	unpricedRequests: number;
}

/** Normalize a transcript path and fold it to its root session, or null when it escapes. */
function contextRootFile(file: string, sessionsPrefix: string): string | null {
	const normalized = path.normalize(file);
	if (!normalized.startsWith(sessionsPrefix)) return null;
	const segments = normalized.slice(sessionsPrefix.length).split(path.sep);
	if (segments.length < 2 || segments[0]!.length === 0) return null;
	return segments.length === 2 ? normalized : path.join(sessionsPrefix, segments[0]!, `${segments[1]!}.jsonl`);
}

/** Read exact range facts once, then project the same snapshot into all three views. */
export async function getContextOverview(range: TimeRange): Promise<ContextOverview> {
	const database = await initDb();
	const cutoff = getTimeRangeConfig(range).cutoff!;
	const now = Date.now();
	const heatmapBucketMs = range === "30d" || range === "90d" ? DAY_MS : HOUR_MS;
	const sparklineSpan = Math.max(1, Math.ceil((now - cutoff) / 12));
	const sessionsPrefix = `${getSessionsDir()}${path.sep}`;
	// Mirror trace's root derivation: <project>/<root>.jsonl or
	// <project>/<root>/<...child>.jsonl -> <project>/<root>.jsonl.
	// Group at root + bucket granularity so counts, peaks, models, and activity
	// remain exact without reading lifetime session rollups or individual requests.
	const facts = database
		.query<RootBucketRow, Record<string, string | number>>(`
			SELECT session_file AS file, (timestamp / $bucketMs) * $bucketMs AS bucket,
				COUNT(*) AS requests, SUM(total_tokens) AS totalTokens,
				SUM(input_tokens + cache_read_tokens + cache_write_tokens) AS promptTokens,
				SUM(input_tokens) AS inputTokens, SUM(output_tokens) AS outputTokens,
				SUM(cache_read_tokens) AS cacheReadTokens,
				SUM(cache_write_tokens) AS cacheWriteTokens,
				SUM(cost_total) AS costTotal, SUM(${unpricedRequestSql()}) AS unpricedRequests,
				MAX(input_tokens + cache_read_tokens + cache_write_tokens) AS peakPromptTokens,
				MIN(timestamp) AS startedAt, MAX(timestamp) AS endedAt,
				json_group_array(DISTINCT model) AS models
			FROM messages
			WHERE timestamp >= $cutoff AND substr(session_file, 1, length($prefix)) = $prefix
			GROUP BY session_file, bucket
		`)
		.all({ $prefix: sessionsPrefix, $cutoff: cutoff, $bucketMs: heatmapBucketMs });

	const modelFacts = database
		.query<SessionModelRow, Record<string, string | number>>(`
			SELECT session_file AS file, model,
				COUNT(*) AS requests, SUM(total_tokens) AS totalTokens,
				SUM(input_tokens + cache_read_tokens + cache_write_tokens) AS promptTokens,
				SUM(cost_total) AS costTotal, SUM(${unpricedRequestSql()}) AS unpricedRequests
			FROM messages
			WHERE timestamp >= $cutoff AND substr(session_file, 1, length($prefix)) = $prefix
			GROUP BY session_file, model
		`)
		.all({ $prefix: sessionsPrefix, $cutoff: cutoff });

	const byRoot = new Map<string, ContextSessionRow & { modelSet: Set<string>; sparkline: number[] }>();
	const byBucket = new Map<number, ContextOverview["heatmap"][number]>();
	const byModel = new Map<string, ContextModelRow>();
	const kpi: ContextOverview["kpi"] = {
		sessions: 0,
		requests: 0,
		avgPromptTokens: 0,
		peakPromptTokens: 0,
		totalTokens: 0,
		promptTokens: 0,
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		cacheRate: 0,
		costTotal: 0,
		unpricedRequests: 0,
	};
	let promptTokens = 0;
	for (const rawFact of facts) {
		const file = contextRootFile(rawFact.file, sessionsPrefix);
		if (!file) continue;
		const fact = { ...rawFact, file };
		kpi.requests += fact.requests;
		kpi.totalTokens += fact.totalTokens;
		kpi.promptTokens += fact.promptTokens;
		kpi.inputTokens += fact.inputTokens;
		kpi.outputTokens += fact.outputTokens;
		kpi.cacheReadTokens += fact.cacheReadTokens;
		kpi.cacheWriteTokens += fact.cacheWriteTokens;
		kpi.costTotal += fact.costTotal;
		kpi.unpricedRequests += fact.unpricedRequests;
		kpi.peakPromptTokens = Math.max(kpi.peakPromptTokens, fact.peakPromptTokens);
		promptTokens += fact.promptTokens;
		let bucket = byBucket.get(fact.bucket);
		if (!bucket) {
			bucket = {
				bucket: fact.bucket,
				requests: 0,
				promptTokens: 0,
				outputTokens: 0,
				totalTokens: 0,
				costTotal: 0,
				unpricedRequests: 0,
			};
			byBucket.set(fact.bucket, bucket);
		}
		bucket.requests += fact.requests;
		bucket.promptTokens += fact.promptTokens;
		bucket.outputTokens += fact.outputTokens;
		bucket.totalTokens += fact.totalTokens;
		bucket.costTotal += fact.costTotal;
		bucket.unpricedRequests += fact.unpricedRequests;

		let session = byRoot.get(fact.file);
		if (!session) {
			session = {
				file: fact.file,
				folder: extractFolderFromPath(fact.file),
				title: null,
				models: [],
				modelSet: new Set(),
				startedAt: fact.startedAt,
				endedAt: fact.endedAt,
				requests: 0,
				totalTokens: 0,
				promptTokens: 0,
				inputTokens: 0,
				outputTokens: 0,
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
				costTotal: 0,
				unpricedRequests: 0,
				peakPromptTokens: 0,
				avgPromptTokens: 0,
				sparkline: Array.from({ length: 12 }, () => 0),
			};
			byRoot.set(fact.file, session);
		}
		session.requests += fact.requests;
		session.totalTokens += fact.totalTokens;
		session.promptTokens += fact.promptTokens;
		session.inputTokens += fact.inputTokens;
		session.outputTokens += fact.outputTokens;
		session.cacheReadTokens += fact.cacheReadTokens;
		session.cacheWriteTokens += fact.cacheWriteTokens;
		session.costTotal += fact.costTotal;
		session.unpricedRequests += fact.unpricedRequests;
		session.peakPromptTokens = Math.max(session.peakPromptTokens, fact.peakPromptTokens);
		session.startedAt = Math.min(session.startedAt, fact.startedAt);
		session.endedAt = Math.max(session.endedAt, fact.endedAt);
		const sparkIndex = Math.min(11, Math.max(0, Math.floor((fact.bucket - cutoff) / sparklineSpan)));
		session.sparkline[sparkIndex] += fact.promptTokens;
		for (const model of JSON.parse(fact.models) as string[]) {
			if (model) session.modelSet.add(model);
		}
	}
	for (const fact of modelFacts) {
		if (!contextRootFile(fact.file, sessionsPrefix)) continue;
		const model = fact.model || "unknown";
		let row = byModel.get(model);
		if (!row) {
			row = { model, requests: 0, promptTokens: 0, totalTokens: 0, costTotal: 0, unpricedRequests: 0 };
			byModel.set(model, row);
		}
		row.requests += fact.requests;
		row.promptTokens += fact.promptTokens;
		row.totalTokens += fact.totalTokens;
		row.costTotal += fact.costTotal;
		row.unpricedRequests += fact.unpricedRequests;
	}
	kpi.sessions = byRoot.size;
	kpi.avgPromptTokens = kpi.requests ? promptTokens / kpi.requests : 0;
	kpi.cacheRate =
		kpi.inputTokens + kpi.cacheReadTokens > 0 ? kpi.cacheReadTokens / (kpi.inputTokens + kpi.cacheReadTokens) : 0;
	const roots = [...byRoot.values()].sort((a, b) => b.endedAt - a.endedAt || a.file.localeCompare(b.file));
	let omittedRequests = 0;
	let omittedPromptTokens = 0;
	for (let index = SESSION_LIMIT; index < roots.length; index++) {
		omittedRequests += roots[index].requests;
		omittedPromptTokens += roots[index].promptTokens;
	}
	const sessions = await Promise.all(
		roots.slice(0, SESSION_LIMIT).map(async ({ modelSet, ...session }) => {
			const metadata = await readSessionMetadata(session.file);
			session.title = metadata.title;
			session.folder = metadata.cwd ?? session.folder;
			session.models = [...modelSet].sort();
			session.avgPromptTokens = session.promptTokens / session.requests;
			return session;
		}),
	);
	return {
		range,
		cutoff,
		heatmapBucketMs,
		kpi,
		heatmap: [...byBucket.values()].sort((a, b) => a.bucket - b.bucket),
		models: [...byModel.values()].sort((a, b) => b.requests - a.requests || a.model.localeCompare(b.model)),
		sessions,
		omittedSessions: Math.max(0, roots.length - SESSION_LIMIT),
		omittedRequests,
		omittedPromptTokens,
	};
}
