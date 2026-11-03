/**
 * Retaining a memory writes a bank every omp process shares. Each annotation was its own autocommit
 * transaction, and with the default `synchronous=FULL` every commit synced the WAL. These tests pin
 * the batched annotations and `synchronous=NORMAL`, and that no best-effort step can lose the stored
 * row, hold the bank's write lock during graph work, or block an annotation store on another connection.
 */
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { AnnotationStore } from "@oh-my-pi/pi-mnemopi/core/annotations";
import { BeamMemory } from "@oh-my-pi/pi-mnemopi/core/beam";
import { EpisodicGraph } from "@oh-my-pi/pi-mnemopi/core/episodic-graph";
import { closeQuietly, openDatabase } from "@oh-my-pi/pi-mnemopi/db";
import { TempDir } from "@oh-my-pi/pi-utils";

const WRITE = /^\s*(INSERT|UPDATE|DELETE|REPLACE)\b/i;
const COMMIT = /^\s*(COMMIT|END)\b/i;

/** Records the connection's write statements run outside a transaction, and its commits. */
function recordCommits(db: Database): { autocommitWrites: string[]; commits: number } {
	const seen = { autocommitWrites: [] as string[], commits: 0 };
	const note = (sql: string) => {
		if (COMMIT.test(sql)) seen.commits++;
		else if (WRITE.test(sql) && !db.inTransaction)
			seen.autocommitWrites.push(sql.trim().split(/\s+/).slice(0, 3).join(" "));
	};
	const { run, exec, prepare, query } = db;
	db.run = ((sql: string, ...args: unknown[]) => {
		note(sql);
		return run.call(db, sql, ...(args as []));
	}) as typeof db.run;
	db.exec = ((sql: string, ...args: unknown[]) => {
		note(sql);
		return exec.call(db, sql, ...(args as []));
	}) as typeof db.exec;
	// Own-property wrappers, not a Proxy: Statement methods read private fields of the real object.
	// `query()` returns cached statements, so each is wrapped once.
	const wrapped = new WeakSet<object>();
	const wrapStatement = <T extends object>(sql: string, statement: T): T => {
		if (wrapped.has(statement)) return statement;
		wrapped.add(statement);
		for (const key of ["run", "get", "all", "values"]) {
			const method = Reflect.get(statement, key);
			if (typeof method !== "function") continue;
			Object.defineProperty(statement, key, {
				value: (...args: unknown[]) => {
					note(sql);
					return method.apply(statement, args);
				},
			});
		}
		return statement;
	};
	db.prepare = ((sql: string, ...args: unknown[]) =>
		wrapStatement(sql, prepare.call(db, sql, ...(args as [])))) as typeof db.prepare;
	db.query = ((sql: string, ...args: unknown[]) =>
		wrapStatement(sql, query.call(db, sql, ...(args as [])))) as typeof db.query;
	return seen;
}

describe("mnemopi bank writes", () => {
	let dir: TempDir | undefined;

	beforeEach(() => {
		process.env.MNEMOPI_NO_EMBEDDINGS = "1";
	});

	afterEach(async () => {
		delete process.env.MNEMOPI_NO_EMBEDDINGS;
		delete process.env.MNEMOPI_PROACTIVE_LINKING;
		vi.restoreAllMocks();
		await dir?.remove();
		dir = undefined;
	});

	function bankPath(prefix: string): string {
		dir = TempDir.createSync(prefix);
		return path.join(dir.path(), "mnemopi.db");
	}

	it("commits the row on its own and both annotations together", () => {
		const beam = new BeamMemory({ sessionId: "s1", dbPath: bankPath("@mnemopi-remember-commits-") });
		try {
			const seen = recordCommits(beam.db);
			const id = beam.remember("We ship the release on Friday.", { source: "user-note" });

			// Only the row insert autocommits; the two annotation inserts share one transaction.
			expect(seen.autocommitWrites).toEqual(["INSERT INTO working_memory"]);
			expect(beam.db.query("SELECT kind FROM annotations WHERE memory_id = ? ORDER BY kind").all(id)).toEqual([
				{ kind: "has_source" },
				{ kind: "occurred_on" },
			]);
		} finally {
			beam.close();
		}
	});

	it("keeps the memory when an annotation failure makes SQLite end the transaction", () => {
		const beam = new BeamMemory({ sessionId: "s1", dbPath: bankPath("@mnemopi-remember-rollback-") });
		try {
			// RAISE(ROLLBACK) ends the whole transaction, as SQLITE_FULL can.
			beam.db.run(
				"CREATE TRIGGER fail_annotation BEFORE INSERT ON annotations BEGIN SELECT RAISE(ROLLBACK, 'disk full'); END",
			);
			const id = beam.remember("The bank keeps this row.", { source: "user-note" });

			expect(beam.db.query("SELECT content FROM working_memory WHERE id = ?").get(id)).toEqual({
				content: "The bank keeps this row.",
			});
			expect(beam.db.inTransaction).toBe(false);
		} finally {
			beam.close();
		}
	});

	it("links the episodic graph outside any transaction", () => {
		process.env.MNEMOPI_PROACTIVE_LINKING = "1";
		const beam = new BeamMemory({ sessionId: "s1", dbPath: bankPath("@mnemopi-remember-linking-") });
		try {
			const inTransaction: boolean[] = [];
			const ingest = EpisodicGraph.prototype.ingestMemory;
			vi.spyOn(EpisodicGraph.prototype, "ingestMemory").mockImplementation(function (
				this: EpisodicGraph,
				...args: Parameters<typeof ingest>
			) {
				inTransaction.push(beam.db.inTransaction);
				return ingest.apply(this, args);
			});
			beam.remember("Alice reviewed the parser change with Bob.", { source: "user-note" });

			// Graph extraction can take seconds; inside a transaction it would hold the bank's write lock.
			expect(inTransaction).toEqual([false]);
		} finally {
			beam.close();
		}
	});

	it("annotates through a store on another connection without waiting on its own transaction", () => {
		const dbPath = bankPath("@mnemopi-remember-foreign-annotations-");
		const store = new AnnotationStore(dbPath);
		const beam = new BeamMemory({
			sessionId: "s1",
			dbPath,
			annotations: {
				add: (memoryId, kind, value) => store.add(memoryId, kind, value),
				addMany: (memoryId, kind, values) => store.addMany(memoryId, kind, values),
				queryByMemory: (memoryId, kind) => store.queryByMemory(memoryId, kind),
				queryByKind: (kind, value) => store.queryByKind(kind, { value }),
				getDistinctValues: kind => store.getDistinctValues(kind),
			},
		});
		try {
			const started = performance.now();
			const id = beam.remember("Annotated elsewhere.", { source: "user-note" });

			// Its busy timeout is 5 s; a wait on our own write transaction would take that long.
			expect(performance.now() - started).toBeLessThan(2_000);
			expect(
				store
					.queryByMemory(id)
					.map(row => row.kind)
					.sort(),
			).toEqual(["has_source", "occurred_on"]);
		} finally {
			beam.close();
			store.close();
		}
	});

	it("opens file banks with synchronous=NORMAL", () => {
		dir = TempDir.createSync("@mnemopi-synchronous-");
		const db = openDatabase(path.join(dir.path(), "mnemopi.db"));
		try {
			// 1 = NORMAL: WAL is synced at checkpoints, not on every commit.
			expect(db.query("PRAGMA synchronous").get()).toEqual({ synchronous: 1 });
		} finally {
			closeQuietly(db);
		}
	});
});
