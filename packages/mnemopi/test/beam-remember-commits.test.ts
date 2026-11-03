/**
 * Retaining a memory writes a bank every omp process shares. Each autocommit statement was its own
 * transaction, and with the default `synchronous=FULL` its own WAL sync: one retain cost four
 * commits. These tests pin one commit per `remember` and `synchronous=NORMAL` on file banks.
 */
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { BeamMemory } from "@oh-my-pi/pi-mnemopi/core/beam";
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
		await dir?.remove();
		dir = undefined;
	});

	it("stores a memory, its annotations and the working-memory trim in one commit", () => {
		dir = TempDir.createSync("@mnemopi-remember-commits-");
		const beam = new BeamMemory({ sessionId: "s1", dbPath: path.join(dir.path(), "mnemopi.db") });
		try {
			const seen = recordCommits(beam.db);
			const id = beam.remember("We ship the release on Friday.", { source: "user-note" });

			expect(seen.autocommitWrites).toEqual([]);
			expect(seen.commits).toBe(1);
			expect(beam.db.query("SELECT kind FROM annotations WHERE memory_id = ? ORDER BY kind").all(id)).toEqual([
				{ kind: "has_source" },
				{ kind: "occurred_on" },
			]);
		} finally {
			beam.close();
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
