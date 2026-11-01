import type { Database } from "bun:sqlite";
import { closeQuietly, type DatabasePath, openDatabase, transaction } from "../db";

export interface Gist {
	readonly id: string;
	readonly text: string;
	readonly timestamp: string;
	readonly participants: readonly string[];
	readonly location: string | null;
	readonly emotion: string | null;
	readonly timeScope: string | null;
}

export interface Fact {
	readonly id: string;
	readonly subject: string;
	readonly predicate: string;
	readonly object: string;
	readonly timestamp: string;
	readonly confidence: number;
	readonly temporalQualifier?: string | null;
	/** Memory the fact was extracted from (`facts.source_msg_id`), when stored. */
	readonly memoryId?: string | null;
}

export interface GraphEdge {
	readonly source: string;
	readonly target: string;
	readonly edgeType: string;
	readonly weight: number;
	readonly timestamp: string;
}

export interface RelatedMemory {
	readonly memoryId: string;
	readonly edgeType: string;
	readonly weight: number;
	readonly depth: number;
}

export interface GraphStats {
	readonly gists: number;
	readonly facts: number;
	readonly edges: number;
	readonly totalNodes: number;
}

export interface IngestOptions {
	readonly sessionId?: string;
	readonly linkExisting?: boolean;
	readonly minLinkScore?: number;
	readonly extractEntities?: boolean;
}

export interface IngestResult {
	readonly memoryId: string;
	readonly gist: Gist;
	readonly facts: readonly Fact[];
	readonly edges: readonly GraphEdge[];
}

export interface EpisodicGraphOptions {
	readonly db?: Database;
	readonly dbPath?: DatabasePath;
}

interface CountRow {
	readonly count: number;
}

interface GistRow {
	readonly id: string;
	readonly text: string;
	readonly timestamp: string | null;
	readonly participants_json: string | null;
	readonly location: string | null;
	readonly emotion: string | null;
	readonly time_scope: string | null;
	readonly memory_id: string | null;
}

interface FactRow {
	readonly fact_id: string;
	readonly session_id: string | null;
	readonly subject: string;
	readonly predicate: string;
	readonly object: string;
	readonly timestamp: string | null;
	readonly source_msg_id: string | null;
	readonly confidence: number | null;
}

interface EdgeRow {
	readonly id?: number;
	readonly source: string;
	readonly target: string;
	readonly edge_type: string;
	readonly weight: number;
	readonly timestamp: string | null;
}

interface MemoryLivenessRow {
	readonly id: string;
	readonly live: number;
}

const EXTRACT_FACTS_MAX_CONTENT_LEN = 4096;
const MAX_FACTS_PER_MEMORY = 5;
const DEFAULT_LINK_THRESHOLD = 0.35;
const MAX_SQL_IDS_PER_CHUNK = 900;
const LINK_CANDIDATE_BATCH_SIZE = 256;
const LIVE_MEMORY_SQL = "superseded_by IS NULL AND (valid_until IS NULL OR valid_until > ?)";

/** Clause connector that ends a fact object, so the next clause is never swallowed into it. */
const CLAUSE_BREAK = String.raw`(?:and|but|or|nor|yet|then|because|so|while|which|that|who|whom|whose|when|where|if|since|although|though|unless|until|whereas)\b`;
/** Optional leading article; must be a whole word, so `active` never loses its `a` and `an` never splits. */
const ARTICLE = String.raw`(?:(?:an?|the)\s+)?`;
/** Fact subject: from the first capitalized word up to the predicate. */
const SUBJECT = String.raw`\b([A-Z][a-zA-Z\s]+?)`;
/**
 * Start of another extractable clause (`Bob is …`, `Bob Jones is …`, `the runtime has …`). Catches clauses
 * joined by a connector missing from {@link CLAUSE_BREAK}, so their whole subject is left for the next match.
 */
const NEXT_CLAUSE = String.raw`${ARTICLE}(?:[A-Z][a-zA-Z\d]*[ \t]+)*[a-zA-Z\d]+\s+(?:is|has|uses?|using|used|works?)\b`;

/**
 * Captures a whole phrase of `word`s up to punctuation, a line break, a clause connector, or the
 * subject of another clause. Connectors may start an object (for example, `that permission`) but
 * terminate it after the first token.
 * Each word must end on a token boundary; a phrase whose first word does not yields no match.
 */
function phrase(word: string): string {
	const token = String.raw`${word}(?:['-]${word})*\b`;
	return String.raw`(${token}(?:[ \t]+(?!${CLAUSE_BREAK}|${NEXT_CLAUSE})${token})*)`;
}

const IS_FACT = new RegExp(String.raw`${SUBJECT}\s+is\s+${ARTICLE}${phrase("[a-zA-Z]+")}`, "g");
const HAS_FACT = new RegExp(String.raw`${SUBJECT}\s+has\s+${ARTICLE}${phrase(String.raw`[a-zA-Z\d]+`)}`, "g");
const USES_FACT = new RegExp(String.raw`${SUBJECT}\s+(?:uses?|using|used)\s+${ARTICLE}${phrase("[a-zA-Z]+")}`, "g");
const WORKS_AT_FACT = new RegExp(
	String.raw`${SUBJECT}\s+works?\s+(?:at|for|with)\s+([A-Z][a-zA-Z]*(?:[ \t]+[A-Z][a-zA-Z]*)*)\b`,
	"g",
);

function nowIso(): string {
	return new Date().toISOString();
}

function partitionByLiveness(rows: readonly MemoryLivenessRow[], live: Set<string>, retired: Set<string>): void {
	for (const row of rows) {
		if (row.live === 1) live.add(row.id);
		else retired.add(row.id);
	}
}

function unique(values: Iterable<string>, limit = Number.MAX_SAFE_INTEGER): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const raw of values) {
		const value = raw.trim();
		if (value.length === 0) continue;
		const key = value.toLocaleLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(value);
		if (out.length >= limit) break;
	}
	return out;
}

/**
 * Capitalized proper nouns of at most two words, in any cased script (Latin, Greek,
 * Cyrillic, Vietnamese, …), deduplicated case-insensitively. Gist participants are
 * stored with this extractor and the polyphonic graph voice looks gists up with it, so
 * a query entity matches a stored participant exactly (`findGistsByParticipant`).
 * Unicode property escapes and `\p{L}`-based lookaround boundaries replace `[A-Z][a-z]+`
 * and ASCII `\b`, which matched no non-English name (issues #7918, #16723).
 */
export function extractProperNouns(text: string): string[] {
	return unique(
		Array.from(
			text.matchAll(/(?<![\p{L}\p{N}_])(\p{Lu}\p{Ll}+(?:\s+\p{Lu}\p{Ll}+)?)(?![\p{L}\p{N}_])/gu),
			match => match[1] ?? "",
		),
	);
}

function parseJsonStringArray(value: string | null): string[] {
	if (value === null || value === "") return [];
	try {
		const parsed: unknown = JSON.parse(value);
		if (!Array.isArray(parsed)) return [];
		const strings: string[] = [];
		for (const item of parsed) {
			if (typeof item === "string") strings.push(item);
		}
		return strings;
	} catch {
		return [];
	}
}

function rowToGist(row: GistRow): Gist {
	return {
		id: row.id,
		text: row.text,
		timestamp: row.timestamp ?? "",
		participants: parseJsonStringArray(row.participants_json),
		location: row.location,
		emotion: row.emotion,
		timeScope: row.time_scope,
	};
}

function rowToFact(row: FactRow): Fact {
	return {
		id: row.fact_id,
		subject: row.subject,
		predicate: row.predicate,
		object: row.object,
		timestamp: row.timestamp ?? "",
		confidence: row.confidence ?? 0.5,
		temporalQualifier: null,
		memoryId: row.source_msg_id,
	};
}

function edgeFromRow(row: EdgeRow): GraphEdge {
	return {
		source: row.source,
		target: row.target,
		edgeType: row.edge_type,
		weight: row.weight,
		timestamp: row.timestamp ?? "",
	};
}

function clampWeight(weight: number): number {
	if (!Number.isFinite(weight)) return 1;
	if (weight < 0) return 0;
	if (weight > 1) return 1;
	return weight;
}

function normalizeEntity(value: string | null | undefined): string | null {
	if (value == null) return null;
	const normalized = value.trim().toLocaleLowerCase();
	return normalized.length > 0 ? normalized : null;
}

function lowerSet(values: readonly (string | null | undefined)[]): Set<string> {
	const out = new Set<string>();
	for (const value of values) {
		const norm = normalizeEntity(value);
		if (norm !== null) out.add(norm);
	}
	return out;
}

const CONTENT_STOPWORDS = new Set([
	"the",
	"and",
	"for",
	"with",
	"that",
	"this",
	"from",
	"into",
	"onto",
	"about",
	"was",
	"were",
	"are",
	"is",
	"has",
	"have",
	"had",
	"she",
	"he",
	"they",
	"them",
	"their",
	"our",
	"new",
]);

function contentTokenSet(text: string): Set<string> {
	const out = new Set<string>();
	for (const match of text.toLocaleLowerCase().matchAll(/[\p{L}\p{N}_-]+/gu)) {
		const token = match[0] ?? "";
		if (token.length < 3 || CONTENT_STOPWORDS.has(token)) continue;
		out.add(token);
	}
	return out;
}

function jaccard(left: Set<string>, right: Set<string>): number {
	if (left.size === 0 || right.size === 0) return 0;
	let intersection = 0;
	for (const item of left) {
		if (right.has(item)) intersection++;
	}
	return intersection / (left.size + right.size - intersection);
}

function overlapScore(left: Set<string>, right: Set<string>): number {
	if (left.size === 0 || right.size === 0) return 0;
	let hits = 0;
	for (const item of left) {
		if (right.has(item)) hits++;
	}
	return hits / Math.max(left.size, right.size);
}

export class EpisodicGraph {
	readonly db: Database;
	readonly dbPath: DatabasePath;
	readonly ownsConnection: boolean;

	constructor(options: EpisodicGraphOptions = {}) {
		this.dbPath = options.dbPath ?? ":memory:";
		this.db = options.db ?? openDatabase(this.dbPath);
		this.ownsConnection = options.db === undefined;
		this.initTables();
	}

	private initTables(): void {
		this.db.run(`
			CREATE TABLE IF NOT EXISTS gists (
				id TEXT PRIMARY KEY,
				text TEXT NOT NULL,
				timestamp TEXT,
				participants_json TEXT,
				location TEXT,
				emotion TEXT,
				time_scope TEXT,
				memory_id TEXT,
				created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
			)
		`);
		this.db.run(`
			CREATE TABLE IF NOT EXISTS facts (
				fact_id TEXT PRIMARY KEY,
				session_id TEXT DEFAULT 'default',
				subject TEXT NOT NULL,
				predicate TEXT NOT NULL,
				object TEXT NOT NULL,
				timestamp TEXT,
				source_msg_id TEXT,
				confidence REAL DEFAULT 0.5,
				created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
			)
		`);
		this.db.run("CREATE INDEX IF NOT EXISTS idx_facts_subject ON facts(subject)");
		this.db.run("CREATE INDEX IF NOT EXISTS idx_facts_predicate ON facts(predicate)");
		this.db.run("CREATE INDEX IF NOT EXISTS idx_facts_object ON facts(object)");
		this.db.run("CREATE INDEX IF NOT EXISTS idx_facts_source_msg ON facts(source_msg_id)");
		this.db.run(`
			CREATE TABLE IF NOT EXISTS graph_edges (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				source TEXT NOT NULL,
				target TEXT NOT NULL,
				edge_type TEXT NOT NULL,
				weight REAL DEFAULT 1.0,
				timestamp TEXT,
				created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
				UNIQUE(source, target, edge_type)
			)
		`);
		this.db.run("CREATE INDEX IF NOT EXISTS idx_edges_source ON graph_edges(source)");
		this.db.run("CREATE INDEX IF NOT EXISTS idx_edges_target ON graph_edges(target)");
		this.db.run("CREATE INDEX IF NOT EXISTS idx_edges_type ON graph_edges(edge_type)");
	}

	extractGist(content: string, memoryId: string): Gist {
		return {
			id: `gist_${memoryId}`,
			text: this.createSummary(content),
			timestamp: nowIso(),
			participants: this.extractParticipants(content),
			location: this.extractLocation(content),
			emotion: this.extractEmotion(content),
			timeScope: this.extractTemporalScope(content),
		};
	}
	extractFacts(content: string, memoryId: string): Fact[] {
		const bounded =
			content.length > EXTRACT_FACTS_MAX_CONTENT_LEN ? content.slice(0, EXTRACT_FACTS_MAX_CONTENT_LEN) : content;
		const facts: Fact[] = [];
		const pushFact = (subject: string, predicate: string, object: string, confidence: number): void => {
			const cleanSubject = subject.trim();
			const cleanObject = object.trim();
			if (cleanSubject.length <= 2 || cleanObject.length <= 2 || facts.length >= MAX_FACTS_PER_MEMORY) return;
			facts.push({
				id: `fact_${memoryId}_${facts.length}`,
				subject: cleanSubject,
				predicate,
				object: cleanObject,
				timestamp: nowIso(),
				confidence,
				temporalQualifier: null,
			});
		};

		for (const match of bounded.matchAll(IS_FACT)) pushFact(match[1] ?? "", "is", match[2] ?? "", 0.7);
		for (const match of bounded.matchAll(HAS_FACT)) pushFact(match[1] ?? "", "has", match[2] ?? "", 0.6);
		for (const match of bounded.matchAll(USES_FACT)) pushFact(match[1] ?? "", "uses", match[2] ?? "", 0.6);
		for (const match of bounded.matchAll(WORKS_AT_FACT)) pushFact(match[1] ?? "", "works_at", match[2] ?? "", 0.7);
		return facts;
	}
	storeGist(gist: Gist, memoryId: string): void {
		this.db.run(
			`INSERT OR REPLACE INTO gists
				(id, text, timestamp, participants_json, location, emotion, time_scope, memory_id)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				gist.id,
				gist.text,
				gist.timestamp,
				JSON.stringify(gist.participants),
				gist.location,
				gist.emotion,
				gist.timeScope,
				memoryId,
			],
		);
	}
	getGist(id: string): Gist | null {
		const row = this.db.query("SELECT * FROM gists WHERE id = ?").get(id) as GistRow | null;
		return row === null ? null : rowToGist(row);
	}
	storeFact(fact: Fact, memoryId: string, sessionId = "default"): void {
		this.db.run(
			`INSERT OR REPLACE INTO facts
				(fact_id, session_id, subject, predicate, object, timestamp, source_msg_id, confidence)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			[fact.id, sessionId, fact.subject, fact.predicate, fact.object, fact.timestamp, memoryId, fact.confidence],
		);
	}
	getFact(id: string): Fact | null {
		const row = this.db.query("SELECT * FROM facts WHERE fact_id = ?").get(id) as FactRow | null;
		return row === null ? null : rowToFact(row);
	}
	addEdge(edge: GraphEdge): void {
		this.db.run(
			`INSERT INTO graph_edges (source, target, edge_type, weight, timestamp)
				VALUES (?, ?, ?, ?, ?)
				ON CONFLICT(source, target, edge_type) DO UPDATE SET
					weight = excluded.weight,
					timestamp = excluded.timestamp`,
			[edge.source, edge.target, edge.edgeType, clampWeight(edge.weight), edge.timestamp],
		);
	}
	getEdges(source: string | null = null): GraphEdge[] {
		const rows =
			source === null
				? (this.db
						.query("SELECT source, target, edge_type, weight, timestamp FROM graph_edges ORDER BY id")
						.all() as EdgeRow[])
				: (this.db
						.query(
							"SELECT source, target, edge_type, weight, timestamp FROM graph_edges WHERE source = ? OR target = ? ORDER BY id",
						)
						.all(source, source) as EdgeRow[]);
		return rows.map(edgeFromRow);
	}
	findRelatedMemories(memoryId: string, depth = 2, edgeType = "", minWeight = 0): RelatedMemory[] {
		const results: RelatedMemory[] = [];
		let currentLevel = new Set([memoryId]);
		const seen = new Set([memoryId]);
		const maxDepth = Math.max(0, Math.trunc(depth));
		const threshold = clampWeight(minWeight);

		for (let hop = 1; hop <= maxDepth; hop++) {
			if (currentLevel.size === 0) break;
			const nextLevel = new Set<string>();
			const edges = this.findEdgesTouching([...currentLevel], edgeType, threshold);
			const edgesByNode = new Map<string, GraphEdge[]>();
			for (const mem of currentLevel) edgesByNode.set(mem, []);
			for (const edge of edges) {
				edgesByNode.get(edge.source)?.push(edge);
				if (edge.target !== edge.source) edgesByNode.get(edge.target)?.push(edge);
			}
			for (const mem of currentLevel) {
				for (const edge of edgesByNode.get(mem) ?? []) {
					const neighbor = edge.source === mem ? edge.target : edge.source;
					if (seen.has(neighbor)) continue;
					seen.add(neighbor);
					nextLevel.add(neighbor);
					results.push({
						memoryId: neighbor,
						edgeType: edge.edgeType,
						weight: edge.weight,
						depth: hop,
					});
				}
			}
			currentLevel = nextLevel;
		}
		return results;
	}
	/**
	 * Edges touching any of `nodeIds` in one query, strongest first, at most `limit` rows.
	 * Batched frontier expansion for bounded traversals; see {@link findRelatedMemories}
	 * for the per-node walk.
	 */
	findEdgesTouching(
		nodeIds: readonly string[],
		edgeType = "",
		minWeight = 0,
		limit = Number.MAX_SAFE_INTEGER,
	): GraphEdge[] {
		const max = Math.max(0, Math.trunc(limit));
		if (nodeIds.length === 0 || max === 0) return [];
		const threshold = clampWeight(minWeight);
		const seenKeys = new Set<string>();
		const collected: Array<{ id: number; edge: GraphEdge }> = [];
		const hasSqlLimit = Number.isFinite(limit) && max > 0;

		for (let i = 0; i < nodeIds.length; i += MAX_SQL_IDS_PER_CHUNK) {
			const chunk = nodeIds.slice(i, i + MAX_SQL_IDS_PER_CHUNK);
			const placeholders = chunk.map(() => "?").join(", ");
			const limitClause = hasSqlLimit ? " LIMIT ?" : "";
			const rows =
				edgeType.length > 0
					? (this.db
							.query(
								`SELECT id, source, target, edge_type, weight, timestamp FROM graph_edges
					 WHERE (source IN (${placeholders}) OR target IN (${placeholders})) AND edge_type = ? AND weight >= ?
					 ORDER BY weight DESC, id${limitClause}`,
							)
							.all(...chunk, ...chunk, edgeType, threshold, ...(hasSqlLimit ? [max] : [])) as EdgeRow[])
					: (this.db
							.query(
								`SELECT id, source, target, edge_type, weight, timestamp FROM graph_edges
					 WHERE (source IN (${placeholders}) OR target IN (${placeholders})) AND weight >= ?
					 ORDER BY weight DESC, id${limitClause}`,
							)
							.all(...chunk, ...chunk, threshold, ...(hasSqlLimit ? [max] : [])) as EdgeRow[]);

			for (const row of rows) {
				const key = `${row.source}\0${row.target}\0${row.edge_type}`;
				if (seenKeys.has(key)) continue;
				seenKeys.add(key);
				collected.push({ id: row.id ?? 0, edge: edgeFromRow(row) });
			}
		}

		collected.sort((a, b) => {
			if (b.edge.weight !== a.edge.weight) return b.edge.weight - a.edge.weight;
			return a.id - b.id;
		});
		const selected = collected.length > max ? collected.slice(0, max) : collected;
		return selected.map(item => item.edge);
	}
	findFactsBySubject(subject: string): Fact[] {
		const rows = this.db
			.query("SELECT * FROM facts WHERE subject = ? ORDER BY confidence DESC, timestamp DESC")
			.all(subject) as FactRow[];
		return rows.map(rowToFact);
	}
	findGistsByParticipant(participant: string): Gist[] {
		const rows = this.db
			.query("SELECT * FROM gists WHERE participants_json LIKE ? ORDER BY timestamp DESC")
			.all(`%"${participant}"%`) as GistRow[];
		return rows.map(rowToGist);
	}
	scoreMemoryLink(sourceMemoryId: string, targetMemoryId: string): number {
		const left = this.memoryFeatures(sourceMemoryId);
		const right = this.memoryFeatures(targetMemoryId);
		return this.scoreFeatures(left, right);
	}
	ingestMemory(content: string, memoryId: string, options: IngestOptions = {}): IngestResult {
		const sessionId = options.sessionId ?? "default";
		const linkExisting = options.linkExisting ?? true;
		const minLinkScore = options.minLinkScore ?? DEFAULT_LINK_THRESHOLD;
		const extractEntities = options.extractEntities ?? true;
		const gist = this.extractGist(content, memoryId);
		const facts = extractEntities ? this.extractFacts(content, memoryId) : [];
		// One transaction for every gist/fact/edge write: autocommitted, each
		// `addEdge` paid its own WAL commit (an fsync), so linking a memory
		// against a large bank blocked the caller's event loop for seconds (#14998).
		return transaction(this.db, () => {
			const edges: GraphEdge[] = [];
			const timestamp = nowIso();

			const previousMemoryIds = linkExisting ? this.knownMemoryIds(memoryId) : [];
			this.storeGist(gist, memoryId);
			const gistEdge = { source: memoryId, target: gist.id, edgeType: "ctx", weight: 1, timestamp };
			this.addEdge(gistEdge);
			edges.push(gistEdge);

			for (const fact of facts) {
				this.storeFact(fact, memoryId, sessionId);
				const edge = {
					source: gist.id,
					target: fact.id,
					edgeType: "rel",
					weight: fact.confidence,
					timestamp,
				};
				this.addEdge(edge);
				edges.push(edge);
			}

			if (linkExisting) {
				const sourceTokens = contentTokenSet(content);
				const leftRows = this.db
					.query("SELECT subject, object FROM facts WHERE source_msg_id = ?")
					.all(memoryId) as FactRow[];
				const leftEntities = lowerSet(leftRows.flatMap(row => [row.subject, row.object]));

				for (let i = 0; i < previousMemoryIds.length; i += LINK_CANDIDATE_BATCH_SIZE) {
					const chunk = previousMemoryIds.slice(i, i + LINK_CANDIDATE_BATCH_SIZE);
					const otherEntitiesMap = this.#entitySetsForMemories(chunk);
					const otherContentMap =
						sourceTokens.size > 0 ? this.#batchMemoryContent(chunk, timestamp) : new Map<string, string>();

					for (const otherId of chunk) {
						const otherContent = otherContentMap.get(otherId) ?? "";
						const lexicalScore =
							sourceTokens.size > 0
								? Math.round(jaccard(sourceTokens, contentTokenSet(otherContent)) * 1000) / 1000
								: 0;
						let wroteCtxEdge = false;
						if (lexicalScore >= minLinkScore) {
							const edge = {
								source: memoryId,
								target: otherId,
								edgeType: "related_to",
								weight: lexicalScore,
								timestamp,
							};
							this.addEdge(edge);
							edges.push(edge);
							const ctxEdge = {
								source: memoryId,
								target: otherId,
								edgeType: "ctx",
								weight: lexicalScore,
								timestamp,
							};
							this.addEdge(ctxEdge);
							edges.push(ctxEdge);
							wroteCtxEdge = true;
						}
						const rightEntities = otherEntitiesMap.get(otherId) ?? new Set();
						const entityScore = Math.round(overlapScore(leftEntities, rightEntities) * 1000) / 1000;
						if (entityScore > 0) {
							const edge = {
								source: memoryId,
								target: otherId,
								edgeType: "references",
								weight: entityScore,
								timestamp,
							};
							this.addEdge(edge);
							edges.push(edge);
						}
						if (!wroteCtxEdge && entityScore >= minLinkScore) {
							const ctxEdge = {
								source: memoryId,
								target: otherId,
								edgeType: "ctx",
								weight: entityScore,
								timestamp,
							};
							this.addEdge(ctxEdge);
							edges.push(ctxEdge);
						}
					}
				}
			}

			return { memoryId, gist, facts, edges };
		});
	}
	getStats(): GraphStats {
		const gists = this.count("gists");
		const facts = this.count("facts");
		const edges = this.count("graph_edges");
		return { gists, facts, edges, totalNodes: gists + facts };
	}
	close(): void {
		if (this.ownsConnection) closeQuietly(this.db);
	}

	private count(table: "gists" | "facts" | "graph_edges"): number {
		const row = this.db.query(`SELECT COUNT(*) AS count FROM ${table}`).get() as CountRow;
		return row.count;
	}

	private extractParticipants(content: string): string[] {
		// `\p{L}` boundaries, not ASCII `\b`: with `i`, `\b` matched the trailing `i` of
		// words like Vietnamese `tôi` as the pronoun `I` (issue #16723).
		const pronouns = Array.from(
			content.matchAll(/(?<![\p{L}\p{N}_])(I|you|we|they|he|she|it|me|us|them|him|her)(?![\p{L}\p{N}_])/giu),
			match => match[1] ?? "",
		);
		return unique([...extractProperNouns(content), ...pronouns], 5);
	}

	private extractTemporalScope(content: string): string | null {
		const patterns: readonly [RegExp, string][] = [
			[/\b(yesterday|today|tomorrow|now|soon|later|earlier)\b/i, "point_in_time"],
			[/\b(last\s+week|last\s+month|last\s+year|next\s+week)\b/i, "point_in_time"],
			[/\b(since|from|starting)\b.*\b(until|to|through|end)\b/i, "duration"],
			[/\b(between|from)\b.*\b(and|to)\b/i, "range"],
			[/\b\d{1,2}:\d{2}\s*(AM|PM|am|pm)?\b/, "point_in_time"],
			[/\b\d{4}-\d{2}-\d{2}\b/, "point_in_time"],
		];
		for (const [pattern, scope] of patterns) {
			if (pattern.test(content)) return scope;
		}
		return null;
	}

	private extractLocation(content: string): string | null {
		const properPlace =
			/\b(?:at|in|from)\s+([A-Z][a-zA-Z\s]+?)(?:\s+(?:yesterday|today|tomorrow|now|last|next|on|at)\b|$)/.exec(
				content,
			);
		if (properPlace?.[1] !== undefined) return properPlace[1].trim();
		const genericPlace = /\b(office|home|work|school|hospital|store|restaurant|building|room)\b/i.exec(content);
		return genericPlace?.[1] ?? null;
	}

	private extractEmotion(content: string): string | null {
		const lower = content.toLocaleLowerCase();
		if (
			["happy", "excited", "great", "awesome", "love", "enjoy", "glad", "pleased"].some(word => lower.includes(word))
		)
			return "positive";
		if (["sad", "angry", "frustrated", "upset", "hate", "disappointed", "worried"].some(word => lower.includes(word)))
			return "negative";
		if (["fine", "okay", "alright", "normal", "standard"].some(word => lower.includes(word))) return "neutral";
		return null;
	}

	private createSummary(content: string): string {
		const firstSentence = content.split(/[.!?]+/, 1)[0]?.trim() ?? "";
		if (firstSentence.length > 10) return firstSentence.slice(0, 100);
		return content.slice(0, 100).trim();
	}

	private knownMemoryIds(exclude: string): string[] {
		const now = nowIso();
		const ids = new Set<string>();
		const live = new Set<string>();
		const retired = new Set<string>();
		const gistRows = this.db
			.query("SELECT DISTINCT memory_id FROM gists WHERE memory_id IS NOT NULL AND memory_id != ?")
			.all(exclude) as { memory_id: string }[];
		for (const row of gistRows) ids.add(row.memory_id);
		try {
			const workingRows = this.db
				.query(`SELECT id, ${LIVE_MEMORY_SQL} AS live FROM working_memory WHERE id != ?`)
				.all(now, exclude) as MemoryLivenessRow[];
			partitionByLiveness(workingRows, live, retired);
		} catch {
			// Standalone graph stores do not have Beam memory tables.
		}
		try {
			const episodicRows = this.db
				.query(`SELECT id, ${LIVE_MEMORY_SQL} AS live FROM episodic_memory WHERE id != ?`)
				.all(now, exclude) as MemoryLivenessRow[];
			partitionByLiveness(episodicRows, live, retired);
		} catch {
			// Standalone graph stores do not have Beam memory tables.
		}
		for (const id of live) ids.add(id);
		for (const id of retired) if (!live.has(id)) ids.delete(id);
		return [...ids];
	}

	#forEachChunk<T>(
		items: readonly string[],
		fn: (chunk: readonly string[], placeholders: string) => T[],
		chunkSize = 500,
	): T[] {
		if (items.length === 0) return [];
		const result: T[] = [];
		for (let i = 0; i < items.length; i += chunkSize) {
			const chunk = items.slice(i, i + chunkSize);
			const placeholders = chunk.map(() => "?").join(", ");
			result.push(...fn(chunk, placeholders));
		}
		return result;
	}

	#entitySetsForMemories(memoryIds: readonly string[]): Map<string, Set<string>> {
		const result = new Map<string, Set<string>>();
		if (memoryIds.length === 0) return result;
		for (const id of memoryIds) {
			result.set(id, new Set());
		}
		const rows = this.#forEachChunk(
			memoryIds,
			(chunk, placeholders) =>
				this.db
					.query(`SELECT source_msg_id, subject, object FROM facts WHERE source_msg_id IN (${placeholders})`)
					.all(...chunk) as (FactRow & { source_msg_id: string })[],
		);
		for (const row of rows) {
			const set = result.get(row.source_msg_id);
			if (set) {
				const s = normalizeEntity(row.subject);
				if (s !== null) set.add(s);
				const o = normalizeEntity(row.object);
				if (o !== null) set.add(o);
			}
		}
		return result;
	}

	#batchMemoryContent(memoryIds: readonly string[], now: string): Map<string, string> {
		const contentMap = new Map<string, string>();
		if (memoryIds.length === 0) return contentMap;

		const remaining = new Set(memoryIds);

		try {
			const rows = this.#forEachChunk(
				[...remaining],
				(chunk, placeholders) =>
					this.db
						.query(`SELECT id, content FROM working_memory WHERE id IN (${placeholders}) AND ${LIVE_MEMORY_SQL}`)
						.all(...chunk, now) as { id: string; content: string }[],
			);
			for (const row of rows) {
				contentMap.set(row.id, row.content);
				remaining.delete(row.id);
			}
		} catch {
			// Standalone EpisodicGraph users may not have Beam tables.
		}

		if (remaining.size > 0) {
			try {
				const rows = this.#forEachChunk(
					[...remaining],
					(chunk, placeholders) =>
						this.db
							.query(
								`SELECT id, content FROM episodic_memory WHERE id IN (${placeholders}) AND ${LIVE_MEMORY_SQL}`,
							)
							.all(...chunk, now) as { id: string; content: string }[],
				);
				for (const row of rows) {
					contentMap.set(row.id, row.content);
					remaining.delete(row.id);
				}
			} catch {
				// Fall through to graph-local gist text.
			}
		}

		if (remaining.size > 0) {
			const rows = this.#forEachChunk(
				[...remaining],
				(chunk, placeholders) =>
					this.db
						.query(`SELECT memory_id, text FROM gists WHERE memory_id IN (${placeholders})`)
						.all(...chunk) as { memory_id: string; text: string }[],
			);
			for (const row of rows) {
				contentMap.set(row.memory_id, row.text);
				remaining.delete(row.memory_id);
			}
		}

		return contentMap;
	}

	private memoryFeatures(memoryId: string): Set<string> {
		const gistRows = this.db.query("SELECT * FROM gists WHERE memory_id = ?").all(memoryId) as GistRow[];
		const factRows = this.db.query("SELECT * FROM facts WHERE source_msg_id = ?").all(memoryId) as FactRow[];
		const features: (string | null)[] = [];
		for (const row of gistRows) {
			const gist = rowToGist(row);
			features.push(...gist.participants, gist.location, gist.emotion, gist.timeScope);
		}
		for (const row of factRows) {
			features.push(row.subject, row.predicate, row.object);
		}
		return lowerSet(features);
	}

	private scoreFeatures(left: Set<string>, right: Set<string>): number {
		return Math.round(overlapScore(left, right) * 1000) / 1000;
	}
}
