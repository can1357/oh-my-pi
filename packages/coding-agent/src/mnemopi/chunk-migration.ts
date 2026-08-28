/**
 * One-off, programmatic migration that re-chunks oversized `coding-agent-transcript`
 * working-memory rows written before `mnemopi.retentionChunkMaxChars` existed (or written
 * while it was disabled) into bounded children, using the exact same framing and splitting
 * rules as {@link chunkRetentionMessages}.
 *
 * Operates via direct SQLite (`bun:sqlite`) against a caller-supplied `dbPath`; it never goes
 * through `Beam.remember` (which would re-run extraction/embedding and could not preserve a
 * row's original provenance columns verbatim). There is deliberately no live CLI or
 * `/memory` command wired to this yet — it is invoked programmatically against a copy.
 */
import { Database } from "bun:sqlite";
import { sha256Hex16, stableMemoryId } from "@oh-my-pi/pi-mnemopi/util/ids";
import {
	chunkRetentionMessages,
	type HindsightMessage,
	prepareEmbeddableRetentionTranscript,
	prepareRetentionTranscript,
	type RetentionChunk,
	type RetentionChunkRange,
	reconstructRetentionChunks,
	stripRetentionProtocolMarkers,
} from "../hindsight/content";

export interface MigrateWorkingMemoryChunksOptions {
	readonly dbPath: string;
	readonly maxChars: number;
	readonly dryRun?: boolean;
}

export interface MigrationReceipt {
	readonly dryRun: boolean;
	readonly candidates: number;
	readonly migrated: number;
	readonly skipped: number;
	readonly children: number;
	/** Total persisted graph-edge mappings that lacked unique opposite-node evidence. */
	readonly lowConfidenceEdges: number;
	/** Total semantic reference rows preserved for manual review instead of active attribution. */
	readonly lowConfidenceReferences: number;
	/** Per-source transactional failures; prior successful sources remain auditable and resumable. */
	readonly failures: readonly { readonly sourceId: string; readonly error: string }[];
	readonly pendingEmbeddings: number;
}

export interface ChunkMigrationValidation {
	readonly valid: boolean;
	readonly sourceHash: string;
	readonly reconstructedHash: string;
	readonly orphanReferences: number;
}

/** Every column of a `working_memory` row, keyed generically so a child insert can copy the
 * parent's full provenance without hard-coding (and drifting from) the schema's column list. */
type WorkingMemoryRow = Record<string, string | number | null>;

/** `[role: X]\n<body>\n[X:end]`, immediately followed by the `"\n\n"` chunk separator or
 * end-of-string — the exact framing {@link prepareRetentionTranscript} produces. */
const STORED_FRAME_RE = /\[role: ([^\]]+)\]\n([\s\S]*?)\n\[\1:end\](?:\n\n|$)/g;

const MEMORIA_SOURCE_TABLES = [
	"memoria_facts",
	"memoria_instructions",
	"memoria_kg",
	"memoria_preferences",
	"memoria_timelines",
] as const;

function tableExists(db: Database, table: string): boolean {
	return db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1").get(table) !== null;
}

/**
 * Parse a stored `coding-agent-transcript` body back into messages, requiring the framing to
 * cover the string exactly (no gaps, no trailing garbage) and to round-trip byte-for-byte
 * through {@link prepareRetentionTranscript}. Anything else — hand-edited content, a
 * pre-framing-convention legacy row, truncated content — is not "losslessly parseable" and is
 * left untouched by the migration rather than risk silently dropping data.
 */
function parseStoredTranscriptLosslessly(content: string): HindsightMessage[] | null {
	const messages: HindsightMessage[] = [];
	let cursor = 0;
	for (const match of content.matchAll(STORED_FRAME_RE)) {
		if (match.index !== cursor) return null;
		const role = match[1];
		const body = match[2];
		if (role === undefined || body === undefined) return null;
		messages.push({ role, content: body });
		cursor = match.index + match[0].length;
	}
	if (messages.length === 0 || cursor !== content.length) return null;
	return prepareRetentionTranscript(messages, true).transcript === content ? messages : null;
}

function countOversizedTranscriptRows(db: Database, maxChars: number, onlyCandidates: boolean): number {
	const supersededClause = onlyCandidates ? "AND superseded_by IS NULL " : "";
	const row = db
		.query<{ count: number }, [number]>(
			`SELECT COUNT(*) AS count FROM working_memory
			 WHERE source = 'coding-agent-transcript' ${supersededClause}AND length(content) > ?`,
		)
		.get(maxChars);
	return row?.count ?? 0;
}

function candidateRows(db: Database, maxChars: number): WorkingMemoryRow[] {
	return db
		.query<WorkingMemoryRow, [number]>(
			`SELECT * FROM working_memory
			 WHERE source = 'coding-agent-transcript' AND superseded_by IS NULL AND length(content) > ?
			 ORDER BY rowid`,
		)
		.all(maxChars);
}

function parseMetadata(row: WorkingMemoryRow): Record<string, unknown> {
	const raw = row.metadata_json;
	if (typeof raw !== "string" || raw.length === 0) return {};
	try {
		const parsed: unknown = JSON.parse(raw);
		return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: {};
	} catch {
		return {};
	}
}

/**
 * Rebuild one chunk's messages with their TRUE per-message roles.
 *
 * A chunk whose per-message framing overhead exceeded the cap is stored under a single
 * synthetic `turn` role, so `chunk.messages` cannot be used to derive the embedding/FTS
 * projection without misattributing roles. `chunk.ranges` carries the real role plus the
 * source slice, which is the only faithful basis for a per-child `embed_text`.
 */
function chunkSourceMessages(parsed: readonly HindsightMessage[], chunk: RetentionChunk): HindsightMessage[] {
	return chunk.ranges.map(range => ({
		role: range.role,
		content: (parsed[range.messageIndex]?.content ?? "").slice(range.start, range.end),
	}));
}

function insertChildRow(
	db: Database,
	columns: readonly string[],
	parentRow: WorkingMemoryRow,
	overrides: Record<string, string | number | null>,
): void {
	const values = columns.map(column => (column in overrides ? overrides[column] : parentRow[column]));
	const placeholders = columns.map(() => "?").join(", ");
	db.run(`INSERT INTO working_memory (${columns.join(", ")}) VALUES (${placeholders})`, values);
}

interface MigrationChild {
	readonly id: string;
	readonly content: string;
}

const EVIDENCE_STOP_WORDS = new Set([
	"the",
	"and",
	"for",
	"with",
	"that",
	"this",
	"from",
	"into",
	"fact",
	"entity",
	"unknown",
	"default",
	"role",
	"user",
	"assistant",
	"system",
	"tool",
	"turn",
	"end",
]);

function normalizedEvidence(value: string): string {
	return stripRetentionProtocolMarkers(value).toLowerCase().replace(/\s+/g, " ").trim();
}

function evidenceTokens(value: string): Set<string> {
	return new Set(
		(normalizedEvidence(value).match(/[\p{L}\p{N}]+/gu) ?? []).filter(
			token => token.length >= 3 && !EVIDENCE_STOP_WORDS.has(token),
		),
	);
}

interface EvidenceMatch {
	readonly child: MigrationChild;
	readonly score: number;
	readonly margin: number;
	readonly exact: boolean;
	readonly confidence: "high" | "low";
}

function evidenceChildMatch(
	children: readonly MigrationChild[],
	evidenceParts: readonly string[],
): EvidenceMatch | null {
	const scored = children.map(child => {
		const content = normalizedEvidence(child.content);
		let score = 0;
		let exact = false;
		for (const part of evidenceParts) {
			const normalized = normalizedEvidence(part);
			if (normalized.length >= 12 && content.includes(normalized)) {
				score += 100;
				exact = true;
			}
			for (const token of evidenceTokens(normalized)) if (content.includes(token)) score++;
		}
		return { child, score, exact };
	});
	scored.sort((left, right) => right.score - left.score || left.child.id.localeCompare(right.child.id));
	const best = scored[0];
	if (best === undefined || best.score <= 0) return null;
	const runnerUpScore = scored[1]?.score ?? 0;
	const margin = best.score - runnerUpScore;
	return {
		child: best.child,
		score: best.score,
		margin,
		exact: best.exact,
		confidence: best.exact || margin > 0 ? "high" : "low",
	};
}

function remapEvidenceTable(
	db: Database,
	table: string,
	referenceColumn: string,
	staleId: string,
	children: readonly MigrationChild[],
	requireEvidence: boolean,
	evidenceColumns?: readonly string[],
): void {
	if (!tableExists(db, table)) return;
	db.run(
		`CREATE TABLE IF NOT EXISTS working_memory_chunk_reference_mappings (
			parent_id TEXT NOT NULL,
			table_name TEXT NOT NULL,
			original_rowid INTEGER NOT NULL,
			reference_column TEXT NOT NULL,
			child_id TEXT,
			confidence TEXT NOT NULL CHECK(confidence IN ('high','low')),
			evidence_json TEXT NOT NULL,
			score REAL NOT NULL,
			margin REAL NOT NULL,
			exact INTEGER NOT NULL,
			created_at TEXT DEFAULT CURRENT_TIMESTAMP,
			PRIMARY KEY(parent_id,table_name,original_rowid,reference_column)
		)`,
	);
	const rows = db
		.query<Record<string, unknown> & { __rowid: number }, [string]>(
			`SELECT rowid AS __rowid, * FROM ${table} WHERE ${referenceColumn} = ?`,
		)
		.all(staleId);
	for (const row of rows) {
		const evidenceParts = evidenceColumns
			? evidenceColumns
					.map(column => row[column])
					.filter(value => value !== null && value !== undefined)
					.map(String)
			: Object.entries(row)
					.filter(
						([key, value]) =>
							key !== "__rowid" &&
							key !== referenceColumn &&
							value !== null &&
							!/(^id$|_id$|timestamp|created_at|updated_|valid_|version|importance|confidence|session)/.test(
								key,
							),
					)
					.map(([, value]) => String(value));
		const match = evidenceChildMatch(children, evidenceParts);
		const high = match?.confidence === "high";
		const target = high ? match.child : requireEvidence ? null : children[0];
		db.run(`UPDATE ${table} SET ${referenceColumn} = ? WHERE rowid = ?`, [target?.id ?? null, row.__rowid]);
		db.run(
			`INSERT OR REPLACE INTO working_memory_chunk_reference_mappings
				(parent_id,table_name,original_rowid,reference_column,child_id,confidence,
				 evidence_json,score,margin,exact)
			 VALUES (?,?,?,?,?,?,?,?,?,?)`,
			[
				staleId,
				table,
				row.__rowid,
				referenceColumn,
				target?.id ?? null,
				high ? "high" : "low",
				JSON.stringify(evidenceParts),
				match?.score ?? 0,
				match?.margin ?? 0,
				match?.exact ? 1 : 0,
			],
		);
	}
}

/** Map semantic references to an evidence-bearing child; fan out parent-level graph reachability. */
function remapMemoryReferences(db: Database, staleId: string, children: readonly MigrationChild[]): void {
	const canonical = children[0];
	if (canonical === undefined) throw new Error(`no migration children for ${staleId}`);
	remapEvidenceTable(db, "annotations", "memory_id", staleId, children, false, ["kind", "value"]);
	if (tableExists(db, "memory_validations")) {
		db.run("UPDATE memory_validations SET memory_id = ? WHERE memory_id = ?", [canonical.id, staleId]);
	}
	for (const table of MEMORIA_SOURCE_TABLES) {
		remapEvidenceTable(db, table, "source_memory_id", staleId, children, true);
	}
	remapEvidenceTable(db, "facts", "source_msg_id", staleId, children, true, ["subject", "object"]);
	remapEvidenceTable(db, "gists", "memory_id", staleId, children, true, ["text", "participants_json"]);
	remapEvidenceTable(db, "triples", "source", staleId, children, true, ["subject", "predicate", "object"]);
	if (tableExists(db, "graph_edges")) remapGraphEdgeReferences(db, staleId, children);
	if (tableExists(db, "episodic_memory")) {
		remapSummaryOfReferences(
			db,
			staleId,
			children.map(child => child.id),
		);
		db.run("UPDATE episodic_memory SET superseded_by = ? WHERE superseded_by = ?", [canonical.id, staleId]);
	}
	db.run("UPDATE working_memory SET superseded_by = ? WHERE superseded_by = ?", [canonical.id, staleId]);
}

function graphNodeEvidence(db: Database, nodeId: string): string[] {
	const evidence: string[] = [];
	for (const table of ["working_memory", "episodic_memory"] as const) {
		if (!tableExists(db, table)) continue;
		const row = db.query<{ content: string }, [string]>(`SELECT content FROM ${table} WHERE id=?`).get(nodeId);
		if (row?.content) evidence.push(row.content);
	}
	if (tableExists(db, "gists")) {
		const row = db
			.query<{ text: string; participants_json: string | null }, [string]>(
				"SELECT text,participants_json FROM gists WHERE id=?",
			)
			.get(nodeId);
		if (row) evidence.push(row.text, row.participants_json ?? "");
	}
	if (tableExists(db, "facts")) {
		const row = db
			.query<{ subject: string; predicate: string; object: string }, [string]>(
				"SELECT subject,predicate,object FROM facts WHERE fact_id=?",
			)
			.get(nodeId);
		if (row) evidence.push(row.subject, row.predicate, row.object);
	}
	return evidence;
}

function remapGraphEdgeReferences(db: Database, staleId: string, children: readonly MigrationChild[]): void {
	const canonical = children[0];
	if (canonical === undefined) return;
	db.run(
		`CREATE TABLE IF NOT EXISTS working_memory_chunk_edge_mappings (
			parent_id TEXT NOT NULL,
			original_edge_id INTEGER NOT NULL,
			original_source TEXT NOT NULL,
			original_target TEXT NOT NULL,
			edge_type TEXT NOT NULL,
			weight REAL,
			child_id TEXT NOT NULL,
			confidence TEXT NOT NULL CHECK(confidence IN ('high','low')),
			evidence_node TEXT,
			score REAL NOT NULL,
			margin REAL NOT NULL,
			exact INTEGER NOT NULL,
			created_at TEXT DEFAULT CURRENT_TIMESTAMP,
			PRIMARY KEY(parent_id,original_edge_id)
		)`,
	);
	const rows = db
		.query<
			{ id: number; source: string; target: string; edge_type: string; weight: number | null },
			[string, string]
		>("SELECT id,source,target,edge_type,weight FROM graph_edges WHERE source=? OR target=?")
		.all(staleId, staleId);
	for (const edge of rows) {
		const opposite = edge.source === staleId ? edge.target : edge.source;
		const match = evidenceChildMatch(children, graphNodeEvidence(db, opposite));
		const high = match?.confidence === "high";
		const child = high ? match.child : canonical;
		if (high) {
			const source = edge.source === staleId ? child.id : edge.source;
			const target = edge.target === staleId ? child.id : edge.target;
			const conflict = db
				.query<{ id: number }, [string, string, string, number]>(
					"SELECT id FROM graph_edges WHERE source=? AND target=? AND edge_type=? AND id<>?",
				)
				.get(source, target, edge.edge_type, edge.id);
			if (conflict) db.run("DELETE FROM graph_edges WHERE id=?", [edge.id]);
			else db.run("UPDATE graph_edges SET source=?,target=? WHERE id=?", [source, target, edge.id]);
		} else {
			// No unique evidence-bearing child: remove from active traversal and keep
			// the complete original edge in the manual-review receipt below.
			db.run("DELETE FROM graph_edges WHERE id=?", [edge.id]);
		}
		db.run(
			`INSERT OR REPLACE INTO working_memory_chunk_edge_mappings
				(parent_id,original_edge_id,original_source,original_target,edge_type,weight,
				 child_id,confidence,evidence_node,score,margin,exact)
			 VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
			[
				staleId,
				edge.id,
				edge.source,
				edge.target,
				edge.edge_type,
				edge.weight,
				child.id,
				high ? "high" : "low",
				opposite,
				match?.score ?? 0,
				match?.margin ?? 0,
				match?.exact ? 1 : 0,
			],
		);
	}
}

/** Replace a summarized parent with every child: the episode covered the whole source transcript. */
function remapSummaryOfReferences(db: Database, staleId: string, childIds: readonly string[]): void {
	const rows = db
		.query<{ id: string; summary_of: string }, []>(
			"SELECT id, summary_of FROM episodic_memory WHERE summary_of IS NOT NULL AND summary_of != ''",
		)
		.all();
	for (const row of rows) {
		const ids = row.summary_of.split(",").map(id => id.trim());
		if (!ids.includes(staleId)) continue;
		const remapped = ids.flatMap(id => (id === staleId ? childIds : [id]));
		db.run("UPDATE episodic_memory SET summary_of = ? WHERE id = ?", [[...new Set(remapped)].join(","), row.id]);
	}
}

/** Migrate exactly one oversized row inside its own `BEGIN IMMEDIATE` transaction. Returns
 * the number of children created, or `null` when the row was left untouched (it did not
 * parse losslessly, or chunking it produced nothing to split). */
function migrateOneRow(db: Database, row: WorkingMemoryRow, maxChars: number): number | null {
	const content = row.content;
	if (typeof content !== "string") return null;
	const parsed = parseStoredTranscriptLosslessly(content);
	if (parsed === null) return null;
	const chunks = chunkRetentionMessages(parsed, maxChars);
	if (chunks.length <= 1) return null;

	const id = row.id;
	if (typeof id !== "string") return null;
	const columns = Object.keys(row);
	const parentMetadata = parseMetadata(row);
	const sourceHash = sha256Hex16(content);
	const childRows: MigrationChild[] = [];

	db.run("BEGIN IMMEDIATE");
	try {
		chunks.forEach((chunk: RetentionChunk, chunkIndex: number) => {
			const { transcript, messageCount } = prepareRetentionTranscript(chunk.messages, true);
			if (transcript === null) return;
			const childId = chunkMemoryId(transcript, id, chunkIndex);
			childRows.push({ id: childId, content: transcript });
			const metadata: Record<string, unknown> = {
				...parentMetadata,
				message_count: messageCount,
				chunk_of: id,
				chunk_index: chunkIndex,
				chunk_count: chunks.length,
				source_hash: sourceHash,
				ranges: chunk.ranges.map((range: RetentionChunkRange) => ({
					messageIndex: range.messageIndex,
					start: range.start,
					end: range.end,
					role: range.role,
				})),
			};
			// Never inherit the parent's whole-row `embed_text`: that is what FTS and the
			// embedding represent, so copying it would leave every child semantically as
			// large and multi-topic as the row this migration exists to split.
			const { transcript: embedText } = prepareEmbeddableRetentionTranscript(chunkSourceMessages(parsed, chunk));
			insertChildRow(db, columns, row, {
				id: childId,
				content: transcript,
				embed_text: embedText,
				metadata_json: JSON.stringify(metadata),
				superseded_by: null,
			});
		});
		const canonical = childRows[0];
		if (canonical === undefined) throw new Error(`chunk migration produced no children for row ${id}`);
		db.run("UPDATE working_memory SET superseded_by = ? WHERE id = ?", [canonical.id, id]);
		remapMemoryReferences(db, id, childRows);
		db.run("DELETE FROM memory_embeddings WHERE memory_id = ?", [id]);
		db.run("COMMIT");
	} catch (error) {
		db.run("ROLLBACK");
		throw error;
	}
	return childRows.length;
}

/**
 * Re-chunk oversized, non-superseded `coding-agent-transcript` working-memory rows in
 * `options.dbPath` so every stored row fits under `options.maxChars`, preserving exact
 * content, provenance columns, and every cross-table reference.
 *
 * A dry run (`dryRun: true`) is strictly read-only: it opens the database read-only, creates
 * no schema, and writes nothing. An apply run migrates each eligible row inside its own
 * `BEGIN IMMEDIATE` transaction, so a failure on one source never touches another. Re-running
 * with the same `maxChars` is a no-op: already-migrated rows carry `superseded_by`, which
 * excludes them from the candidate set.
 */
export function migrateWorkingMemoryChunks(options: MigrateWorkingMemoryChunksOptions): MigrationReceipt {
	const dryRun = options.dryRun === true;
	const db = dryRun ? new Database(options.dbPath, { readonly: true }) : new Database(options.dbPath);
	try {
		const totalOversized = countOversizedTranscriptRows(db, options.maxChars, false);
		if (dryRun) {
			const candidates = countOversizedTranscriptRows(db, options.maxChars, true);
			return {
				dryRun: true,
				candidates,
				migrated: 0,
				skipped: totalOversized - candidates,
				children: 0,
				lowConfidenceEdges: 0,
				lowConfidenceReferences: 0,
				failures: [],
				pendingEmbeddings: 0,
			};
		}
		const rows = candidateRows(db, options.maxChars);
		const candidates = rows.length;
		let migrated = 0;
		let children = 0;
		const failures: Array<{ sourceId: string; error: string }> = [];
		for (const row of rows) {
			try {
				const created = migrateOneRow(db, row, options.maxChars);
				if (created === null) continue;
				migrated++;
				children += created;
			} catch (error) {
				failures.push({
					sourceId: typeof row.id === "string" ? row.id : String(row.id),
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
		const lowConfidenceEdges = tableExists(db, "working_memory_chunk_edge_mappings")
			? (db
					.query<{ count: number }, []>(
						"SELECT COUNT(*) AS count FROM working_memory_chunk_edge_mappings WHERE confidence='low'",
					)
					.get()?.count ?? 0)
			: 0;
		const lowConfidenceReferences = tableExists(db, "working_memory_chunk_reference_mappings")
			? (db
					.query<{ count: number }, []>(
						"SELECT COUNT(*) AS count FROM working_memory_chunk_reference_mappings WHERE confidence='low'",
					)
					.get()?.count ?? 0)
			: 0;
		return {
			dryRun: false,
			candidates,
			migrated,
			skipped: totalOversized - migrated,
			children,
			lowConfidenceEdges,
			lowConfidenceReferences,
			failures,
			pendingEmbeddings: children,
		};
	} finally {
		db.close();
	}
}

/**
 * Verify a prior {@link migrateWorkingMemoryChunks} run for one source row: recomputes a hash
 * of the parent's stored content, reconstructs the original content from its children's
 * `ranges` metadata via {@link reconstructRetentionChunks} and hashes that, and counts any
 * remaining reference-table rows that still point at the stale (pre-migration) id.
 */
/**
 * Stable id for one retention chunk.
 *
 * A chunk's identity is its POSITION in the parent, not merely its text: two chunks of one
 * oversized message can be byte-identical (a long repeated payload), and the store's content
 * dedupe would otherwise collapse them into a single row carrying only the first chunk's ranges.
 *
 * Hashing the content together with `(parentId, chunkIndex)` gives three properties the chunk paths
 * both need: distinct ids for identical text at different positions, the same id when the same
 * chunk is written again (so a rerun updates in place), and a NEW id if the text at a position ever
 * changes -- which matters because the store refuses to rewrite content under an existing id, since
 * every derived artifact was produced from the old text.
 *
 * Exported and shared so live retention and the migration cannot drift apart on chunk identity.
 */
export function chunkMemoryId(transcript: string, parentId: string, chunkIndex: number): string {
	return stableMemoryId(transcript, `${parentId}:chunk:${chunkIndex}`);
}

export function validateWorkingMemoryChunkMigration(dbPath: string, sourceId: string): ChunkMigrationValidation {
	const db = new Database(dbPath, { readonly: true });
	try {
		const parent = db
			.query<{ content: string }, [string]>("SELECT content FROM working_memory WHERE id = ?")
			.get(sourceId);
		const sourceHash = sha256Hex16(parent?.content ?? "");
		const children = db
			.query<{ content: string; metadata_json: string }, [string]>(
				`SELECT content, metadata_json FROM working_memory
				 WHERE json_extract(metadata_json, '$.chunk_of') = ?
				 ORDER BY CAST(json_extract(metadata_json, '$.chunk_index') AS INTEGER)`,
			)
			.all(sourceId);
		const chunks = children.map(child => {
			const messages = parseStoredTranscriptLosslessly(child.content) ?? [];
			const metadata = JSON.parse(child.metadata_json) as { ranges?: RetentionChunkRange[] };
			return { messages, ranges: metadata.ranges ?? [] };
		});
		const reconstructed = reconstructRetentionChunks(chunks);
		const reconstructedTranscript = prepareRetentionTranscript(reconstructed, true).transcript ?? "";
		const reconstructedHash = sha256Hex16(reconstructedTranscript);
		const orphanReferences = countOrphanReferences(db, sourceId);
		return {
			valid: parent !== null && children.length > 0 && sourceHash === reconstructedHash && orphanReferences === 0,
			sourceHash,
			reconstructedHash,
			orphanReferences,
		};
	} finally {
		db.close();
	}
}

function countOrphanReferences(db: Database, staleId: string): number {
	const simpleRefs: ReadonlyArray<{ table: string; column: string }> = [
		{ table: "annotations", column: "memory_id" },
		{ table: "memory_validations", column: "memory_id" },
		...MEMORIA_SOURCE_TABLES.map(table => ({ table, column: "source_memory_id" })),
		{ table: "facts", column: "source_msg_id" },
		{ table: "gists", column: "memory_id" },
		{ table: "graph_edges", column: "source" },
		{ table: "graph_edges", column: "target" },
		{ table: "triples", column: "source" },
		{ table: "working_memory", column: "superseded_by" },
		{ table: "episodic_memory", column: "superseded_by" },
	];
	let count = 0;
	for (const ref of simpleRefs) {
		if (!tableExists(db, ref.table)) continue;
		const row = db
			.query<{ count: number }, [string]>(`SELECT COUNT(*) AS count FROM ${ref.table} WHERE ${ref.column} = ?`)
			.get(staleId);
		count += row?.count ?? 0;
	}
	if (tableExists(db, "episodic_memory")) {
		const rows = db
			.query<{ summary_of: string }, []>(
				"SELECT summary_of FROM episodic_memory WHERE summary_of IS NOT NULL AND summary_of != ''",
			)
			.all();
		for (const row of rows) {
			if (row.summary_of.split(",").some(id => id.trim() === staleId)) count++;
		}
	}
	return count;
}
