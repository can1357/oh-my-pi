import type { Database } from "bun:sqlite";
import { logger } from "@oh-my-pi/pi-utils";
import { generateId as generateTimedId, sha256Hex16, stableMemoryId } from "../../util/ids";
import {
	cjkFtsTerms,
	containsSpacelessCjk,
	FACT_MATCH_STOPWORDS,
	factMatchTokens,
	ftsQueryTerms,
	hasCjk,
	isCjkChar,
	RECALL_SYNONYMS,
	recallTokens,
} from "../../util/regex";
import { currentEmbeddingModel, embed } from "../embeddings";
import { getMnemopiRuntimeOptions, mnemopiDebugEnabled, withMnemopiRuntimeOptions } from "../runtime-options";
import { buildExactVectorIndex, searchExactVectorIndex } from "../vector-index";
import type { BeamMemoryState, JsonValue, Metadata } from "./types";

export type Vector = number[];

export type HybridWeights = readonly [vecWeight: number, ftsWeight: number, importanceWeight: number];

export interface VectorDistanceResult {
	rowid: number;
	distance: number;
}

export interface WorkingVectorResult {
	id: string;
	sim: number;
}

export interface FtsRankResult {
	rowid: number;
	rank: number;
}

export interface WorkingFtsRankResult {
	id: string;
	rank: number;
}

const DEFAULT_RECENCY_HALFLIFE_HOURS = 72;
const DEFAULT_WEIGHTS: HybridWeights = [0.5, 0.3, 0.2];
const TS_CACHE_MAX = 2000;
const moduleTimestampCache = new Map<string, Date>();

const SPLIT_TOKEN_RE = /[_:/.-]+/g;
const WORD_RE = /[\p{L}\p{N}_]+/gu;
function envNumber(name: string, fallback: number): number {
	const raw = process.env[name];
	if (raw === undefined || raw.trim() === "") return fallback;
	const value = Number(raw);
	return Number.isFinite(value) ? value : fallback;
}

function clamp01(value: number): number {
	if (!Number.isFinite(value)) return 0;
	if (value < 0) return 0;
	if (value > 1) return 1;
	return value;
}

function asFiniteNonNegative(value: number): number {
	return Number.isFinite(value) && value > 0 ? value : 0;
}

function tableExists(db: Database, table: string): boolean {
	try {
		return (
			db
				.query("SELECT 1 FROM sqlite_master WHERE type IN ('table','virtual table') AND name = ? LIMIT 1")
				.get(table) !== null
		);
	} catch {
		return false;
	}
}

function rowValue<T>(row: unknown, key: string): T | undefined {
	if (row && typeof row === "object" && key in row) return (row as Record<string, T>)[key];
	return undefined;
}

function timestampCacheFor(beam?: Pick<BeamMemoryState, "caches"> | null): Map<string, Date> {
	return beam?.caches?.timestampParse ?? moduleTimestampCache;
}

export function generateId(content: string, now: Date = new Date()): string {
	return generateTimedId(content, now);
}

export function generateStableId(content: string, source = ""): string {
	return stableMemoryId(content, source);
}

export function normalizeWeights(
	vecWeight: number | null | undefined,
	ftsWeight: number | null | undefined,
	importanceWeight: number | null | undefined,
): HybridWeights {
	let vw = Math.max(0, vecWeight ?? envNumber("MNEMOPI_VEC_WEIGHT", DEFAULT_WEIGHTS[0]));
	let fw = Math.max(0, ftsWeight ?? envNumber("MNEMOPI_FTS_WEIGHT", DEFAULT_WEIGHTS[1]));
	let iw = Math.max(0, importanceWeight ?? envNumber("MNEMOPI_IMPORTANCE_WEIGHT", DEFAULT_WEIGHTS[2]));
	if (!Number.isFinite(vw)) vw = 0;
	if (!Number.isFinite(fw)) fw = 0;
	if (!Number.isFinite(iw)) iw = 0;
	const total = vw + fw + iw;
	if (total === 0) return DEFAULT_WEIGHTS;
	return [vw / total, fw / total, iw / total];
}

export function normalizeImportance(importance: number | null | undefined, fallback = 0.5): number {
	return clamp01(importance ?? fallback);
}

export function normalizeDateUtc(dt: Date): Date {
	const time = dt.getTime();
	if (!Number.isFinite(time)) throw new RangeError("Invalid Date");
	return new Date(time);
}

export function parseIsoDateTimeUtc(value: string): Date {
	const normalized = value.endsWith("Z") ? value : value.replace(/Z$/, "+00:00");
	const dt = new Date(normalized);
	if (!Number.isFinite(dt.getTime())) throw new RangeError(`Invalid ISO datetime: ${value}`);
	return dt;
}

export function parseQueryTime(queryTime?: string | Date | null): Date {
	if (queryTime == null) return new Date();
	if (queryTime instanceof Date) return normalizeDateUtc(queryTime);
	try {
		return parseIsoDateTimeUtc(queryTime);
	} catch {
		return parseIsoDateTimeUtc(`${queryTime}T00:00:00`);
	}
}

export function parseTimestampFast(
	ts: string | null | undefined,
	beam?: Pick<BeamMemoryState, "caches"> | null,
): Date | null {
	if (!ts) return null;
	const cache = timestampCacheFor(beam);
	const cached = cache.get(ts);
	if (cached !== undefined) return cached;
	let parsed: Date;
	try {
		parsed = parseIsoDateTimeUtc(ts);
	} catch {
		return null;
	}
	if (cache.size >= TS_CACHE_MAX) cache.clear();
	cache.set(ts, parsed);
	return parsed;
}

export function recencyDecay(
	timestamp: string | null | undefined,
	halflifeHours = DEFAULT_RECENCY_HALFLIFE_HOURS,
	now: Date = new Date(),
): number {
	if (!timestamp) return 0.5;
	const halflife = asFiniteNonNegative(halflifeHours);
	if (halflife === 0) return 0.5;
	const ts = parseTimestampFast(timestamp);
	if (ts === null) return 0.5;
	const ageHours = (now.getTime() - ts.getTime()) / 3_600_000;
	return Math.exp(-ageHours / halflife);
}

export function temporalBoost(
	memoryTimestamp: string | null | undefined,
	queryTime: Date | string,
	halflifeHours = 24,
	beam?: Pick<BeamMemoryState, "caches"> | null,
): number {
	const ts = parseTimestampFast(memoryTimestamp, beam);
	if (ts === null) return 0;
	const query = parseQueryTime(queryTime);
	const effectiveTs = ts.getTime() > query.getTime() ? query : ts;
	const halflife = asFiniteNonNegative(halflifeHours);
	if (halflife === 0) return effectiveTs.getTime() === query.getTime() ? 1 : 0;
	const hoursDelta = (query.getTime() - effectiveTs.getTime()) / 3_600_000;
	return Math.exp(-hoursDelta / halflife);
}

export function lexicalRelevance(queryTokens: readonly string[], content: string, queryLower = ""): number {
	const contentLower = content.toLowerCase();
	const queryCjk = new Set(Array.from(queryLower).filter(isCjkChar));
	if (queryTokens.length === 0 && queryCjk.size === 0) return 0;

	const contentTokens = new Set(recallTokens(contentLower));
	for (const token of Array.from(contentTokens)) {
		for (const part of token.split(SPLIT_TOKEN_RE)) {
			if (part.length >= 3 && !FACT_MATCH_STOPWORDS.has(part) && !/^\d+$/.test(part)) contentTokens.add(part);
		}
	}
	if (contentTokens.size === 0 && queryCjk.size === 0) return 0;

	let exact = 0;
	let partial = 0;
	for (const token of queryTokens) {
		if (contentTokens.has(token)) {
			exact += 1;
			continue;
		}
		const synonyms = RECALL_SYNONYMS[token] ?? [];
		if (synonyms.some(syn => contentTokens.has(syn))) {
			partial += 0.75;
			continue;
		}
		if (
			token.length >= 4 &&
			Array.from(contentTokens).some(
				contentToken => contentToken.length >= 4 && (token.includes(contentToken) || contentToken.includes(token)),
			)
		) {
			partial += 0.4;
		}
	}

	const fullMatch = queryLower !== "" && contentLower.includes(queryLower) ? 1 : 0;
	let score = (exact + partial + fullMatch) / Math.max(queryTokens.length, 1);
	if (score === 0 && queryCjk.size > 0) {
		const contentCjk = new Set(Array.from(contentLower).filter(isCjkChar));
		let overlap = 0;
		for (const ch of queryCjk) if (contentCjk.has(ch)) overlap += 1;
		score = overlap / queryCjk.size;
	}
	return Math.min(score, 1);
}

export function strictFactMatches(query: string, factText: string): boolean {
	const queryLower = query.toLowerCase().trim();
	const factLower = factText.toLowerCase().trim();
	if (!queryLower || !factLower) return false;
	if (factLower.includes(queryLower)) return true;
	const queryTokens = factMatchTokens(queryLower);
	const factTokens = factMatchTokens(factLower);
	if (queryTokens.size === 0 || factTokens.size === 0) return false;
	const overlap = Array.from(queryTokens).filter(token => factTokens.has(token));
	if (overlap.length >= 2) return true;
	const token = overlap[0];
	if (token === undefined) return false;
	if (token.length >= 8 && /[./:_-]/.test(token)) return true;
	return token.length >= 5;
}

export function buildFtsQuery(query: string): string {
	return ftsQueryTerms(query).join(" OR ");
}

function cjkCharsForSearch(query: string): string[] {
	return Array.from(new Set(Array.from(query).filter(isCjkChar))).sort();
}

export function cjkLikeSearch(
	db: Database,
	query: string,
	k = 20,
	working = false,
): Array<FtsRankResult | WorkingFtsRankResult> {
	const cjkChars = cjkCharsForSearch(query);
	if (cjkChars.length === 0) return [];
	const table = working ? "working_memory" : "episodic_memory";
	const idColumn = working ? "id" : "rowid";
	const conditions = cjkChars.map(() => "content LIKE ? ESCAPE '\\'").join(" OR ");
	try {
		const rows = db
			.query(`SELECT ${idColumn}, content FROM ${table} WHERE superseded_by IS NULL AND (valid_until IS NULL OR valid_until > ?)
				   AND (${conditions}) LIMIT ?`)
			.all(new Date().toISOString(), ...cjkChars.map(ch => `%${ch}%`), k * 5) as Record<string, unknown>[];
		const scored: Array<{ id: string | number; score: number }> = [];
		for (const row of rows) {
			const content = String(row.content ?? "");
			let hits = 0;
			for (const ch of cjkChars) if (content.includes(ch)) hits += 1;
			const score = hits / Math.max(cjkChars.length, 1);
			if (score > 0) scored.push({ id: row[idColumn] as string | number, score });
		}
		scored.sort((a, b) => b.score - a.score);
		return scored
			.slice(0, Math.max(0, Math.trunc(k)))
			.map(row =>
				working ? { id: String(row.id), rank: -row.score } : { rowid: Number(row.id), rank: -row.score },
			);
	} catch {
		return [];
	}
}

export function ftsSearch(db: Database, query: string, k = 20): FtsRankResult[] {
	const ftsQuery = buildFtsQuery(query);
	if (!ftsQuery) return hasCjk(query) ? (cjkLikeSearch(db, query, k, false) as FtsRankResult[]) : [];
	try {
		const rows = db
			.query(`SELECT f.rowid, f.rank FROM fts_episodes f
				 WHERE f.fts_episodes MATCH ?
				   AND EXISTS (SELECT 1 FROM episodic_memory e WHERE e.rowid = f.rowid AND e.superseded_by IS NULL
			       AND (e.valid_until IS NULL OR e.valid_until > ?))
				 ORDER BY f.rank, f.rowid LIMIT ?`)
			.all(ftsQuery, new Date().toISOString(), k) as Record<string, unknown>[];
		if (rows.length === 0 && hasCjk(query)) return cjkLikeSearch(db, query, k, false) as FtsRankResult[];
		return rows.map(row => ({ rowid: Number(row.rowid), rank: Number(row.rank) }));
	} catch {
		return [];
	}
}

export function ftsSearchWorking(db: Database, query: string, k = 20): WorkingFtsRankResult[] {
	const ftsQuery = buildFtsQuery(query);
	if (!ftsQuery) return hasCjk(query) ? (cjkLikeSearch(db, query, k, true) as WorkingFtsRankResult[]) : [];
	try {
		const rows = db
			.query(`SELECT f.id, f.rank FROM fts_working f
				 WHERE f.fts_working MATCH ?
				   AND EXISTS (SELECT 1 FROM working_memory w WHERE w.id = f.id AND w.superseded_by IS NULL
				       AND (w.valid_until IS NULL OR w.valid_until > ?))
				 ORDER BY f.rank, f.id LIMIT ?`)
			.all(ftsQuery, new Date().toISOString(), k) as Record<string, unknown>[];
		if (rows.length === 0 && hasCjk(query)) return cjkLikeSearch(db, query, k, true) as WorkingFtsRankResult[];
		return rows.map(row => ({ id: String(row.id), rank: Number(row.rank) }));
	} catch {
		return [];
	}
}

export function encodeVector(embedding: readonly number[]): string {
	return JSON.stringify(embedding);
}

export function decodeVector(value: string | null | undefined): Vector | null {
	if (!value) return null;
	try {
		const parsed = JSON.parse(value) as unknown;
		if (!Array.isArray(parsed)) return null;
		const vector: number[] = [];
		for (const item of parsed) {
			if (typeof item !== "number" || !Number.isFinite(item)) return null;
			vector.push(item);
		}
		return vector;
	} catch {
		return null;
	}
}

export function vecAvailable(db: Database): boolean {
	return tableExists(db, "vec_episodes");
}

export function effectiveVecType(db: Database): "float32" | "int8" | "bit" {
	if (!vecAvailable(db)) return "float32";
	try {
		const row = db.query("SELECT sql FROM sqlite_master WHERE type='table' AND name='vec_episodes'").get() as {
			sql?: string;
		} | null;
		const sql = row?.sql ?? "";
		if (sql.includes("int8")) return "int8";
		if (sql.includes("bit")) return "bit";
	} catch {
		return "float32";
	}
	return "float32";
}

export function vecInsert(db: Database, rowid: number, embedding: readonly number[]): void {
	const vecType = effectiveVecType(db);
	const embJson = encodeVector(embedding);
	if (vecType === "bit") {
		db.query("INSERT INTO vec_episodes(rowid, embedding) VALUES (?, vec_quantize_binary(?))").run(rowid, embJson);
	} else if (vecType === "int8") {
		db.query("INSERT INTO vec_episodes(rowid, embedding) VALUES (?, vec_quantize_int8(?, 'unit'))").run(
			rowid,
			embJson,
		);
	} else {
		db.query("INSERT INTO vec_episodes(rowid, embedding) VALUES (?, ?)").run(rowid, embJson);
	}
}

export function vecSearch(db: Database, embedding: readonly number[], k = 20): VectorDistanceResult[] {
	const vecType = effectiveVecType(db);
	const embJson = encodeVector(embedding);
	const limit = Math.max(0, Math.trunc(k));
	try {
		let rows: Record<string, unknown>[];
		if (vecType === "bit") {
			rows = db
				.query(
					`SELECT rowid, distance FROM vec_episodes WHERE embedding MATCH vec_quantize_binary(?) ORDER BY distance LIMIT ${limit}`,
				)
				.all(embJson) as Record<string, unknown>[];
		} else if (vecType === "int8") {
			rows = db
				.query(
					`SELECT rowid, distance FROM vec_episodes WHERE embedding MATCH vec_quantize_int8(?, "unit") AND k=${limit} ORDER BY distance`,
				)
				.all(embJson) as Record<string, unknown>[];
		} else {
			rows = db
				.query(`SELECT rowid, distance FROM vec_episodes WHERE embedding MATCH ? ORDER BY distance LIMIT ${limit}`)
				.all(embJson) as Record<string, unknown>[];
		}
		return rows.map(row => ({ rowid: Number(row.rowid), distance: Number(row.distance) }));
	} catch {
		return [];
	}
}

export function inMemoryVecSearch(db: Database, queryEmbedding: readonly number[], k = 20): VectorDistanceResult[] {
	if (queryEmbedding.length === 0) return [];
	try {
		const rows = db
			.query(`
				SELECT em.rowid, me.memory_id, me.embedding_json
				FROM memory_embeddings me
				JOIN episodic_memory em ON me.memory_id = em.id
				LIMIT 10000
			`)
			.all() as Record<string, unknown>[];
		const index = buildExactVectorIndex(
			rows.map(row => ({ id: Number(row.rowid), vector: decodeVector(String(row.embedding_json ?? "")) })),
		);
		return searchExactVectorIndex(index, queryEmbedding, k).map(hit => ({ rowid: hit.id, distance: 1 - hit.score }));
	} catch {
		return [];
	}
}

export function workingMemoryVecSearch(
	db: Database,
	queryEmbedding: readonly number[],
	k = 20,
	now: Date = new Date(),
): WorkingVectorResult[] {
	if (queryEmbedding.length === 0) return [];
	try {
		const limit = process.env.MNEMOPI_BEAM_MODE ? 500_000 : 50_000;
		const rows = db
			.query(`
				SELECT wm.id, me.embedding_json
				FROM memory_embeddings me
				JOIN working_memory wm ON me.memory_id = wm.id
				WHERE wm.superseded_by IS NULL
				  AND (wm.valid_until IS NULL OR wm.valid_until > ?)
				LIMIT ?
			`)
			.all(now.toISOString(), limit) as Record<string, unknown>[];
		const index = buildExactVectorIndex(
			rows.map(row => ({ id: String(row.id), vector: decodeVector(String(row.embedding_json ?? "")) })),
		);
		return searchExactVectorIndex(index, queryEmbedding, k).map(hit => ({ id: hit.id, sim: hit.score }));
	} catch {
		return [];
	}
}

export function normalizeMetadata(input: unknown): Metadata {
	if (input == null) return {};
	if (typeof input === "string") {
		try {
			return normalizeMetadata(JSON.parse(input) as unknown);
		} catch {
			return {};
		}
	}
	if (typeof input !== "object" || Array.isArray(input)) return {};
	const out: Metadata = {};
	for (const key in input) {
		const normalized = normalizeJsonValue((input as Record<string, unknown>)[key]);
		if (normalized !== undefined) out[key] = normalized;
	}
	return out;
}

function normalizeJsonValue(value: unknown): JsonValue | undefined {
	if (value == null || typeof value === "string" || typeof value === "boolean") return value;
	if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
	if (Array.isArray(value)) {
		const out: JsonValue[] = [];
		for (const item of value) {
			const normalized = normalizeJsonValue(item);
			if (normalized !== undefined) out.push(normalized);
		}
		return out;
	}
	if (typeof value === "object") {
		const out: Record<string, JsonValue> = {};
		for (const key in value) {
			const normalized = normalizeJsonValue((value as Record<string, unknown>)[key]);
			if (normalized !== undefined) out[key] = normalized;
		}
		return out;
	}
	return undefined;
}

export function metadataJson(input: unknown): string {
	return JSON.stringify(normalizeMetadata(input));
}

export function detectLanguage(text: string): string {
	if (!text) return "en";
	const lower = text.toLowerCase();
	const cyrillic = "абвгдеёжзийклмнопрстуфхцчшщъыьэюя";
	let russianChars = 0;
	for (const ch of lower) if (cyrillic.includes(ch)) russianChars += 1;
	if (russianChars >= 5) return "ru";
	if (russianChars >= 2) {
		const ruMarkers = new Set([
			"я",
			"ты",
			"он",
			"она",
			"оно",
			"мы",
			"вы",
			"они",
			"не",
			"на",
			"в",
			"с",
			"по",
			"для",
			"что",
			"как",
			"это",
			"так",
			"но",
			"да",
			"нет",
			"уже",
			"ещё",
			"мой",
			"твой",
			"наш",
			"ваш",
			"этот",
			"тот",
		]);
		if (intersectionCount(words(lower), ruMarkers) >= 2) return "ru";
	}
	if (["ä", "ö", "ü", "ß"].some(ch => lower.includes(ch))) return "de";
	const germanMarkers = new Set([
		"ich",
		"du",
		"wir",
		"ist",
		"nicht",
		"für",
		"und",
		"der",
		"die",
		"das",
		"ein",
		"eine",
		"kein",
		"keine",
		"mein",
		"meine",
		"dann",
		"auch",
		"immer",
		"nie",
		"niemals",
		"mag",
		"will",
		"möchte",
		"kann",
		"kannst",
		"können",
		"habe",
		"hast",
		"hat",
		"haben",
		"bin",
		"bist",
		"sind",
		"seid",
		"einen",
		"einer",
		"eines",
		"dem",
		"den",
		"beim",
		"zum",
		"zur",
		"nach",
		"mit",
		"von",
		"bei",
		"aus",
		"auf",
		"vor",
		"aber",
		"oder",
		"weil",
		"denn",
		"dass",
		"sehr",
		"schon",
		"noch",
		"mal",
		"man",
		"nur",
		"wenn",
		"wie",
		"als",
		"doch",
		"gerne",
		"gern",
		"lieber",
		"einfach",
		"eigentlich",
		"vielleicht",
		"natürlich",
		"genau",
		"bereits",
		"eben",
	]);
	const textWords = words(lower);
	if (intersectionCount(textWords, germanMarkers) >= 2) return "de";
	if (["ñ", "á", "é", "í", "ó", "ú", "ü", "¿", "¡"].some(ch => lower.includes(ch))) return "es";
	const spanishMarkers = new Set([
		"y",
		"de",
		"por",
		"con",
		"para",
		"que",
		"qué",
		"como",
		"el",
		"la",
		"lo",
		"los",
		"las",
		"un",
		"una",
		"del",
		"este",
		"esta",
		"esto",
		"ese",
		"esa",
		"eso",
		"aquel",
		"mi",
		"mis",
		"tu",
		"tus",
		"su",
		"sus",
		"es",
		"está",
		"son",
		"hay",
		"tiene",
		"puede",
		"más",
		"no",
		"también",
		"si",
		"ya",
		"nunca",
		"he",
		"se",
		"me",
		"te",
		"le",
		"a",
		"yo",
		"ante",
		"bajo",
		"contra",
		"desde",
		"en",
		"entre",
		"hacia",
		"hasta",
		"según",
		"sin",
		"sobre",
		"tras",
		"todo",
		"toda",
		"cada",
		"muy",
		"pero",
		"siempre",
		"usa",
		"hacer",
		"antes",
		"recuerda",
		"evita",
	]);
	if (intersectionCount(textWords, spanishMarkers) >= 2) return "es";
	if (["à", "è", "é", "ì", "ò", "ù"].some(ch => lower.includes(ch))) {
		const italianMarkers = new Set([
			"e",
			"il",
			"la",
			"i",
			"le",
			"di",
			"che",
			"non",
			"un",
			"una",
			"per",
			"è",
			"in",
			"sono",
			"mi",
			"ha",
			"ma",
			"lo",
			"se",
			"su",
			"con",
			"da",
			"come",
			"questo",
			"quello",
			"anche",
			"o",
			"ho",
			"ci",
			"si",
			"perché",
			"perche",
			"quando",
			"chi",
			"dove",
			"molto",
			"del",
			"della",
			"delle",
			"dei",
			"degli",
			"nel",
			"nella",
			"sul",
			"sulla",
			"sui",
			"sulle",
			"al",
			"alla",
			"agli",
			"alle",
		]);
		if (intersectionCount(textWords, italianMarkers) >= 2) return "it";
	}
	return "en";
}

function words(text: string): Set<string> {
	return new Set(Array.from(text.matchAll(WORD_RE), match => match[0] ?? ""));
}

function intersectionCount(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
	let count = 0;
	for (const item of left) if (right.has(item)) count += 1;
	return count;
}

export function memoryRowMetadata(row: unknown): Metadata {
	return normalizeMetadata(rowValue<unknown>(row, "metadata_json") ?? rowValue<unknown>(row, "metadata"));
}
export {
	cosineSimilarity,
	hammingDistance,
	informationTheoreticScore,
	maximallyInformativeBinarization,
	quantizeInt8,
} from "../binary-vectors";
export { cjkFtsTerms, containsSpacelessCjk, ftsQueryTerms, recallTokens, sha256Hex16 };

/** Identifies one freshly stored memory whose embedding still needs to be derived. */
export interface EmbedItem {
	readonly memoryId: string;
	readonly content: string;
}

async function runEmbedding(beam: BeamMemoryState, items: readonly EmbedItem[]): Promise<void> {
	try {
		const matrix = await embed(items.map(item => item.content));
		if (matrix === null) return;
		const model = currentEmbeddingModel();
		using insertEmbedding = beam.db.prepare(
			"INSERT OR REPLACE INTO memory_embeddings(memory_id, embedding_json, model) VALUES (?, ?, ?)",
		);
		const insertMany = beam.db.transaction((rows: readonly EmbedItem[]) => {
			for (let i = 0; i < rows.length; i += 1) {
				const vector = matrix[i];
				const item = rows[i];
				if (vector === undefined || item === undefined) continue;
				insertEmbedding.run(item.memoryId, JSON.stringify(Array.from(vector)), model);
			}
		});
		insertMany(items);
	} catch (error) {
		// Background embedding generation is best-effort: a failing provider, a closed DB
		// during shutdown, or a transient API error must never disrupt the synchronous
		// remember()/consolidate() that scheduled it. Production recall silently degrades
		// to FTS-only for the affected rows, which is the same shape as a misconfigured
		// provider. Log so the failure is diagnosable (#2322).
		logger[mnemopiDebugEnabled() ? "warn" : "debug"]("mnemopi: background embedding failed", {
			itemCount: items.length,
			error: String(error),
		});
	}
}

/**
 * Schedule background embedding generation for one or more freshly stored memories.
 *
 * Mirrors the `scheduleFactExtraction` pattern in `beam/store.ts`: `remember()`,
 * `rememberBatch()`, and `consolidateToEpisodic()` are synchronous, but `embed()` is
 * async (it may hit an HTTP provider), so the task is fired-and-forgotten and tracked
 * on `beam.pendingExtractions` so tests and graceful shutdown can drain it via
 * `flushExtractions()`. The active runtime options (provider, model, API URL/key) are
 * captured here and re-entered inside the task because the `AsyncLocalStorage` scope
 * set by `Mnemopi.#withRuntimeOptions` has already exited by the time the task runs.
 */
export function scheduleEmbedding(beam: BeamMemoryState, items: readonly EmbedItem[]): void {
	const cleaned = items.filter(item => item.content.trim() !== "");
	if (cleaned.length === 0) return;
	const runtimeOptions = getMnemopiRuntimeOptions();
	const task = withMnemopiRuntimeOptions(runtimeOptions, () => runEmbedding(beam, cleaned));
	const pending = beam.pendingExtractions;
	if (pending !== undefined) {
		pending.add(task);
		void task.finally(() => pending.delete(task));
	}
}
