import { normalizedRecallWeights, temporalHalflifeHours } from "../../config";
import { embedQuery } from "../embeddings";
import { mmrRerank } from "../mmr";
import { adjustWeights, classifyIntent } from "../query-intent";
import { getSynonyms, normalizeQuery, STOP_WORDS as QUERY_STOP_WORDS } from "../synonyms";
import { extractTemporal } from "../temporal-parser";
import { cosineSimilarity } from "../vector-math";
import type { BeamMemoryState, RecallEnhancedOptions, RecallOptions, RecallResult } from "./types";

type DbValue = string | number | null | Uint8Array;
type Row = Record<string, unknown>;
type TierLabel = "working" | "episodic";

type RecallOptionsInternal = RecallOptions & {
	source?: string | null;
	topic?: string | null;
	veracity?: string | null;
	memoryType?: string | null;
	temporalWeight?: number;
	temporalHalflife?: number;
	vecWeight?: number;
	ftsWeight?: number;
	importanceWeight?: number;
	queryEmbedding?: readonly number[] | null;
	useSynonyms?: boolean;
	useIntent?: boolean;
	useMmr?: boolean;
	mmrLambda?: number;
	ignoreSessionScope?: boolean;
	currentSensitive?: boolean;
	updateRecallCounts?: boolean;
};

type CandidateSignals = {
	fts: number;
	ftsMatched: boolean;
	dense: number;
	keyword: number;
	candidateSource: "fts" | "vec" | "fallback";
};

type MemoryCandidate = {
	row: Row;
	tierLabel: TierLabel;
	signals: CandidateSignals;
};

type FactRecallResult = RecallResult & {
	fact_id?: string;
	subject?: string;
	predicate?: string;
};

type RecallMmrItem = {
	readonly content?: string;
	readonly score?: number;
	readonly result: RecallResult;
	readonly [key: string]: unknown;
};

const VERACITY_WEIGHTS: Record<string, number> = {
	stated: 1.0,
	true: 1.0,
	likely_true: 1.0,
	unknown: 0.8,
	inferred: 0.7,
	imported: 0.6,
	tool: 0.5,
	false: 0,
};

/**
 * Default per-result content preview cap enforced by {@link recall}. Content
 * longer than this is clipped and the last character replaced with `…` so
 * callers see the truncation; the full row remains reachable via
 * `Mnemopi.get()` (and, in the coding-agent, `memory://<id>`). Overridable per
 * call via {@link RecallOptions.contentPreviewChars}.
 */
export const RECALL_CONTENT_PREVIEW_CHARS = 500;

/**
 * Clip `content` to at most `limit` characters, replacing the tail with `…`
 * when truncated so agents can distinguish a preview from a full row. Returns
 * the original string (and `truncated: false`) when the limit is 0/negative or
 * the content already fits. The single `…` occupies one character of the cap,
 * so a 500-char cap yields at most 499 real characters plus the marker.
 */
export function clipRecallContent(
	content: string,
	limit: number = RECALL_CONTENT_PREVIEW_CHARS,
): { content: string; truncated: boolean; fullLength: number } {
	const fullLength = content.length;
	if (limit <= 0 || fullLength <= limit) {
		return { content, truncated: false, fullLength };
	}
	const head = content.slice(0, Math.max(0, limit - 1));
	return { content: `${head}…`, truncated: true, fullLength };
}

const DEFAULT_LIMIT = 500;
const STOP_WORDS = new Set([
	"a",
	"an",
	"and",
	"are",
	"as",
	"at",
	"be",
	"by",
	"for",
	"from",
	"how",
	"i",
	"in",
	"is",
	"it",
	"of",
	"on",
	"or",
	"that",
	"the",
	"this",
	"to",
	"was",
	"what",
	"when",
	"where",
	"who",
	"with",
]);

const FACT_QUERY_FILLER_WORDS = new Set([
	...QUERY_STOP_WORDS,
	"active",
	"current",
	"currently",
	"d",
	"know",
	"latest",
	"ll",
	"m",
	"please",
	"present",
	"re",
	"recent",
	"remind",
	"remember",
	"s",
	"t",
	"tell",
	"today",
	"ve",
]);

const FACT_CLITIC_FRAGMENTS = new Set(["d", "ll", "m", "re", "s", "t", "ve"]);
const FLAT_FACT_SEARCH_NOISE: Record<string, true> = { entity: true, fact: true };

function nowIso(): string {
	return new Date().toISOString();
}

function asNumber(value: unknown, fallback = 0): number {
	const n = typeof value === "number" ? value : Number(value);
	return Number.isFinite(n) ? n : fallback;
}

function asString(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function asNullableString(value: unknown): string | null {
	return typeof value === "string" ? value : null;
}

function round4(value: number): number {
	return Math.round(value * 10000) / 10000;
}

function clamp01(value: number): number {
	if (value <= 0) return 0;
	if (value >= 1) return 1;
	return value;
}

function tokenize(text: string): string[] {
	const lowered = text.toLowerCase();
	const matches = lowered.match(/[\p{L}\p{N}_]+/gu) ?? [];
	const tokens: string[] = [];
	for (const token of matches) {
		if (token.length === 0 || STOP_WORDS.has(token)) continue;
		tokens.push(token);
	}
	return tokens;
}

function recallSynonyms(token: string, useSynonyms: boolean): string[] {
	if (!useSynonyms) return [token];
	const variants = getSynonyms(token);
	switch (token) {
		case "branding":
			return [...variants, "positioning", "wording", "headline"];
		case "preference":
		case "prefer":
		case "preferred":
			return [...variants, "wants", "want", "prefers"];
		default:
			return variants;
	}
}

function expandedTokens(query: string, useSynonyms = true): string[] {
	const seen = new Set<string>();
	for (const token of tokenize(query)) {
		for (const variant of recallSynonyms(token, useSynonyms)) {
			for (const part of tokenize(variant)) seen.add(part);
		}
	}
	return [...seen];
}

function expandedTokenGroups(query: string, useSynonyms = true): string[][] {
	const groups: string[][] = [];
	for (const token of tokenize(query)) {
		const seen = new Set<string>();
		for (const variant of recallSynonyms(token, useSynonyms)) {
			for (const part of tokenize(variant)) seen.add(part);
		}
		if (seen.size > 0) groups.push([...seen]);
	}
	return groups;
}

function factExpandedTokenGroups(query: string, content: string): string[][] {
	const contentLower = content.toLowerCase();
	const contentTokens = new Set(tokenize(contentLower));
	const groups: string[][] = [];
	for (const token of tokenize(query)) {
		if (FACT_QUERY_FILLER_WORDS.has(token) && (FACT_CLITIC_FRAGMENTS.has(token) || !contentTokens.has(token))) {
			continue;
		}
		const seen = new Set<string>();
		for (const variant of recallSynonyms(token, true)) {
			for (const part of tokenize(variant)) {
				if (!FACT_QUERY_FILLER_WORDS.has(part) || (!FACT_CLITIC_FRAGMENTS.has(part) && contentTokens.has(part))) {
					seen.add(part);
				}
			}
		}
		if (seen.size > 0) groups.push([...seen]);
	}
	return groups;
}

function tokensFromGroups(groups: readonly (readonly string[])[]): string[] {
	const seen = new Set<string>();
	for (const group of groups) {
		for (const token of group) seen.add(token);
	}
	return [...seen];
}

function contentMatchesToken(contentLower: string, contentTokens: ReadonlySet<string>, token: string): boolean {
	if (contentTokens.has(token) || contentLower.includes(token)) return true;
	for (const contentToken of contentTokens) {
		if (
			contentToken.length >= 4 &&
			token.length >= 4 &&
			(contentToken.includes(token) || token.includes(contentToken))
		) {
			return true;
		}
	}
	return false;
}

function lexicalGroupRelevance(
	queryGroups: readonly (readonly string[])[],
	content: string,
	normalizedQuery: string,
): number {
	if (queryGroups.length === 0) return 0;
	const contentLower = content.toLowerCase();
	if (queryGroups.length > 1 && normalizedQuery.length > 0 && contentLower.includes(normalizedQuery)) return 1;
	const contentTokens = new Set(tokenize(contentLower));
	let exact = 0;
	let partial = 0;
	for (const group of queryGroups) {
		let matched = false;
		for (const token of group) {
			if (contentMatchesToken(contentLower, contentTokens, token)) {
				matched = true;
				break;
			}
		}
		if (matched) exact += 1;
		else {
			for (const token of group) {
				for (const contentToken of contentTokens) {
					if (
						contentToken.length >= 4 &&
						token.length >= 4 &&
						(contentToken.includes(token) || token.includes(contentToken))
					) {
						partial += 1;
						matched = true;
						break;
					}
				}
				if (matched) break;
			}
		}
	}
	if (queryGroups.length === 1) {
		if (exact === 0 && partial === 0) return 0;
		const token = queryGroups[0]?.[0] ?? "";
		let count = 0;
		let offset = 0;
		while (token.length > 0) {
			const idx = contentLower.indexOf(token, offset);
			if (idx < 0) break;
			count += 1;
			offset = idx + token.length;
		}
		return clamp01(0.7 + Math.min(Math.max(count - 1, 0), 3) * 0.1);
	}
	return clamp01((exact + partial * 0.5) / queryGroups.length);
}

function queryAsksCurrent(query: string): boolean {
	return /\b(?:now|current|currently|latest|recent|today|active|present)\b/i.test(query);
}

function currentContentAdjustment(content: string, currentSensitive: boolean): number {
	if (!currentSensitive) return 1;
	const lowered = content.toLowerCase();
	let factor = 1;
	if (/\b(?:current|currently|latest|now|active|present)\b/.test(lowered)) factor *= 1.35;
	if (/\b(?:was|previous|previously|legacy|old|stale|former|deprecated)\b/.test(lowered)) factor *= 0.72;
	return factor;
}

function minimumRelevance(tokens: readonly string[]): number {
	if (tokens.length <= 1) return 0.08;
	if (tokens.length === 2) return 0.18;
	if (tokens.length === 3) return 0.34;
	return 0.22;
}

function lexicalRelevance(queryTokens: readonly string[], content: string, normalizedQuery: string): number {
	if (queryTokens.length === 0) return 0;
	const contentLower = content.toLowerCase();
	if (queryTokens.length > 1 && normalizedQuery.length > 0 && contentLower.includes(normalizedQuery)) return 1;
	if (queryTokens.length === 1) {
		const token = queryTokens[0] ?? "";
		if (token.length === 0 || !contentLower.includes(token)) return 0;
		let count = 0;
		let offset = 0;
		while (true) {
			const idx = contentLower.indexOf(token, offset);
			if (idx < 0) break;
			count += 1;
			offset = idx + token.length;
		}
		return clamp01(0.7 + Math.min(Math.max(count - 1, 0), 3) * 0.1);
	}
	const contentTokens = new Set(tokenize(contentLower));
	let exact = 0;
	let partial = 0;
	for (const token of queryTokens) {
		if (contentTokens.has(token) || contentLower.includes(token)) {
			exact += 1;
			continue;
		}
		for (const contentToken of contentTokens) {
			if (
				contentToken.length >= 4 &&
				token.length >= 4 &&
				(contentToken.includes(token) || token.includes(contentToken))
			) {
				partial += 1;
				break;
			}
		}
	}
	return clamp01((exact + partial * 0.5) / queryTokens.length);
}

function recencyDecay(timestamp: unknown, halfLifeHours = 72): number {
	const raw = asString(timestamp);
	if (raw.length === 0) return 0;
	const parsed = Date.parse(raw);
	if (!Number.isFinite(parsed)) return 0;
	const ageHours = Math.max(0, (Date.now() - parsed) / 3_600_000);
	return Math.exp(-ageHours / Math.max(halfLifeHours, 0.001));
}

export function parseQueryTime(value: RecallOptionsInternal["queryTime"]): Date {
	if (value == null) return new Date();
	if (value instanceof Date) {
		if (!Number.isFinite(value.getTime())) throw new RangeError("Invalid query time");
		return value;
	}
	if (typeof value === "string") {
		const normalized = /^\d{4}-\d{2}-\d{2}$/.test(value)
			? `${value}T00:00:00.000Z`
			: /(?:Z|[+-]\d{2}:?\d{2})$/.test(value)
				? value
				: `${value}Z`;
		const parsed = new Date(normalized);
		if (Number.isFinite(parsed.getTime())) return parsed;
	}
	throw new TypeError("queryTime must be null, an ISO date string, or a valid Date");
}

export function temporalBoost(timestamp: unknown, queryTime: Date, halfLifeHours: number): number {
	const raw = asString(timestamp);
	if (raw.length === 0) return 0;
	const parsed = Date.parse(raw);
	if (!Number.isFinite(parsed)) return 0;
	const distanceHours = Math.max(0, queryTime.getTime() - parsed) / 3_600_000;
	return Math.exp(-distanceHours / Math.max(halfLifeHours, 0.001));
}

function inferTemporalOptions(query: string, options: RecallOptionsInternal): RecallOptionsInternal {
	const copy: RecallOptionsInternal = { ...options };
	const info = extractTemporal(query, options.queryTime ?? undefined);
	if (info.event_date !== null) {
		copy.queryTime ??= info.event_date;
		copy.temporalWeight ??= 0.35;
	}
	return copy;
}

function ftsPhrase(token: string): string {
	return `"${token.replaceAll('"', '""')}"`;
}

function ftsQuery(query: string, useSynonyms = true): string {
	const tokens = expandedTokens(query, useSynonyms).slice(0, 12);
	if (tokens.length === 0) return ftsPhrase(query.trim());
	return tokens.map(ftsPhrase).join(" OR ");
}

function placeholders(count: number): string {
	return new Array<string>(count).fill("?").join(",");
}

function queryAll(beam: BeamMemoryState, sql: string, params: readonly DbValue[] = []): Row[] {
	return beam.db.query(sql).all(...params) as Row[];
}

function queryGet(beam: BeamMemoryState, sql: string, params: readonly DbValue[] = []): Row | null {
	return (beam.db.query(sql).get(...params) as Row | null) ?? null;
}

function tableExists(beam: BeamMemoryState, table: string): boolean {
	return (
		queryGet(beam, "SELECT 1 FROM sqlite_master WHERE type IN ('table', 'virtual table') AND name = ?", [table]) !==
		null
	);
}

function factsHaveScopeColumn(beam: BeamMemoryState): boolean {
	const rows = queryAll(beam, "PRAGMA table_info(facts)");
	return rows.some(row => asString(row.name) === "scope");
}

function factVisibilityWhere(beam: BeamMemoryState, tableAlias: string): { where: string; params: DbValue[] } {
	const prefix = tableAlias.length === 0 ? "" : `${tableAlias}.`;
	if (factsHaveScopeColumn(beam)) {
		return { where: `(${prefix}session_id = ? OR ${prefix}scope = 'global')`, params: [beam.sessionId] };
	}
	return { where: `${prefix}session_id = ?`, params: [beam.sessionId] };
}

function buildWhere(
	beam: BeamMemoryState,
	tableAlias: string,
	options: RecallOptionsInternal,
): { where: string; params: DbValue[] } {
	const prefix = tableAlias.length === 0 ? "" : `${tableAlias}.`;
	const clauses = [`(${prefix}valid_until IS NULL OR ${prefix}valid_until > ?)`, `${prefix}superseded_by IS NULL`];
	const params: DbValue[] = [nowIso()];
	const channelId = options.channelId ?? null;
	const authorId = options.authorId ?? null;
	const authorType = options.authorType ?? null;
	if (options.ignoreSessionScope === true) {
		clauses.push("1=1");
	} else if (channelId !== null && channelId !== "") {
		clauses.push(`(${prefix}session_id = ? OR ${prefix}scope = 'global' OR ${prefix}channel_id = ?)`);
		params.push(beam.sessionId, channelId);
	} else if (authorId !== null || authorType !== null) {
		clauses.push("1=1");
	} else {
		clauses.push(`(${prefix}session_id = ? OR ${prefix}scope = 'global')`);
		params.push(beam.sessionId);
	}
	if (options.fromDate !== undefined && options.fromDate !== null) {
		clauses.push(`${prefix}timestamp >= ?`);
		params.push(`${options.fromDate}T00:00:00`);
	}
	if (options.toDate !== undefined && options.toDate !== null) {
		clauses.push(`${prefix}timestamp <= ?`);
		params.push(`${options.toDate}T23:59:59`);
	}
	if (options.source) {
		clauses.push(`${prefix}source = ?`);
		params.push(options.source);
	}
	if (options.topic) {
		clauses.push(`${prefix}source = ?`);
		params.push(options.topic);
	}
	if (options.veracity) {
		clauses.push(`${prefix}veracity = ?`);
		params.push(options.veracity);
	}
	if (options.memoryType) {
		clauses.push(`${prefix}memory_type = ?`);
		params.push(options.memoryType);
	}
	if (authorId !== null) {
		clauses.push(`${prefix}author_id = ?`);
		params.push(authorId);
	}
	if (authorType !== null) {
		clauses.push(`${prefix}author_type = ?`);
		params.push(authorType);
	}
	return { where: clauses.join(" AND "), params };
}

const MEMORY_COLUMNS =
	"id, content, source, timestamp, session_id, importance, metadata_json, veracity, memory_type, recall_count, last_recalled, valid_until, superseded_by, scope, author_id, author_type, channel_id, event_date, event_date_precision, temporal_tags";
const WORKING_MEMORY_COLUMNS =
	"id, content, embed_text, source, timestamp, session_id, importance, metadata_json, veracity, memory_type, recall_count, last_recalled, valid_until, superseded_by, scope, author_id, author_type, channel_id, event_date, event_date_precision, temporal_tags";
const EPISODIC_COLUMNS = `${MEMORY_COLUMNS}, rowid, summary_of, tier`;

function ftsRows(
	beam: BeamMemoryState,
	table: "fts_working" | "fts_episodes",
	query: string,
	limit: number,
	useSynonyms = true,
): Row[] {
	if (!tableExists(beam, table)) return [];
	try {
		// Superseded rows stay in the FTS mirrors (their content never changed) but must not
		// occupy LIMIT slots — visibility filtering would drop them AFTER they displaced live rows.
		if (table === "fts_working") {
			return queryAll(
				beam,
				// Correlated EXISTS, never `id IN (SELECT ...)`: the IN form makes SQLite build a
				// LIST SUBQUERY over the whole live table on every lexical recall, before the small
				// LIMIT applies. Measured on a 40k-row bank with a selective query: 9.19ms vs
				// 0.042ms. EXISTS probes the primary key only for rows MATCH actually produced.
				`SELECT f.id, f.rank FROM fts_working f
				 WHERE f.fts_working MATCH ?
				   AND EXISTS (SELECT 1 FROM working_memory w WHERE w.id = f.id AND w.superseded_by IS NULL)
				 ORDER BY f.rank, f.id LIMIT ?`,
				[ftsQuery(query, useSynonyms), limit],
			);
		}
		return queryAll(
			beam,
			`SELECT f.rowid, f.rank FROM fts_episodes f
			 WHERE f.fts_episodes MATCH ?
			   AND EXISTS (SELECT 1 FROM episodic_memory e WHERE e.rowid = f.rowid AND e.superseded_by IS NULL)
			 ORDER BY f.rank, f.rowid LIMIT ?`,
			[ftsQuery(query, useSynonyms), limit],
		);
	} catch {
		return [];
	}
}

function normalizeRanks(rows: readonly Row[], key: string): Map<string | number, number> {
	const out = new Map<string | number, number>();
	if (rows.length === 0) return out;
	let min = Number.POSITIVE_INFINITY;
	let max = Number.NEGATIVE_INFINITY;
	for (const row of rows) {
		const rank = asNumber(row.rank, 0);
		if (rank < min) min = rank;
		if (rank > max) max = rank;
	}
	const range = max === min ? 1 : max - min;
	for (const row of rows) {
		const id = row[key] as string | number | undefined;
		if (id === undefined) continue;
		out.set(id, 1 - (asNumber(row.rank, 0) - min) / range);
	}
	return out;
}

function parseEmbedding(raw: unknown): number[] | null {
	if (typeof raw !== "string") return null;
	try {
		const parsed = JSON.parse(raw) as unknown;
		if (!Array.isArray(parsed)) return null;
		const vector = new Array<number>(parsed.length);
		for (let i = 0; i < parsed.length; i += 1) {
			const value = Number(parsed[i]);
			if (!Number.isFinite(value)) return null;
			vector[i] = value;
		}
		return vector;
	} catch {
		return null;
	}
}

function vectorSimilarities(
	beam: BeamMemoryState,
	memoryIds: readonly string[],
	queryEmbedding: readonly number[] | null | undefined,
): Map<string, number> {
	const out = new Map<string, number>();
	if (
		queryEmbedding == null ||
		queryEmbedding.length === 0 ||
		memoryIds.length === 0 ||
		!tableExists(beam, "memory_embeddings")
	) {
		return out;
	}
	for (let offset = 0; offset < memoryIds.length; offset += 500) {
		const chunk = memoryIds.slice(offset, offset + 500);
		const rows = queryAll(
			beam,
			`SELECT memory_id, embedding_json FROM memory_embeddings WHERE memory_id IN (${placeholders(chunk.length)})`,
			chunk,
		);
		for (const row of rows) {
			const vector = parseEmbedding(row.embedding_json);
			const id = asString(row.memory_id);
			if (vector !== null && id.length > 0) out.set(id, Math.max(0, cosineSimilarity(queryEmbedding, vector)));
		}
	}
	return out;
}

function allVisibleIds(
	beam: BeamMemoryState,
	table: "working_memory" | "episodic_memory",
	options: RecallOptionsInternal,
): string[] {
	const { where, params } = buildWhere(beam, "", options);
	const rows = queryAll(beam, `SELECT id FROM ${table} WHERE ${where} ORDER BY timestamp DESC LIMIT ?`, [
		...params,
		DEFAULT_LIMIT,
	]);
	return rows.map(row => asString(row.id)).filter(Boolean);
}

function fetchCandidates(
	beam: BeamMemoryState,
	tierLabel: TierLabel,
	idsOrRowids: readonly (string | number)[],
	ftsScores: Map<string | number, number>,
	vecScores: Map<string, number>,
	options: RecallOptionsInternal,
): MemoryCandidate[] {
	if (idsOrRowids.length === 0) return [];
	const table = tierLabel === "working" ? "working_memory" : "episodic_memory";
	const keyColumn = tierLabel === "working" ? "id" : "rowid";
	const columns = tierLabel === "working" ? WORKING_MEMORY_COLUMNS : EPISODIC_COLUMNS;
	const { where, params } = buildWhere(beam, "m", options);
	const rows = queryAll(
		beam,
		`SELECT ${columns
			.split(", ")
			.map(column => `m.${column}`)
			.join(", ")} FROM ${table} m WHERE m.${keyColumn} IN (${placeholders(idsOrRowids.length)}) AND ${where}`,
		[...idsOrRowids, ...params],
	);
	const out: MemoryCandidate[] = [];
	for (const row of rows) {
		const rowKey = tierLabel === "working" ? asString(row.id) : asNumber(row.rowid);
		const id = asString(row.id);
		const fts = ftsScores.get(rowKey) ?? 0;
		const ftsMatched = ftsScores.has(rowKey);
		const dense = vecScores.get(id) ?? 0;
		out.push({
			row,
			tierLabel,
			signals: {
				fts,
				ftsMatched,
				dense,
				keyword: 0,
				candidateSource: ftsMatched ? "fts" : dense > 0 ? "vec" : "fallback",
			},
		});
	}
	return out;
}

function fallbackCandidates(
	beam: BeamMemoryState,
	tierLabel: TierLabel,
	options: RecallOptionsInternal,
): MemoryCandidate[] {
	const table = tierLabel === "working" ? "working_memory" : "episodic_memory";
	const columns = tierLabel === "working" ? WORKING_MEMORY_COLUMNS : EPISODIC_COLUMNS;
	const { where, params } = buildWhere(beam, "", options);
	const rows = queryAll(beam, `SELECT ${columns} FROM ${table} WHERE ${where} ORDER BY timestamp DESC LIMIT ?`, [
		...params,
		Math.min(DEFAULT_LIMIT, 2000),
	]);
	return rows.map(row => ({
		row,
		tierLabel,
		signals: { fts: 0, ftsMatched: false, dense: 0, keyword: 0, candidateSource: "fallback" },
	}));
}

function scoreCandidate(
	candidate: MemoryCandidate,
	queryTokens: readonly string[],
	queryGroups: readonly (readonly string[])[],
	normalizedQueryLower: string,
	weights: readonly [number, number, number],
	options: RecallOptionsInternal,
): RecallResult | null {
	const content = asString(candidate.row.content);
	const searchableContent = asString(candidate.row.embed_text) || content;
	const lexical =
		queryGroups.length > 0
			? lexicalGroupRelevance(queryGroups, searchableContent, normalizedQueryLower)
			: lexicalRelevance(queryTokens, searchableContent, normalizedQueryLower);
	const minRel = minimumRelevance(queryTokens);
	if (lexical < minRel && candidate.signals.dense < 0.65) return null;
	const [vecWeight, ftsWeight, importanceWeight] = weights;
	const importance = asNumber(candidate.row.importance, 0.5);
	const decay =
		options.queryTime == null
			? recencyDecay(candidate.row.timestamp, 72)
			: temporalBoost(candidate.row.timestamp, parseQueryTime(options.queryTime), 72);
	const keyword = Math.max(lexical, candidate.signals.fts * 0.6);
	let baseScore: number;
	if (candidate.tierLabel === "episodic") {
		baseScore = Math.max(
			candidate.signals.dense * vecWeight + candidate.signals.fts * ftsWeight + importance * importanceWeight,
			lexical * 0.8,
		);
	} else {
		const kwShare = (1 - importanceWeight) * 0.6;
		baseScore = keyword * kwShare + importance * importanceWeight + keyword * keyword * 0.08;
		if (candidate.signals.dense > 0) baseScore = baseScore * 0.8 + candidate.signals.dense * 0.2;
	}
	let score = baseScore * (0.7 + 0.3 * decay);
	const temporalWeight = options.temporalWeight ?? 0;
	let temporalScore = 0;
	if (temporalWeight > 0) {
		temporalScore = temporalBoost(
			candidate.row.timestamp,
			parseQueryTime(options.queryTime),
			options.temporalHalflife ?? temporalHalflifeHours(),
		);
		const eventBoost = temporalBoost(
			candidate.row.event_date,
			parseQueryTime(options.queryTime),
			(options.temporalHalflife ?? temporalHalflifeHours()) * 2,
		);
		temporalScore = Math.max(temporalScore, eventBoost);
		score *= 1 + temporalWeight * temporalScore;
	}
	const veracity = asString(candidate.row.veracity) || "unknown";
	const veracityWeight = VERACITY_WEIGHTS[veracity] ?? VERACITY_WEIGHTS.unknown ?? 0.8;
	const degradationTier = candidate.tierLabel === "episodic" ? asNumber(candidate.row.tier, 1) : undefined;
	if (candidate.tierLabel === "episodic") {
		const tierWeight = degradationTier === 1 ? 1 : degradationTier === 2 ? 0.85 : 0.7;
		score *= tierWeight;
	}
	score *= veracityWeight * currentContentAdjustment(searchableContent, options.currentSensitive === true);
	const preview = clipRecallContent(content, options.contentPreviewChars ?? RECALL_CONTENT_PREVIEW_CHARS);
	const result: RecallResult = {
		...candidate.row,
		id: asString(candidate.row.id),
		content: preview.content,
		source: asNullableString(candidate.row.source),
		timestamp: asNullableString(candidate.row.timestamp),
		importance,
		score: round4(score),
		rank: candidate.signals.fts,
		tier: candidate.tierLabel,
		tier_label: candidate.tierLabel,
		degradation_tier: degradationTier,
		keyword_score: round4(lexical),
		dense_score: round4(candidate.signals.dense),
		fts_score: round4(candidate.signals.fts),
		importance_score: round4(importance),
		recency_score: round4(decay),
		temporal_score: round4(temporalScore),
		recall_count: asNumber(candidate.row.recall_count, 0),
		last_recalled: asNullableString(candidate.row.last_recalled),
		explanation: explain(candidate.tierLabel, candidate.signals, lexical, temporalScore),
		voice_scores: {
			vec: round4(candidate.signals.dense),
			fts: round4(candidate.signals.fts),
			keyword: round4(lexical),
			importance: round4(importance),
			recency_decay: round4(decay),
			temporal: round4(temporalScore),
		},
		truncated: preview.truncated,
		full_length: preview.fullLength,
	};
	return result;
}

function explain(tierLabel: TierLabel, signals: CandidateSignals, lexical: number, temporalScore: number): string {
	const parts: string[] = [tierLabel, signals.candidateSource];
	if (lexical > 0) parts.push(`keyword=${round4(lexical)}`);
	if (signals.dense > 0) parts.push(`dense=${round4(signals.dense)}`);
	if (temporalScore > 0) parts.push(`temporal=${round4(temporalScore)}`);
	return parts.join(" ");
}

function dedupeResults(results: readonly RecallResult[]): RecallResult[] {
	const seen = new Set<string>();
	const out: RecallResult[] = [];
	for (const result of results) {
		const key = `${result.tier_label ?? ""}:${result.id}`;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(result);
	}
	return out;
}

function dedupCrossTierSummaryLinks(beam: BeamMemoryState, results: readonly RecallResult[]): RecallResult[] {
	const episodicIds = results
		.filter(result => (result.tier_label ?? result.tier) === "episodic")
		.map(result => result.id)
		.filter(id => id.length > 0);
	if (episodicIds.length === 0) return [...results];

	const workingScores = new Map<string, number>();
	const episodicScores = new Map<string, number>();
	for (const result of results) {
		const tier = result.tier_label ?? result.tier;
		if (tier === "working") workingScores.set(result.id, result.score ?? 0);
		else if (tier === "episodic") episodicScores.set(result.id, result.score ?? 0);
	}
	if (workingScores.size === 0 || episodicScores.size === 0) return [...results];

	const summaryRows = queryAll(
		beam,
		`SELECT id, summary_of FROM episodic_memory WHERE id IN (${placeholders(episodicIds.length)})`,
		episodicIds,
	);
	const dropWorking = new Set<string>();
	const dropEpisodic = new Set<string>();
	for (const row of summaryRows) {
		const episodicId = asString(row.id);
		const episodicScore = episodicScores.get(episodicId);
		if (episodicScore === undefined) continue;
		const covered = asString(row.summary_of)
			.split(",")
			.map(id => id.trim())
			.filter(id => id.length > 0 && workingScores.has(id));
		if (covered.length === 0) continue;
		dropEpisodic.add(episodicId);
	}
	if (dropWorking.size === 0 && dropEpisodic.size === 0) return [...results];
	return results.filter(result => {
		const tier = result.tier_label ?? result.tier;
		if (tier === "working") return !dropWorking.has(result.id);
		if (tier === "episodic") return !dropEpisodic.has(result.id);
		return true;
	});
}

function rerankRecallResults(results: readonly RecallResult[], lambdaParam: number, topK: number): RecallResult[] {
	const items: RecallMmrItem[] = results.map(result => ({
		content: result.content,
		score: result.score,
		result,
	}));
	return mmrRerank(items, lambdaParam, topK).map(item => item.result);
}

function updateRecallCounts(
	beam: BeamMemoryState,
	results: readonly RecallResult[],
	options: RecallOptionsInternal,
): void {
	const timestamp = nowIso();
	for (const tierLabel of ["working", "episodic"] as const) {
		const ids = results.filter(r => r.tier_label === tierLabel).map(r => r.id);
		if (ids.length === 0) continue;
		const table = tierLabel === "working" ? "working_memory" : "episodic_memory";
		const { where, params } = buildWhere(beam, "", options);
		beam.db.run(
			`UPDATE ${table} SET recall_count = COALESCE(recall_count, 0) + 1, last_recalled = ? WHERE id IN (${placeholders(ids.length)}) AND ${where}`,
			[timestamp, ...ids, ...params],
		);
	}
}

function collectMemoryCandidates(
	beam: BeamMemoryState,
	query: string,
	topK: number,
	options: RecallOptionsInternal,
): MemoryCandidate[] {
	const limit = Math.max(topK * 3, 50);
	const useSynonyms = options.useSynonyms !== false;
	const wmFtsRows = options.includeWorking === false ? [] : ftsRows(beam, "fts_working", query, limit, useSynonyms);
	const emFtsRows = ftsRows(beam, "fts_episodes", query, limit, useSynonyms);
	const wmFts = normalizeRanks(wmFtsRows, "id");
	const emFts = normalizeRanks(emFtsRows, "rowid");

	let wmIds = [...wmFts.keys()].filter((id): id is string => typeof id === "string");
	let emRowids = [...emFts.keys()].filter((id): id is number => typeof id === "number");
	const queryEmbedding = options.queryEmbedding ?? null;
	let wmVec = new Map<string, number>();
	let emVec = new Map<string, number>();
	if (queryEmbedding !== null && queryEmbedding !== undefined) {
		const allWmIds = options.includeWorking === false ? [] : allVisibleIds(beam, "working_memory", options);
		const allEmIds = allVisibleIds(beam, "episodic_memory", options);
		wmVec = vectorSimilarities(beam, allWmIds, queryEmbedding);
		emVec = vectorSimilarities(beam, allEmIds, queryEmbedding);
		wmIds = [
			...new Set([
				...wmIds,
				...[...wmVec.entries()]
					.sort((a, b) => b[1] - a[1])
					.slice(0, limit)
					.map(([id]) => id),
			]),
		];
		const emIds = [...emVec.entries()]
			.sort((a, b) => b[1] - a[1])
			.slice(0, limit)
			.map(([id]) => id);
		if (emIds.length > 0) {
			const rows = queryAll(
				beam,
				`SELECT rowid, id FROM episodic_memory WHERE id IN (${placeholders(emIds.length)})`,
				emIds,
			);
			emRowids = [...new Set([...emRowids, ...rows.map(row => asNumber(row.rowid)).filter(n => n > 0)])];
		}
	}

	const candidates: MemoryCandidate[] = [];
	if (wmIds.length > 0) candidates.push(...fetchCandidates(beam, "working", wmIds, wmFts, wmVec, options));
	else if (options.includeWorking !== false) candidates.push(...fallbackCandidates(beam, "working", options));
	if (emRowids.length > 0) candidates.push(...fetchCandidates(beam, "episodic", emRowids, emFts, emVec, options));
	else candidates.push(...fallbackCandidates(beam, "episodic", options));
	if (candidates.length === 0) return candidates;
	void useSynonyms;
	return candidates;
}

export async function recall(
	beam: BeamMemoryState,
	query: string,
	topK = 40,
	options: RecallOptionsInternal = {},
): Promise<RecallResult[]> {
	if (topK <= 0) return [];
	const temporalOptions = inferTemporalOptions(query, options);
	if (queryAsksCurrent(query)) {
		temporalOptions.queryTime ??= options.queryTime ?? new Date();
		temporalOptions.temporalWeight ??= 0.45;
		temporalOptions.currentSensitive = true;
	}
	if (temporalOptions.queryEmbedding === undefined) {
		// Honour `null` (explicit "no embedding"); `undefined` means "derive from query text".
		// `embedQuery()` returns null when embeddings are disabled or no provider is configured,
		// so this is a no-op when the user has not wired one up. Float32Array → number[]
		// because RecallOptions exposes the narrower public shape.
		const derived = query.length > 0 ? await embedQuery(query) : null;
		temporalOptions.queryEmbedding = derived === null ? null : Array.from(derived);
	}
	let weights = normalizedRecallWeights(
		options.vecWeight ?? beam.config.vecWeight,
		options.ftsWeight ?? beam.config.ftsWeight,
		options.importanceWeight ?? beam.config.importanceWeight,
	);
	if (options.useIntent === true) {
		const intent = classifyIntent(query);
		weights = adjustWeights(weights[0], weights[1], weights[2], intent);
	}
	const useSynonyms = options.useSynonyms !== false;
	const tokens = expandedTokens(query, useSynonyms);
	const tokenGroups = expandedTokenGroups(query, useSynonyms);
	const normalized = normalizeQuery(query).toLowerCase();
	const candidates = collectMemoryCandidates(beam, query, topK, temporalOptions);
	const scored: RecallResult[] = [];
	for (const candidate of candidates) {
		const result = scoreCandidate(candidate, tokens, tokenGroups, normalized, weights, temporalOptions);
		if (result !== null) scored.push(result);
	}
	scored.sort((left, right) => (right.score ?? 0) - (left.score ?? 0));
	let finalResults = dedupCrossTierSummaryLinks(beam, dedupeResults(scored));
	if (query.length > 0 && tokens.length >= 4 && finalResults.length > topK)
		finalResults = diversifyByCoverage(finalResults, tokens, topK);
	if (options.useMmr === true && finalResults.length > 1) {
		finalResults = rerankRecallResults(finalResults, options.mmrLambda ?? 0.7, topK);
	} else {
		finalResults = finalResults.slice(0, topK);
	}
	if (temporalOptions.updateRecallCounts !== false) updateRecallCounts(beam, finalResults, temporalOptions);
	return finalResults;
}

function diversifyByCoverage(
	results: readonly RecallResult[],
	tokens: readonly string[],
	topK: number,
): RecallResult[] {
	const selected: RecallResult[] = [];
	const covered = new Set<string>();
	const pool = [...results];
	const querySet = new Set(tokens);
	while (pool.length > 0 && selected.length < topK) {
		let bestIdx = 0;
		let bestScore = Number.NEGATIVE_INFINITY;
		for (let i = 0; i < pool.length; i += 1) {
			const row = pool[i];
			if (row === undefined) continue;
			let additions = 0;
			for (const token of tokenize(row.content)) {
				if (querySet.has(token) && !covered.has(token)) additions += 1;
			}
			const score = (row.score ?? 0) + 0.06 * additions;
			if (score > bestScore) {
				bestScore = score;
				bestIdx = i;
			}
		}
		const picked = pool.splice(bestIdx, 1)[0];
		if (picked === undefined) break;
		selected.push(picked);
		for (const token of tokenize(picked.content)) if (querySet.has(token)) covered.add(token);
	}
	return selected;
}

export async function recallEnhanced(
	beam: BeamMemoryState,
	query: string,
	topK = 40,
	options: RecallEnhancedOptions & RecallOptionsInternal = {},
): Promise<RecallResult[]> {
	const useSynonyms = options.useSynonyms !== false;
	const enhancedOptions: RecallOptionsInternal = {
		...options,
		useSynonyms,
		useIntent: options.useIntent !== false,
		useMmr: options.useMmr !== false,
	};
	const results = await recall(beam, query, Math.max(topK * 2, topK), {
		...enhancedOptions,
		updateRecallCounts: false,
	});
	if (options.includeFacts === true) {
		const facts = factRecall(beam, query, factRecallLimit(topK));
		results.push(...facts);
	}
	results.sort((left, right) => (right.score ?? 0) - (left.score ?? 0));
	const finalResults = rerankRecallResults(results, options.mmrLambda ?? 0.7, topK);
	if (enhancedOptions.updateRecallCounts !== false) updateRecallCounts(beam, finalResults, enhancedOptions);
	return finalResults;
}

function factRecallLimit(topK: number): number {
	const requested = Math.max(0, Math.floor(topK));
	if (requested === 0) return 0;
	return Math.min(requested, Math.max(3, Math.ceil(requested / 2)));
}

function sandwichOrder(results: readonly RecallResult[]): {
	high: RecallResult[];
	medium: RecallResult[];
	closing: RecallResult[];
} {
	const scored = [...results].sort((left, right) => (right.score ?? 0) - (left.score ?? 0));
	const highLimit = scored.length > 0 && scored.length < 4 ? 1 : 3;
	const high = scored.slice(0, highLimit);
	const medium = scored.slice(high.length, high.length + 5);
	const closing = scored.slice(high.length + medium.length, high.length + medium.length + 3);
	return { high, medium, closing };
}
function factSearchableText(subject: string, predicate: string, object: string): string {
	const objectText = object.trim();
	if (objectText.length === 0) return `${subject} ${predicate}`.trim();
	const structuralParts = [subject, predicate].filter(part => {
		const token = part.trim().toLowerCase();
		return token.length > 0 && FLAT_FACT_SEARCH_NOISE[token] !== true;
	});
	return [...structuralParts, objectText].join(" ").trim();
}

function factLine(result: RecallResult): string {
	const content = clipRecallContent(result.content.trim(), 200).content;
	const ts = typeof result.timestamp === "string" && result.timestamp.length > 0 ? result.timestamp.slice(0, 10) : "?";
	const source = result.source ?? "unknown";
	const score = result.score ?? result.importance ?? 0;
	return `${content} (${ts}, ${source}, c:${score.toFixed(1)})`;
}

export function formatContext(beam: BeamMemoryState, results: readonly RecallResult[], format = "bullet"): string {
	void beam;
	const sandwich = sandwichOrder(results);
	if (format === "json") {
		return JSON.stringify(
			{
				top_facts: sandwich.high.map(factLine),
				supporting_context: sandwich.medium.map(factLine),
				recent_memories: sandwich.closing.map(factLine),
				total_memories: sandwich.high.length + sandwich.medium.length + sandwich.closing.length,
			},
			null,
			2,
		);
	}
	const lines = ["## Top Facts"];
	for (const result of sandwich.high) lines.push(`- ${factLine(result)}`);
	if (sandwich.medium.length > 0) {
		lines.push("", "## Supporting Context");
		for (const result of sandwich.medium) lines.push(`- ${factLine(result)}`);
	}
	if (sandwich.closing.length > 0) {
		lines.push("", "## Recent Signals");
		for (const result of sandwich.closing) lines.push(`- ${factLine(result)}`);
	}
	lines.push(`\n_(${sandwich.high.length + sandwich.medium.length + sandwich.closing.length} memories retrieved)_`);
	return lines.join("\n");
}

export function factRecall(beam: BeamMemoryState, query: string, topK = 30): FactRecallResult[] {
	if (topK <= 0 || !tableExists(beam, "facts")) return [];
	let matched: Row[] = [];
	if (tableExists(beam, "fts_facts")) {
		try {
			const visibility = factVisibilityWhere(beam, "facts");
			matched = queryAll(
				beam,
				`SELECT fts_facts.rowid, fts_facts.rank
				 FROM fts_facts
				 JOIN facts ON facts.rowid = fts_facts.rowid
				 WHERE fts_facts MATCH ? AND ${visibility.where}
				 ORDER BY fts_facts.rank, fts_facts.rowid
				 LIMIT ?`,
				[ftsQuery(query), ...visibility.params, topK * 3],
			);
		} catch {
			matched = [];
		}
	}
	if (matched.length === 0) {
		const seen = new Set<number>();
		for (const token of expandedTokens(query).slice(0, 6)) {
			const visibility = factVisibilityWhere(beam, "");
			const rows = queryAll(
				beam,
				`SELECT rowid
				 FROM facts
				 WHERE (subject LIKE ? OR predicate LIKE ? OR object LIKE ?) AND ${visibility.where}
				 LIMIT ?`,
				[`%${token}%`, `%${token}%`, `%${token}%`, ...visibility.params, topK],
			);
			for (const row of rows) {
				const rowid = asNumber(row.rowid);
				if (rowid > 0 && !seen.has(rowid)) {
					seen.add(rowid);
					matched.push({ rowid, rank: 0 });
				}
			}
		}
	}
	if (matched.length === 0) return [];
	const rowids = matched.map(row => asNumber(row.rowid)).filter(rowid => rowid > 0);
	if (rowids.length === 0) return [];
	const visibility = factVisibilityWhere(beam, "");
	const ranks = normalizeRanks(matched, "rowid");
	const normalized = normalizeQuery(query).toLowerCase();
	const rows = queryAll(
		beam,
		`SELECT rowid, fact_id, subject, predicate, object, timestamp, confidence
		 FROM facts
		 WHERE rowid IN (${placeholders(rowids.length)}) AND ${visibility.where}
		 ORDER BY confidence DESC
		 LIMIT ?`,
		[...rowids, ...visibility.params, rowids.length],
	);
	return rows
		.map(row => {
			const subject = asString(row.subject);
			const predicate = asString(row.predicate);
			const object = asString(row.object);
			const confidence = asNumber(row.confidence, 0.5);
			const content = object.length > 0 ? object : `${subject} ${predicate}`.trim();
			const searchable = factSearchableText(subject, predicate, object);
			const queryGroups = factExpandedTokenGroups(query, searchable);
			const queryTokens = tokensFromGroups(queryGroups);
			const lexical =
				queryGroups.length > 0
					? lexicalGroupRelevance(queryGroups, searchable, normalized)
					: lexicalRelevance(queryTokens, searchable, normalized);
			const rank = ranks.get(asNumber(row.rowid)) ?? 0;
			const result: FactRecallResult = {
				id: asString(row.fact_id),
				content,
				score: round4(lexical * (0.7 + confidence * 0.2 + rank * 0.1)),
				fact_id: asString(row.fact_id),
				subject,
				predicate,
				timestamp: asNullableString(row.timestamp),
				tier_label: "fact",
				tier: "fact",
				source: "facts",
				keyword_score: round4(lexical),
				fts_score: round4(rank),
				importance_score: round4(confidence),
				explanation: `fact keyword=${round4(lexical)}`,
				voice_scores: {
					keyword: round4(lexical),
					fts: round4(rank),
					importance: round4(confidence),
				},
			};
			return result;
		})
		.filter(result => (result.score ?? 0) > 0)
		.sort((left, right) => (right.score ?? 0) - (left.score ?? 0))
		.slice(0, topK);
}
