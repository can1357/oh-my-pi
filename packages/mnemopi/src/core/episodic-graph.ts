import type { Database } from "bun:sqlite";
import { closeQuietly, type DatabasePath, openDatabase } from "../db";
import { ENTITY_EXTRACTION_STOP_WORDS } from "./entities";

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
	/** `facts.fact_id` — a fact identifier, NOT a memory id. */
	readonly id: string;
	readonly subject: string;
	readonly predicate: string;
	readonly object: string;
	readonly timestamp: string;
	readonly confidence: number;
	readonly temporalQualifier?: string | null;
	/**
	 * `facts.source_msg_id` — the memory this fact was extracted from, and the only
	 * reliable way back to a hydratable row. Optional because stored rows may carry a
	 * NULL `source_msg_id`; callers that need a memory id must handle absence.
	 */
	readonly sourceMemoryId?: string | null;
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
	readonly source: string;
	readonly target: string;
	readonly edge_type: string;
	readonly weight: number;
	readonly timestamp: string | null;
}

const EXTRACT_FACTS_MAX_CONTENT_LEN = 4096;
const MAX_FACTS_PER_MEMORY = 5;
const DEFAULT_LINK_THRESHOLD = 0.35;

function nowIso(): string {
	return new Date().toISOString();
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
		sourceMemoryId: row.source_msg_id,
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

function lowerSet(values: readonly (string | null)[]): Set<string> {
	const out = new Set<string>();
	for (const value of values) {
		if (value === null) continue;
		const normalized = value.trim().toLocaleLowerCase();
		if (normalized.length > 0) out.add(normalized);
	}
	return out;
}

const FACT_SUBJECT_CONTROL_CHAR_PATTERN = /[\u0000-\u001f\u007f]/;
const FACT_SUBJECT_MAX_WORDS = 4;

/**
 * Subordinating conjunctions that leave a captured fact subject looking
 * truncated mid-clause (e.g. "Left Option for Hungarian symbols while").
 * ENTITY_EXTRACTION_STOP_WORDS already covers coordinating conjunctions and
 * simple prepositions ("for", "of", "with", "and", ...) so this only
 * supplies the subordinators that list does not carry.
 */
export const DANGLING_FACT_SUBJECT_ENDINGS: Readonly<Record<string, true>> = {
	while: true,
	although: true,
	though: true,
	because: true,
	since: true,
	unless: true,
	until: true,
	whereas: true,
	if: true,
};

/**
 * Rejects fact subjects captured by extractFacts's loose regexes that are
 * sentence fragments rather than plausible entity names: subjects with an
 * embedded control character (including a newline), ones that open with a
 * pronoun / article / auxiliary / negation / preposition (all present in
 * ENTITY_EXTRACTION_STOP_WORDS, so a single leading-word membership test
 * also covers the "one word and that word is a stop word" case), ones
 * that run past a handful of words, and ones that trail off on a dangling
 * conjunction or preposition.
 */
export function isPlausibleFactSubject(subject: string): boolean {
	if (FACT_SUBJECT_CONTROL_CHAR_PATTERN.test(subject)) return false;
	const words = subject
		.trim()
		.split(/\s+/)
		.filter(word => word.length > 0);
	if (words.length === 0 || words.length > FACT_SUBJECT_MAX_WORDS) return false;
	const first = words[0]?.toLocaleLowerCase() ?? "";
	if (ENTITY_EXTRACTION_STOP_WORDS.has(first)) return false;
	const last = words[words.length - 1]?.toLocaleLowerCase() ?? "";
	if (ENTITY_EXTRACTION_STOP_WORDS.has(last) || Object.hasOwn(DANGLING_FACT_SUBJECT_ENDINGS, last)) return false;
	return true;
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
			if (
				cleanSubject.length <= 2 ||
				cleanObject.length <= 2 ||
				facts.length >= MAX_FACTS_PER_MEMORY ||
				!isPlausibleFactSubject(cleanSubject)
			)
				return;
			facts.push({
				id: `fact_${memoryId}_${facts.length}`,
				subject: cleanSubject,
				predicate,
				object: cleanObject,
				timestamp: nowIso(),
				confidence,
				temporalQualifier: null,
				sourceMemoryId: memoryId,
			});
		};

		for (const match of bounded.matchAll(/\b([A-Z][a-zA-Z\s]+?)\s+is\s+(?:a|an|the)?\s*([a-zA-Z\s]+?)\b/g)) {
			pushFact(match[1] ?? "", "is", match[2] ?? "", 0.7);
		}
		for (const match of bounded.matchAll(/\b([A-Z][a-zA-Z\s]+?)\s+has\s+(?:a|an|the)?\s*([a-zA-Z\d\s]+?)\b/g)) {
			pushFact(match[1] ?? "", "has", match[2] ?? "", 0.6);
		}
		for (const match of bounded.matchAll(
			/\b([A-Z][a-zA-Z\s]+?)\s+(uses?|using|used)\s+(?:a|an|the)?\s*([a-zA-Z\s]+?)\b/g,
		)) {
			pushFact(match[1] ?? "", "uses", match[3] ?? "", 0.6);
		}
		for (const match of bounded.matchAll(
			/\b([A-Z][a-zA-Z\s]+?)\s+works?\s+(?:at|for|with)\s+([A-Z][a-zA-Z\s]+?)\b/g,
		)) {
			pushFact(match[1] ?? "", "works_at", match[2] ?? "", 0.7);
		}
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
			const nextLevel = new Set<string>();
			for (const mem of currentLevel) {
				const rows =
					edgeType.length > 0
						? (this.db
								.query(
									`SELECT source, target, edge_type, weight FROM graph_edges
								 WHERE (source = ? OR target = ?) AND edge_type = ? AND weight >= ?
								 ORDER BY weight DESC, id`,
								)
								.all(mem, mem, edgeType, threshold) as EdgeRow[])
						: (this.db
								.query(
									`SELECT source, target, edge_type, weight FROM graph_edges
								 WHERE (source = ? OR target = ?) AND weight >= ?
								 ORDER BY weight DESC, id`,
								)
								.all(mem, mem, threshold) as EdgeRow[]);
				for (const row of rows) {
					const neighbor = row.source === mem ? row.target : row.source;
					if (seen.has(neighbor)) continue;
					seen.add(neighbor);
					nextLevel.add(neighbor);
					results.push({
						memoryId: neighbor,
						edgeType: row.edge_type,
						weight: row.weight,
						depth: hop,
					});
				}
			}
			currentLevel = nextLevel;
		}
		return results;
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
			for (const otherId of previousMemoryIds) {
				const otherContent = this.memoryContent(otherId);
				const lexicalScore = Math.round(jaccard(sourceTokens, contentTokenSet(otherContent)) * 1000) / 1000;
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
				const entityScore = this.entityOverlapScore(memoryId, otherId);
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
				const contextualScore = Math.max(lexicalScore, entityScore, this.temporalContextScore(memoryId, otherId));
				if (!wroteCtxEdge && contextualScore >= minLinkScore) {
					const ctxEdge = {
						source: memoryId,
						target: otherId,
						edgeType: "ctx",
						weight: contextualScore,
						timestamp,
					};
					this.addEdge(ctxEdge);
					edges.push(ctxEdge);
				}
			}
		}

		return { memoryId, gist, facts, edges };
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
		// Match capitalized proper nouns across cased scripts (Latin, Greek, Cyrillic, …).
		// `[A-Z][a-z]+` plus ASCII `\b` matched no non-Latin token, so any non-English
		// memory produced zero participants (issue #7918). Unicode property escapes with
		// the `u` flag, and `\p{L}`-based lookaround boundaries in place of `\b`, fix that.
		const names = Array.from(
			content.matchAll(/(?<![\p{L}\p{N}_])(\p{Lu}\p{Ll}+(?:\s+\p{Lu}\p{Ll}+)?)(?![\p{L}\p{N}_])/gu),
			match => match[1] ?? "",
		);
		const pronouns = Array.from(
			content.matchAll(/\b(I|you|we|they|he|she|it|me|us|them|him|her)\b/gi),
			match => match[1] ?? "",
		);
		return unique([...names, ...pronouns], 5);
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
		const ids = new Set<string>();
		const gistRows = this.db
			.query("SELECT DISTINCT memory_id FROM gists WHERE memory_id IS NOT NULL AND memory_id != ?")
			.all(exclude) as { memory_id: string }[];
		for (const row of gistRows) ids.add(row.memory_id);
		try {
			const workingRows = this.db.query("SELECT id FROM working_memory WHERE id != ?").all(exclude) as {
				id: string;
			}[];
			for (const row of workingRows) ids.add(row.id);
		} catch {
			// Standalone graph stores do not have Beam memory tables.
		}
		try {
			const episodicRows = this.db.query("SELECT id FROM episodic_memory WHERE id != ?").all(exclude) as {
				id: string;
			}[];
			for (const row of episodicRows) ids.add(row.id);
		} catch {
			// Standalone graph stores do not have Beam memory tables.
		}
		return [...ids];
	}

	private memoryContent(memoryId: string): string {
		try {
			const working = this.db.query("SELECT content FROM working_memory WHERE id = ?").get(memoryId) as {
				content: string;
			} | null;
			if (working !== null) return working.content;
		} catch {
			// Standalone EpisodicGraph users may not have Beam tables.
		}
		try {
			const episodic = this.db.query("SELECT content FROM episodic_memory WHERE id = ?").get(memoryId) as {
				content: string;
			} | null;
			if (episodic !== null) return episodic.content;
		} catch {
			// Fall through to graph-local gist text.
		}
		const gist = this.db.query("SELECT text FROM gists WHERE memory_id = ?").get(memoryId) as {
			text: string;
		} | null;
		return gist?.text ?? "";
	}

	private entityOverlapScore(sourceMemoryId: string, targetMemoryId: string): number {
		const leftRows = this.db
			.query("SELECT subject, object FROM facts WHERE source_msg_id = ?")
			.all(sourceMemoryId) as FactRow[];
		const rightRows = this.db
			.query("SELECT subject, object FROM facts WHERE source_msg_id = ?")
			.all(targetMemoryId) as FactRow[];
		const left = lowerSet(leftRows.flatMap(row => [row.subject, row.object]));
		const right = lowerSet(rightRows.flatMap(row => [row.subject, row.object]));
		return Math.round(overlapScore(left, right) * 1000) / 1000;
	}

	private temporalContextScore(sourceMemoryId: string, targetMemoryId: string): number {
		const left = this.db.query("SELECT time_scope FROM gists WHERE memory_id = ?").get(sourceMemoryId) as {
			time_scope: string | null;
		} | null;
		if (left?.time_scope === null || left?.time_scope === undefined) return 0;
		const right = this.db.query("SELECT time_scope FROM gists WHERE memory_id = ?").get(targetMemoryId) as {
			time_scope: string | null;
		} | null;
		if (right?.time_scope === null || right?.time_scope === undefined) return 0;
		return left.time_scope === right.time_scope ? DEFAULT_LINK_THRESHOLD : 0;
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
