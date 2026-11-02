/**
 * `SqlSessionStorage` keys a session row by the file's path relative to the
 * sessions root (`sessions/…`), or by `abs:` and the absolute path for a file
 * outside it, so a session written from one home directory resolves from
 * another, and every spelling of a path names one session. The key migration
 * and its rollback have their own suite (sql-session-key-migration.test.ts).
 * These run against SQLite always, and against PostgreSQL and MySQL
 * when `OMP_TEST_SQL_POSTGRES_URL` / `OMP_TEST_SQL_MYSQL_URL` name a throwaway
 * database; every test makes its own tables and drops them.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { resolveResumableSession } from "@oh-my-pi/pi-coding-agent/session/session-listing";
import { moveTranscriptTree } from "@oh-my-pi/pi-coding-agent/session/session-transcript-tree";
import {
	SqlSessionStorage,
	type SqlSessionStorageAdapter,
	sessionRowDirPrefixes,
	sessionRowKey,
} from "@oh-my-pi/pi-coding-agent/session/sql-session-storage";
import type { SQL } from "bun";
import { sessionSqlTestClient } from "../helpers/session-sql-client";

type SqlClient = InstanceType<typeof SQL>;

afterEach(() => {
	vi.restoreAllMocks();
});

const BACKENDS: ReadonlyArray<{ adapter: SqlSessionStorageAdapter; url: string | undefined }> = [
	{ adapter: "sqlite", url: "sqlite::memory:" },
	{ adapter: "postgres", url: process.env.OMP_TEST_SQL_POSTGRES_URL },
	{ adapter: "mysql", url: process.env.OMP_TEST_SQL_MYSQL_URL },
];

const ROOT_A = "/home/alice/.omp/agent/sessions";
const ROOT_B = "/home/bob/.omp/agent/sessions";
/** A sessions root as an older omp under `/home/me` wrote its keys. */
const OLD_ROOT = "/home/me/.omp/agent/sessions";

/** A current-version transcript: header, one user turn, one assistant reply. */
function transcript(id: string, cwd: string, text: string): string {
	const timestamp = "2026-11-02T00:00:00.000Z";
	return `${[
		{ type: "session", version: 3, id, timestamp, cwd },
		{ type: "message", id: "m1", parentId: null, timestamp, message: { role: "user", content: text, timestamp: 1 } },
		{
			type: "message",
			id: "m2",
			parentId: "m1",
			timestamp,
			message: {
				role: "assistant",
				content: [{ type: "text", text: `${text} reply` }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "test-model",
				usage: {},
				stopReason: "stop",
				timestamp: 2,
			},
		},
	]
		.map(entry => JSON.stringify(entry))
		.join("\n")}\n`;
}

let tableSeq = 0;

/** One test's tables on one database, dropped when done. */
class Db implements AsyncDisposable {
	readonly table = `omp_rowkey_${process.pid}_${Date.now().toString(36)}_${tableSeq++}`;
	readonly client: SqlClient;

	constructor(
		readonly adapter: SqlSessionStorageAdapter,
		readonly url: string,
	) {
		this.client = sessionSqlTestClient(url);
	}

	open(sessionsRoot: string, options: { createTable?: boolean } = {}): Promise<SqlSessionStorage> {
		return SqlSessionStorage.create({ client: this.client, table: this.table, sessionsRoot, ...options });
	}

	/** Fixture SQL written with `?` placeholders, on any dialect; the rows as plain objects. */
	async sql(
		query: string,
		values: unknown[] = [],
		client: SqlClient = this.client,
	): Promise<Record<string, unknown>[]> {
		let n = 0;
		const text = this.adapter === "postgres" ? query.replace(/\?/g, () => `$${++n}`) : query;
		const rows = (await client.unsafe(text, values)) as Record<string, unknown>[];
		return rows.map(row => ({ ...row }));
	}

	async insertRow(key: string, content: string): Promise<void> {
		await this.sql(`INSERT INTO ${this.table} (path, content, mtime_ms, byte_len) VALUES (?, ?, ?, ?)`, [
			key,
			content,
			1,
			Buffer.byteLength(content),
		]);
	}

	/** The keys of `table`, in code-unit order whatever the database's collation. */
	async keys(table = this.table): Promise<string[]> {
		return (await this.sql(`SELECT path FROM ${table}`)).map(row => String(row.path)).sort();
	}

	async [Symbol.asyncDispose](): Promise<void> {
		await this.client.unsafe(`DROP TABLE IF EXISTS ${this.table}_parts`);
		await this.client.unsafe(`DROP TABLE IF EXISTS ${this.table}_meta`);
		await this.client.unsafe(`DROP TABLE IF EXISTS ${this.table}`);
		await this.client.end();
	}
}

for (const { adapter, url } of BACKENDS) {
	describe.skipIf(!url)(`SqlSessionStorage row keys (${adapter})`, () => {
		const connect = (): Db => new Db(adapter, url ?? "");

		it("resolves a session written under one home directory from a process with another", async () => {
			await using db = connect();
			const id = "01a1880d-aaaa-7000-9000-000000000001";
			const cwd = "/home/alice/src/proj";
			const name = `2026-11-02T00-00-00-000Z_${id}`;
			const writer = await db.open(ROOT_A);
			const main = transcript(id, cwd, "main turn");
			const child = transcript("child", cwd, "child turn");
			const outside = transcript("outside", cwd, "custom file");
			await writer.writeText(path.join(ROOT_A, "-src-proj", `${name}.jsonl`), main);
			await writer.writeText(path.join(ROOT_A, "-src-proj", name, "Worker.jsonl"), child);
			await writer.writeText("/srv/custom/session.jsonl", outside);
			await writer.drain();

			// The keys another box, the import tool and the key migration read.
			expect(await db.keys()).toEqual([
				"abs:/srv/custom/session.jsonl",
				`sessions/-src-proj/${name}.jsonl`,
				`sessions/-src-proj/${name}/Worker.jsonl`,
			]);

			const reader = await db.open(ROOT_B);
			const resolved = await resolveResumableSession(id.slice(0, 8), cwd, path.join(ROOT_B, "-src-proj"), reader);
			const readerFile = path.join(ROOT_B, "-src-proj", `${name}.jsonl`);
			expect(resolved?.session.path).toBe(readerFile);
			expect(await reader.readText(path.join(ROOT_B, "-src-proj", name, "Worker.jsonl"))).toBe(child);
			expect(await reader.readText("/srv/custom/session.jsonl")).toBe(outside);

			// Both processes write the one row.
			const line = `${JSON.stringify({ type: "custom", id: "c1", parentId: "m2", timestamp: "x" })}\n`;
			const appender = reader.openWriter(readerFile);
			await appender.append(line);
			await appender.close();
			await writer.refresh();
			expect(await writer.readText(path.join(ROOT_A, "-src-proj", `${name}.jsonl`))).toBe(main + line);
		});

		it("lists only rows whose key it would write back for the listed path", async () => {
			await using db = connect();
			await (await db.open(ROOT_B)).drain();
			await db.insertRow("sessions/-p/kept.jsonl", "kept\n");
			// Each of these names a row that a write to the path it suggests would not reach.
			await db.insertRow("sessions/-p/../escaped.jsonl", "escaped\n");
			await db.insertRow("sessions/-p//empty-segment.jsonl", "empty\n");
			await db.insertRow(`abs:${ROOT_B}/-p/under-root.jsonl`, "under root\n");

			const storage = await db.open(ROOT_B);
			// Start-up loads nothing; a listing loads its directory first.
			await storage.refresh({ kind: "dir", dir: path.join(ROOT_B, "-p") });

			expect(storage.listFilesSync(path.join(ROOT_B, "-p"), "*.jsonl")).toEqual([
				path.join(ROOT_B, "-p", "kept.jsonl"),
			]);
			expect(storage.existsSync(path.join(ROOT_B, "escaped.jsonl"))).toBe(false);
			expect(storage.existsSync(path.join(ROOT_B, "-p", "under-root.jsonl"))).toBe(false);
		});

		it("refuses to start on rows keyed by absolute path until they are migrated", async () => {
			await using db = connect();
			await (await db.open(ROOT_B)).drain();
			const legacy = `${OLD_ROOT}/-p/2026-01-01T00-00-00-000Z_old.jsonl`;
			await db.insertRow(legacy, "old\n");

			for (const createTable of [true, false]) {
				await expect(db.open(ROOT_B, { createTable })).rejects.toThrow(
					`holds the row key ${JSON.stringify(legacy)}, which is neither "sessions/…" nor "abs:…". ` +
						"Stop every older Oh My Pi process that writes the table, then migrate its keys with omp session migrate-keys",
				);
			}
		});

		it("names one session by every spelling of its path, through every entry point and across refresh", async () => {
			await using db = connect();
			const storage = await db.open(ROOT_B);
			const dir = path.join(ROOT_B, "-p");
			const file = path.join(dir, "s.jsonl");
			const [dotted, doubled, relative] = [
				`${ROOT_B}/-p/x/../s.jsonl`,
				`${ROOT_B}//-p//s.jsonl`,
				path.relative(process.cwd(), file),
			];

			storage.writeTextSync(dotted, "head\n");
			const writer = storage.openWriter(doubled);
			await writer.append("tail\n");
			await writer.close();
			await storage.drain();
			expect(storage.listFilesSync(`${ROOT_B}//-p/./`, "*.jsonl")).toEqual([file]);
			expect(storage.listAllSync()).toEqual([file]);
			expect(storage.statSync(relative).size).toBe(10);

			await storage.refresh();
			for (const spelling of [dotted, doubled, relative]) {
				expect({
					spelling,
					exists: storage.existsSync(spelling),
					text: await storage.readText(spelling),
					from: await storage.readTextFrom(spelling, 5),
				}).toEqual({
					spelling,
					exists: true,
					text: "head\ntail\n",
					from: { text: "tail\n", size: 10 },
				});
			}
			expect(await storage.readTextSlices(relative, 4, 5)).toEqual(["head", "tail\n"]);

			await storage.writeTextAtomic(doubled, "whole\n", { expectedSize: 10 });
			await storage.updateSessionTitle(dotted, {
				title: "Named",
				source: "user",
				updatedAt: "2026-11-02T00:00:00Z",
			});
			const [row] = await db.sql(`SELECT path, title, byte_len FROM ${db.table}`);
			expect({
				path: String(row?.path),
				title: row?.title,
				byte_len: Number(row?.byte_len),
			}).toEqual({
				path: "sessions/-p/s.jsonl",
				title: "Named",
				byte_len: Buffer.byteLength("whole\n"),
			});
			expect(await db.keys()).toEqual(["sessions/-p/s.jsonl"]);

			await storage.writeText(`${ROOT_B}/-p//s/Worker.jsonl`, "child\n");
			expect(storage.listDirsSync(`${ROOT_B}//-p/./`)).toEqual(["s"]);
			await storage.rename(relative, `${ROOT_B}/-q/../-p/moved.jsonl`);
			await storage.unlink(`${ROOT_B}/-p/./s/Worker.jsonl`);
			expect(await db.keys()).toEqual(["sessions/-p/moved.jsonl"]);
			await storage.writeText(`${ROOT_B}/-p/moved//Sub.jsonl`, "sub\n");
			await storage.deleteSessionWithArtifacts(`${ROOT_B}//-p/moved.jsonl`);
			expect(await db.keys()).toEqual([]);
			expect(storage.listFilesSync(dir, "*.jsonl")).toEqual([]);
			// The refusal names the path as the caller spelled it, not the resolved path or the row key.
			await expect(storage.readText(dotted)).rejects.toMatchObject({ code: "ENOENT", path: dotted });
		});

		it("deletes, by key, the artifact rows another home's client committed after this client refreshed", async () => {
			await using db = connect();
			const storage = await db.open(ROOT_A);
			const other = await db.open(ROOT_B);
			const session = path.join(ROOT_A, "-p", "s.jsonl");
			await storage.writeText(session, "main\n");
			await storage.writeText(path.join(ROOT_A, "-p", "s", "A.jsonl"), "child\n");
			// A sibling directory sharing the artifacts directory's name as a prefix stays.
			await storage.writeText(path.join(ROOT_A, "-p", "s2", "keep.jsonl"), "sibling\n");
			await storage.drain();
			const refresh = storage.refresh.bind(storage);
			vi.spyOn(storage, "refresh").mockImplementation(async scope => {
				await refresh(scope);
				// Committed from another home after the delete's refresh: only its key places it under the directory.
				await other.writeText(path.join(ROOT_B, "-p", "s", "Late.jsonl"), "late\n");
				await other.drain();
			});

			await storage.deleteSessionWithArtifacts(session);

			expect(await db.keys()).toEqual(["sessions/-p/s2/keep.jsonl"]);
			expect(await db.keys(`${db.table}_parts`)).toEqual(["sessions/-p/s2/keep.jsonl"]);
		});

		for (const { name, parent, children, late, kept } of [
			{
				// Round-5 review: a session file beside the root, whose artifacts directory is the root.
				name: "is the sessions root",
				parent: `${ROOT_A}.jsonl`,
				children: [path.join(ROOT_A, "early.jsonl")],
				late: [path.join(ROOT_B, "late.jsonl")],
				kept: [`${ROOT_A}x/keep.jsonl`],
			},
			{
				name: "holds the sessions root",
				parent: `${path.dirname(ROOT_A)}.jsonl`,
				children: [path.join(path.dirname(ROOT_A), "drafts", "d.txt"), path.join(ROOT_A, "-p", "early.jsonl")],
				late: [path.join(path.dirname(ROOT_A), "drafts", "late.txt"), path.join(ROOT_B, "-p", "late.jsonl")],
				kept: [`${path.dirname(ROOT_A)}x/keep.jsonl`],
			},
		]) {
			it(`deletes every row under an artifacts directory that ${name}, late ones included`, async () => {
				await using db = connect();
				const storage = await db.open(ROOT_A);
				const other = await db.open(ROOT_B);
				for (const file of [parent, ...children, ...kept]) await storage.writeText(file, `${file}\n`);
				await storage.drain();
				const refresh = storage.refresh.bind(storage);
				vi.spyOn(storage, "refresh").mockImplementation(async () => {
					await refresh();
					// Committed by another client after the delete's refresh: only the key range finds them.
					for (const file of late) await other.writeText(file, `${file}\n`);
					await other.drain();
				});

				await storage.deleteSessionWithArtifacts(parent);

				const keptKeys = kept.map(file => `abs:${file}`);
				expect(await db.keys()).toEqual(keptKeys);
				expect(await db.keys(`${db.table}_parts`)).toEqual(keptKeys);
				await other.refresh();
				expect(other.listAllSync()).toEqual(kept);
			});
		}

		it("refuses to move a transcript onto a key another home's client holds, naming the local path", async () => {
			await using db = connect();
			const storage = await db.open(ROOT_A);
			const other = await db.open(ROOT_B);
			const from = path.join(ROOT_A, "-p", "s");
			const to = path.join(ROOT_A, "-q", "t");
			await storage.writeText(path.join(from, "A.jsonl"), "ours\n");
			await storage.drain();
			// Written from another home after this client loaded its view: only the key says it is the same file.
			await other.writeText(path.join(ROOT_B, "-q", "t", "A.jsonl"), "theirs\n");
			await other.drain();

			const error = await moveTranscriptTree(storage, from, to, "*").then(
				() => undefined,
				(err: unknown) => err,
			);

			expect(error).toMatchObject({ code: "EEXIST", path: path.join(to, "A.jsonl") });
			expect(await db.keys()).toEqual(["sessions/-p/s/A.jsonl", "sessions/-q/t/A.jsonl"]);
			expect(await storage.readText(path.join(from, "A.jsonl"))).toBe("ours\n");
			expect(await other.readText(path.join(ROOT_B, "-q", "t", "A.jsonl"))).toBe("theirs\n");
		});

		it("counts a key as legacy by its bytes, whatever follows a prefix", async () => {
			await using db = connect();
			await (await db.open(ROOT_B)).drain();
			// Prefixed keys whose next character sorts below a space under a padding collation.
			await db.insertRow("abs:\u0001/x.jsonl", "low\n");
			await db.insertRow("sessions/\t-p/x.jsonl", "tab\n");
			await (await db.open(ROOT_B)).drain();

			await db.insertRow("abs", "no colon\n");
			await expect(db.open(ROOT_B)).rejects.toThrow('holds the row key "abs"');
		});
	});
}

describe("sessionRowDirPrefixes", () => {
	const agent = path.dirname(ROOT_A);
	const cases: ReadonlyArray<[dir: string, root: string, prefixes: string[]]> = [
		[ROOT_A, ROOT_A, ["sessions/"]],
		[`${ROOT_A}/`, ROOT_A, ["sessions/"]],
		[`${ROOT_A}/-p/s`, ROOT_A, ["sessions/-p/s/"]],
		[`${ROOT_A}//-p/./s/`, `${ROOT_A}/`, ["sessions/-p/s/"]],
		["/srv/x", ROOT_A, ["abs:/srv/x/"]],
		[`${ROOT_A}x`, ROOT_A, [`abs:${ROOT_A}x/`]],
		[agent, ROOT_A, [`abs:${agent}/`, "sessions/"]],
		["/", ROOT_A, ["abs:/", "sessions/"]],
		["/", "/", ["sessions/"]],
	];
	for (const [dir, root, prefixes] of cases) {
		it(`gives ${JSON.stringify(prefixes)} for ${dir} under the root ${root}`, () => {
			expect(sessionRowDirPrefixes(dir, root)).toEqual(prefixes);
		});
	}

	it("covers the key of every file under the directory, and of no file outside it", () => {
		const files = [
			`${ROOT_A}/a.jsonl`,
			`${ROOT_A}/-p/s/A.jsonl`,
			`${ROOT_A}/-p/s2/B.jsonl`,
			`${ROOT_A}x/c.jsonl`,
			`${agent}/drafts/d.txt`,
			`${agent}x/e.txt`,
			"/srv/x/f.jsonl",
			"/srv/xy/g.jsonl",
		];
		for (const [dir, root] of cases) {
			const prefixes = sessionRowDirPrefixes(dir, root);
			const resolved = path.resolve(dir);
			for (const file of files) {
				const under = file.startsWith(resolved === "/" ? "/" : `${resolved}/`);
				const covered = prefixes.some(prefix => sessionRowKey(file, root).startsWith(prefix));
				expect({ dir, root, file, covered }).toEqual({ dir, root, file, covered: under });
			}
		}
	});
});
