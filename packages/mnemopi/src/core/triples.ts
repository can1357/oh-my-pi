import { Database, type SQLQueryBindings } from "bun:sqlite";
import { copyFileSync, existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { closeQuietly, type DatabasePath, openDatabase } from "../db";

export interface TripleRow {
	id: number;
	subject: string;
	predicate: string;
	object: string;
	valid_from: string;
	valid_until: string | null;
	source: string | null;
	confidence: number | null;
	created_at: string | null;
}

export interface TripleWriteOptions {
	readonly validFrom?: string | null;
	readonly valid_from?: string | null;
	readonly source?: string | null;
	readonly confidence?: number | null;
}

export interface TripleQueryOptions {
	readonly subject?: string | null;
	readonly predicate?: string | null;
	readonly object?: string | null;
	readonly asOf?: string | null;
	readonly as_of?: string | null;
}

export interface TripleImportStats {
	inserted: number;
	skipped: number;
	overwritten: number;
	imported_renumbered: number;
}

export type TripleImportRow = Partial<Omit<TripleRow, "id">> & { readonly id?: number | null };

const TRIPLE_COLUMNS = "id, subject, predicate, object, valid_from, valid_until, source, confidence, created_at";
const CONTENT_FIELDS = [
	"subject",
	"predicate",
	"object",
	"valid_from",
	"valid_until",
	"source",
	"confidence",
	"created_at",
] as const;

type ContentField = (typeof CONTENT_FIELDS)[number];
type ContentSnapshot = Record<ContentField, string | number | null | undefined>;

interface ImportBindingRow {
	readonly subject: string | null;
	readonly predicate: string | null;
	readonly object: string | null;
	readonly valid_from: string | null;
	readonly valid_until: string | null;
	readonly source: string;
	readonly confidence: number;
	readonly created_at: string | null;
}

type ProcessEnv = Record<string, string | undefined>;
type SerializableDatabase = Database & { serialize(): Uint8Array };

function homeDir(env: ProcessEnv = process.env): string {
	return env.HOME && env.HOME.length > 0 ? env.HOME : homedir();
}

export function legacyDataDir(env: ProcessEnv = process.env): string {
	return join(homeDir(env), ".hermes", "mnemopi", "data");
}

export function defaultDataDir(env: ProcessEnv = process.env): string {
	return env.MNEMOPI_DATA_DIR && env.MNEMOPI_DATA_DIR.length > 0 ? env.MNEMOPI_DATA_DIR : legacyDataDir(env);
}

export function defaultTripleDbPath(env: ProcessEnv = process.env): string {
	return join(defaultDataDir(env), "triples.db");
}

export function legacyTripleDbPath(env: ProcessEnv = process.env): string {
	return join(legacyDataDir(env), "triples.db");
}

function copyLegacyDb(source: string, destination: string): void {
	mkdirSync(dirname(destination), { recursive: true });
	const tempPath = join(
		dirname(destination),
		`.${destination.split(/[\\/]/).at(-1) ?? "triples.db"}.${process.pid}.tmp`,
	);
	let sourceDb: Database | null = null;
	try {
		sourceDb = openDatabase(source, { create: false, readwrite: false, pragmas: false });
		writeFileSync(tempPath, (sourceDb as SerializableDatabase).serialize());
		if (!existsSync(destination)) copyFileSync(tempPath, destination);
	} finally {
		closeQuietly(sourceDb);
		try {
			unlinkSync(tempPath);
		} catch {
			// Best-effort cleanup; a failed copy should surface as the original error.
		}
	}
}

export function resolveDefaultTripleDb(env: ProcessEnv = process.env): string {
	const destination = defaultTripleDbPath(env);
	const legacy = legacyTripleDbPath(env);
	if (destination !== legacy && !existsSync(destination) && existsSync(legacy)) copyLegacyDb(legacy, destination);
	return destination;
}

export function initTriples(dbOrPath?: Database | DatabasePath | null): void {
	let db: Database;
	let owned = false;
	if (dbOrPath instanceof Database) {
		db = dbOrPath;
	} else {
		db = openDatabase(dbOrPath ?? resolveDefaultTripleDb());
		owned = true;
	}
	try {
		db.run(`
			CREATE TABLE IF NOT EXISTS triples (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				subject TEXT NOT NULL,
				predicate TEXT NOT NULL,
				object TEXT NOT NULL,
				valid_from TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
				valid_until TEXT,
				source TEXT,
				confidence REAL DEFAULT 1.0,
				created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
			)
		`);
		db.run("CREATE INDEX IF NOT EXISTS idx_triples_subject ON triples(subject)");
		db.run("CREATE INDEX IF NOT EXISTS idx_triples_predicate ON triples(predicate)");
		db.run("CREATE INDEX IF NOT EXISTS idx_triples_object ON triples(object)");
		db.run("CREATE INDEX IF NOT EXISTS idx_triples_valid_from ON triples(valid_from)");
	} finally {
		if (owned) closeQuietly(db);
	}
}

function today(): string {
	return new Date().toISOString().slice(0, 10);
}

function normalizeOptions(options?: TripleWriteOptions | string | null): Required<TripleWriteOptions> {
	if (typeof options === "string") {
		return { validFrom: options, valid_from: options, source: "inferred", confidence: 1.0 };
	}
	const validFrom = options?.validFrom ?? options?.valid_from ?? null;
	return {
		validFrom,
		valid_from: validFrom,
		source: options?.source ?? "inferred",
		confidence: options?.confidence ?? 1.0,
	};
}

function rowToTriple(row: unknown): TripleRow {
	return row as TripleRow;
}

function normalizeContent(item: TripleImportRow): ContentSnapshot {
	const bindings = normalizeImportBindings(item);
	return {
		subject: bindings.subject,
		predicate: bindings.predicate,
		object: bindings.object,
		valid_from: bindings.valid_from,
		valid_until: bindings.valid_until,
		source: bindings.source,
		confidence: bindings.confidence,
		created_at: bindings.created_at,
	};
}

function requiredImportText(value: string | null | undefined): string | null {
	return value ?? null;
}

function normalizeImportBindings(item: TripleImportRow): ImportBindingRow {
	return {
		subject: requiredImportText(item.subject),
		predicate: requiredImportText(item.predicate),
		object: requiredImportText(item.object),
		valid_from: requiredImportText(item.valid_from),
		valid_until: item.valid_until ?? null,
		source: item.source ?? "imported",
		confidence: item.confidence ?? 1.0,
		created_at: item.created_at ?? null,
	};
}

function contentFromRow(row: TripleRow): ContentSnapshot {
	return {
		subject: row.subject,
		predicate: row.predicate,
		object: row.object,
		valid_from: row.valid_from,
		valid_until: row.valid_until,
		source: row.source,
		confidence: row.confidence,
		created_at: row.created_at,
	};
}

function sameContent(left: ContentSnapshot, right: ContentSnapshot): boolean {
	for (const field of CONTENT_FIELDS) {
		if ((left[field] ?? null) !== (right[field] ?? null)) return false;
	}
	return true;
}

export class TripleStore {
	readonly dbPath: DatabasePath;
	readonly conn: Database;
	#ownsConnection: boolean;

	constructor(dbPath?: DatabasePath | Database | null) {
		if (dbPath instanceof Database) {
			this.dbPath = ":memory:";
			this.conn = dbPath;
			this.#ownsConnection = false;
			initTriples(this.conn);
			return;
		}
		this.dbPath = dbPath ?? resolveDefaultTripleDb();
		this.conn = openDatabase(this.dbPath);
		this.#ownsConnection = true;
		initTriples(this.conn);
	}

	close(): void {
		if (!this.#ownsConnection) return;
		this.#ownsConnection = false;
		closeQuietly(this.conn);
	}

	add(subject: string, predicate: string, object: string, options?: TripleWriteOptions | string | null): number {
		const normalized = normalizeOptions(options);
		const validFrom = normalized.validFrom ?? today();
		this.conn.run("UPDATE triples SET valid_until = ? WHERE subject = ? AND predicate = ? AND valid_until IS NULL", [
			validFrom,
			subject,
			predicate,
		]);
		const result = this.conn.run(
			"INSERT INTO triples (subject, predicate, object, valid_from, source, confidence) VALUES (?, ?, ?, ?, ?, ?)",
			[subject, predicate, object, validFrom, normalized.source, normalized.confidence],
		);
		return Number(result.lastInsertRowid);
	}

	query(options?: TripleQueryOptions): TripleRow[];
	query(subject?: string | null, predicate?: string | null, object?: string | null, asOf?: string | null): TripleRow[];
	query(
		optionsOrSubject?: TripleQueryOptions | string | null,
		predicate?: string | null,
		object?: string | null,
		asOf?: string | null,
	): TripleRow[] {
		const options: TripleQueryOptions =
			typeof optionsOrSubject === "object" && optionsOrSubject !== null
				? optionsOrSubject
				: { subject: optionsOrSubject, predicate, object, asOf };
		const conditions: string[] = [];
		const params: (string | number)[] = [];
		if (options.subject) {
			conditions.push("subject = ?");
			params.push(options.subject);
		}
		if (options.predicate) {
			conditions.push("predicate = ?");
			params.push(options.predicate);
		}
		if (options.object) {
			conditions.push("object = ?");
			params.push(options.object);
		}
		const effectiveAsOf = options.asOf ?? options.as_of ?? today();
		conditions.push("valid_from <= ?");
		params.push(effectiveAsOf);
		conditions.push("(valid_until IS NULL OR valid_until > ?)");
		params.push(effectiveAsOf);
		const where = conditions.join(" AND ");
		return this.conn
			.query(`SELECT ${TRIPLE_COLUMNS} FROM triples WHERE ${where} ORDER BY valid_from DESC`)
			.all(...params)
			.map(rowToTriple);
	}

	queryByPredicate(predicate: string, object?: string | null, subject?: string | null): TripleRow[] {
		const conditions = ["predicate = ?"];
		const params: string[] = [predicate];
		if (object) {
			conditions.push("object = ?");
			params.push(object);
		}
		if (subject) {
			conditions.push("subject = ?");
			params.push(subject);
		}
		return this.conn
			.query(`SELECT ${TRIPLE_COLUMNS} FROM triples WHERE ${conditions.join(" AND ")} ORDER BY created_at DESC`)
			.all(...params)
			.map(rowToTriple);
	}
	getDistinctObjects(predicate: string): string[] {
		return this.conn
			.query("SELECT DISTINCT object FROM triples WHERE predicate = ? ORDER BY object")
			.all(predicate)
			.map(row => (row as { object: string }).object);
	}
	exportAll(): TripleRow[] {
		return this.conn.query(`SELECT ${TRIPLE_COLUMNS} FROM triples ORDER BY id`).all().map(rowToTriple);
	}
	importAll(triples: readonly TripleImportRow[], force = false): TripleImportStats {
		const stats: TripleImportStats = {
			inserted: 0,
			skipped: 0,
			overwritten: 0,
			imported_renumbered: 0,
		};
		const seen = new Set<number>();
		for (const item of triples) {
			if (item.id === undefined || item.id === null) continue;
			if (seen.has(item.id))
				throw new Error(
					`import_all: duplicate id ${item.id} in the imported batch. Deduplicate the input before calling.`,
				);
			seen.add(item.id);
		}

		this.conn.run("BEGIN IMMEDIATE");
		try {
			const existing = new Map<number, ContentSnapshot>();
			for (const row of this.conn.query(`SELECT ${TRIPLE_COLUMNS} FROM triples`).all().map(rowToTriple)) {
				existing.set(row.id, contentFromRow(row));
			}
			const explicitNoCollision: TripleImportRow[] = [];
			const noId: TripleImportRow[] = [];
			const collisions: TripleImportRow[] = [];
			for (const item of triples) {
				const id = item.id;
				if (id === undefined || id === null) noId.push(item);
				else if (existing.has(id)) collisions.push(item);
				else explicitNoCollision.push(item);
			}
			for (const item of explicitNoCollision) {
				this.#insertWithId(item, item.id as number);
				stats.inserted++;
			}
			for (const item of noId) {
				this.#insertWithoutId(item);
				stats.inserted++;
			}
			for (const item of collisions) {
				const id = item.id as number;
				if (force) {
					this.conn.run("DELETE FROM triples WHERE id = ?", [id]);
					this.#insertWithId(item, id);
					stats.overwritten++;
				} else if (sameContent(normalizeContent(item), existing.get(id) as ContentSnapshot)) {
					stats.skipped++;
				} else {
					try {
						this.#insertWithoutId(item);
						stats.imported_renumbered++;
					} catch (error) {
						if (!(error instanceof Error) || !error.message.toLowerCase().includes("constraint")) throw error;
						stats.skipped++;
					}
				}
			}
			this.conn.run("COMMIT");
			return stats;
		} catch (error) {
			try {
				this.conn.run("ROLLBACK");
			} catch {
				// Preserve the original error.
			}
			throw error;
		}
	}
	#insertWithId(item: TripleImportRow, id: number): void {
		const bindings = normalizeImportBindings(item);
		const params: SQLQueryBindings[] = [
			id,
			bindings.subject,
			bindings.predicate,
			bindings.object,
			bindings.valid_from,
			bindings.valid_until,
			bindings.source,
			bindings.confidence,
			bindings.created_at,
		];
		this.conn.run(`INSERT INTO triples (${TRIPLE_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, params);
	}

	#insertWithoutId(item: TripleImportRow): void {
		const bindings = normalizeImportBindings(item);
		const params: SQLQueryBindings[] = [
			bindings.subject,
			bindings.predicate,
			bindings.object,
			bindings.valid_from,
			bindings.valid_until,
			bindings.source,
			bindings.confidence,
			bindings.created_at,
		];
		this.conn.run(
			"INSERT INTO triples (subject, predicate, object, valid_from, valid_until, source, confidence, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
			params,
		);
	}
}

export function addTriple(
	subject: string,
	predicate: string,
	object: string,
	options?: TripleWriteOptions & { readonly dbPath?: DatabasePath | null },
): number {
	const store = new TripleStore(options?.dbPath ?? null);
	try {
		return store.add(subject, predicate, object, options);
	} finally {
		store.close();
	}
}

export function queryTriples(options?: TripleQueryOptions & { readonly dbPath?: DatabasePath | null }): TripleRow[] {
	const store = new TripleStore(options?.dbPath ?? null);
	try {
		return store.query(options);
	} finally {
		store.close();
	}
}
