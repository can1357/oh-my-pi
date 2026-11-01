import type { Database, SQLQueryBindings } from "bun:sqlite";

/** Bind parameters per statement; SQLite builds older than 3.32 cap a statement at 999. */
const MAX_BINDS = 999;

/** Shape of one ingest table write; see {@link ChunkedInsert}. */
export interface ChunkedInsertSpec {
	/** `INSERT` or `INSERT OR IGNORE`. */
	verb: "INSERT" | "INSERT OR IGNORE";
	table: string;
	columns: readonly string[];
	/** Columns naming one transcript entry; fork copies repeat them under another `session_file`. */
	identity: readonly string[];
	/** Trailing `ON CONFLICT … DO UPDATE` clause, if any. */
	upsert?: string;
}

/**
 * Multi-row writer for one ingest table: buffers rows and writes them as
 * `INSERT … VALUES (…), (…)` chunks, so the per-statement costs (trigger
 * program setup, statement journal, the temp b-tree SQLite stages trigger
 * inserts through) are paid per chunk instead of per row.
 *
 * Every row passes a first-writer-wins fork guard: forked transcripts copy
 * their parent's entries verbatim, so a row whose identity another
 * `session_file` already stored is skipped. Buffered rows are invisible to
 * that lookup, so a row colliding with a buffered row of another transcript
 * flushes the buffer first; the stored outcome equals writing row by row.
 */
export class ChunkedInsert {
	readonly #database: Database;
	readonly #spec: ChunkedInsertSpec;
	readonly #chunkRows: number;
	readonly #chunkSql: string;
	readonly #claimed: string;
	#params: SQLQueryBindings[] = [];
	#rows = 0;
	/** Identity → `session_file` of each buffered row. */
	#buffered = new Map<string, string>();
	#changes = 0;

	constructor(database: Database, spec: ChunkedInsertSpec) {
		this.#database = database;
		this.#spec = spec;
		this.#chunkRows = Math.floor(MAX_BINDS / spec.columns.length);
		this.#chunkSql = this.#sql(this.#chunkRows);
		this.#claimed = `SELECT 1 FROM ${spec.table} WHERE ${spec.identity.map(column => `${column} = ?`).join(" AND ")} AND session_file <> ? LIMIT 1`;
	}

	/** Buffer one row unless another transcript already owns `identity`. */
	add(sessionFile: string, identity: readonly SQLQueryBindings[], values: readonly SQLQueryBindings[]): void {
		const key = identity.join("\0");
		const owner = this.#buffered.get(key);
		if (owner !== sessionFile) {
			if (owner !== undefined) this.#flush();
			if (this.#database.query(this.#claimed).get(...identity, sessionFile)) return;
			this.#buffered.set(key, sessionFile);
		}
		for (const value of values) this.#params.push(value);
		if (++this.#rows === this.#chunkRows) this.#flush();
	}

	/** Write the remaining rows; returns how many stored rows the writer inserted or updated. */
	finish(): number {
		this.#flush();
		return this.#changes;
	}

	#flush(): void {
		if (this.#rows === 0) return;
		if (this.#rows === this.#chunkRows) {
			this.#changes += this.#database.query(this.#chunkSql).run(...this.#params).changes;
		} else {
			// Partial chunks vary in size; keep them out of the statement cache.
			using statement = this.#database.prepare(this.#sql(this.#rows));
			this.#changes += statement.run(...this.#params).changes;
		}
		this.#params = [];
		this.#rows = 0;
		this.#buffered.clear();
	}

	#sql(rows: number): string {
		const { verb, table, columns, upsert } = this.#spec;
		const row = `(${columns.map(() => "?").join(", ")})`;
		const values = Array.from({ length: rows }, () => row).join(", ");
		return `${verb} INTO ${table} (${columns.join(", ")}) VALUES ${values}${upsert ? ` ${upsert}` : ""}`;
	}
}
