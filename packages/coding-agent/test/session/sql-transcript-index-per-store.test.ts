/**
 * `archive.search` keeps one transcript index per session store, because a
 * sync drops every session its store lacks: the store's name decides which
 * index a process syncs. These tests check what names a store (a SQLite file,
 * or a server's host, port, database, table, schema and the identity the
 * server reports of itself), that two stores never share an index and one
 * store never gets two, and how a sync reads a store's transcripts.
 *
 * Runs against SQLite always, and against PostgreSQL and MySQL when
 * `OMP_TEST_SQL_POSTGRES_URL` / `OMP_TEST_SQL_MYSQL_URL` name a throwaway
 * database; the cases of two servers behind one port also need a second,
 * independent server of the kind, with the same user, password and database
 * names (`OMP_TEST_SQL_POSTGRES_URL_B`, `OMP_TEST_SQL_MYSQL_URL_B`). The case
 * of a role refused the server's identity runs only on a PostgreSQL URL of a
 * superuser, which may create that role and revoke `pg_control_system()`.
 */
import { SQL } from "bun";
import { describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { syncTranscripts } from "@oh-my-pi/pi-coding-agent/daemon/modules/transcripts";
import { sessionDirForCwd } from "@oh-my-pi/pi-coding-agent/session/session-paths";
import { type SessionStorage, setDefaultSessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { SqlSessionStorage } from "@oh-my-pi/pi-coding-agent/session/sql-session-storage";
import * as transcriptIndex from "@oh-my-pi/pi-coding-agent/session/transcript-index";
import { getSessionsDir, getTranscriptIndexDbPath } from "@oh-my-pi/pi-utils";
import {
	AT,
	archive,
	header,
	longTranscript,
	message,
	SQL_BACKENDS,
	SQL_URLS,
	searchIds,
	searchSaysCatchingUp,
	storeSession,
	useSqlSessionTestEnv,
} from "../helpers/sql-session-archive";

const SECOND_SERVER_URLS: Record<"postgres" | "mysql", string | undefined> = {
	postgres: process.env.OMP_TEST_SQL_POSTGRES_URL_B,
	mysql: process.env.OMP_TEST_SQL_MYSQL_URL_B,
};

const env = useSqlSessionTestEnv("@omp-sql-transcript-index-per-store-");

/** Whether the PostgreSQL test URL's role is a superuser, as revoking `pg_control_system()` from PUBLIC needs. */
async function isPostgresSuperuser(url: string): Promise<boolean> {
	const client = new SQL(url);
	try {
		const [row] = (await client.unsafe("SELECT current_setting('is_superuser') AS superuser")) as Array<{
			superuser: string;
		}>;
		return row?.superuser === "on";
	} finally {
		await client.end();
	}
}
// An unreachable server is no superuser: its cases then fail one by one, instead of the whole file at load.
const POSTGRES_SUPERUSER = SQL_URLS.postgres ? await isPostgresSuperuser(SQL_URLS.postgres).catch(() => false) : false;

describe("one transcript index per session store", () => {
	it.each(SQL_BACKENDS)(
		"keeps one transcript index for %s and one for the session files, so neither sync drops the other's sessions",
		async backend => {
			const { storage } = await env.installBackend(backend);
			// Another project's omp on file storage wrote a session file.
			const other = env.tempDir.join("other");
			fs.mkdirSync(sessionDirForCwd(other), { recursive: true });
			fs.writeFileSync(
				path.join(sessionDirForCwd(other), "1000_file.jsonl"),
				header("file-session", other, AT) + message("u1", null, AT, "user", "alphafile token"),
			);
			const project = env.tempDir.join("project");
			await storeSession(
				storage,
				project,
				"sql-session",
				AT,
				header("sql-session", project, AT) + message("u1", null, AT, "user", "betasql token"),
			);
			const sessionsRoot = getSessionsDir();

			const files1 = await transcriptIndex.syncTranscriptIndex({ sessionsRoot });
			const sql1 = await transcriptIndex.syncTranscriptIndex({ sessionsRoot, storage });
			const files2 = await transcriptIndex.syncTranscriptIndex({ sessionsRoot });
			const sql2 = await transcriptIndex.syncTranscriptIndex({ sessionsRoot, storage });

			// Each indexed its one session once; after the other's sync, neither reads anything again.
			expect([files1.messages, sql1.messages, files2.messages, sql2.messages]).toEqual([1, 1, 0, 0]);
		},
	);

	it.each(SQL_BACKENDS)(
		"archive.search under %s finds the table's sessions after a file-storage process synced its index",
		async backend => {
			const { storage } = await env.installBackend(backend);
			const project = env.tempDir.join("project");
			await storeSession(
				storage,
				project,
				"sql-session",
				AT,
				header("sql-session", project, AT) + message("u1", null, AT, "user", "betasql quarterly"),
			);
			const other = env.tempDir.join("other");
			fs.mkdirSync(sessionDirForCwd(other), { recursive: true });
			fs.writeFileSync(
				path.join(sessionDirForCwd(other), "1000_file.jsonl"),
				header("file-session", other, AT) + message("u1", null, AT, "user", "alphafile token"),
			);
			expect(searchIds(await archive({ action: "search", query: "betasql" }, project))).toEqual(["sql-session"]);

			// That process's sync of the JSONL tree into the agent dir's index, as the daemon runs it.
			await transcriptIndex.syncTranscriptIndex({
				dbPath: getTranscriptIndexDbPath(),
				sessionsRoot: getSessionsDir(),
			});

			expect(searchIds(await archive({ action: "search", query: "betasql" }, project))).toEqual(["sql-session"]);
		},
	);

	/** Alternate syncs of `stores`, as their processes would, and what each store's own search then finds. */
	async function syncAndSearch(stores: SessionStorage[], words: string[], project: string) {
		const synced: number[] = [];
		for (const storage of [...stores, ...stores]) {
			synced.push((await transcriptIndex.syncTranscriptIndex({ sessionsRoot: getSessionsDir(), storage })).messages);
		}
		const found: string[][][] = [];
		for (const storage of stores) {
			setDefaultSessionStorage(storage);
			const hits: string[][] = [];
			for (const word of words) hits.push(searchIds(await archive({ action: "search", query: word }, project)));
			found.push(hits);
		}
		return { synced, found };
	}

	it("keeps one transcript index for each of two in-memory SQLite databases, and one for two stores of one", async () => {
		const first = new SQL("sqlite::memory:");
		const second = new SQL("sqlite::memory:");
		env.clients.push(first, second);
		const a = await SqlSessionStorage.create({ client: first });
		const b = await SqlSessionStorage.create({ client: second });
		const project = env.tempDir.join("project");
		const turn = (id: string, text: string) => header(id, project, AT) + message("u1", null, AT, "user", text);
		await storeSession(a, project, "memory-a", AT, turn("memory-a", "alphamemory token"));
		await storeSession(b, project, "memory-b", AT, turn("memory-b", "betamemory token"));

		// Each indexed its own session once; the other's sync dropped nothing of it.
		expect(await syncAndSearch([a, b], ["alphamemory", "betamemory"], project)).toEqual({
			synced: [1, 1, 0, 0],
			found: [
				[["memory-a"], []],
				[[], ["memory-b"]],
			],
		});
		// A second store of the first database is the same store, and keeps the same index.
		const again = await SqlSessionStorage.create({ client: first });
		expect(transcriptIndex.transcriptIndexDbPath(again)).toBe(transcriptIndex.transcriptIndexDbPath(a));
		expect(transcriptIndex.transcriptIndexDbPath(b)).not.toBe(transcriptIndex.transcriptIndexDbPath(a));
	});

	it.each(SQL_BACKENDS)("a second client of one %s table shares that table's transcript index", async backend => {
		const { storage, connect } = await env.installBackend(backend);
		const project = env.tempDir.join("project");
		await storeSession(
			storage,
			project,
			"shared-session",
			AT,
			header("shared-session", project, AT) + message("u1", null, AT, "user", "gammashared token"),
		);
		// Another omp process of the same store, with its own client.
		const other = await connect();
		expect(transcriptIndex.transcriptIndexDbPath(other)).toBe(transcriptIndex.transcriptIndexDbPath(storage));
		expect((await transcriptIndex.syncTranscriptIndex({ sessionsRoot: getSessionsDir(), storage })).messages).toBe(1);
		expect(await transcriptIndex.syncTranscriptIndex({ sessionsRoot: getSessionsDir(), storage: other })).toEqual({
			outcome: "synced",
			files: 0,
			messages: 0,
		});
	});

	it.skipIf(!SQL_URLS.postgres)(
		"keeps one transcript index for each of two PostgreSQL schemas behind one table name",
		async () => {
			const url = SQL_URLS.postgres!;
			const admin = new SQL(url);
			env.clients.push(admin);
			const tag = `${env.uniqueTag()}`;
			const schemas = [`omp_sa_${tag}`, `omp_sb_${tag}`];
			for (const schema of schemas) await admin.unsafe(`CREATE SCHEMA ${schema}`);
			env.cleanups.push(async () => {
				for (const schema of schemas) await admin.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
			});
			const stores: SessionStorage[] = [];
			for (const schema of schemas) {
				// Each client resolves the unqualified table in its own schema.
				const client = new SQL({ url, connection: { search_path: schema } } as never);
				env.clients.push(client);
				stores.push(await SqlSessionStorage.create({ client, table: `omp_schema_${tag}`, adapter: "postgres" }));
			}
			const [a, b] = stores;
			const project = env.tempDir.join("project");
			const turn = (id: string, text: string) => header(id, project, AT) + message("u1", null, AT, "user", text);
			await storeSession(a!, project, "schema-a", AT, turn("schema-a", "alphaschema token"));
			await storeSession(b!, project, "schema-b", AT, turn("schema-b", "betaschema token"));
			await b!.refresh?.();
			expect(b!.existsSync(path.join(sessionDirForCwd(project), `${new Date(AT).getTime()}_schema-a.jsonl`))).toBe(
				false,
			);

			expect(await syncAndSearch(stores, ["alphaschema", "betaschema"], project)).toEqual({
				synced: [1, 1, 0, 0],
				found: [
					[["schema-a"], []],
					[[], ["schema-b"]],
				],
			});
		},
	);

	it.skipIf(!SQL_URLS.postgres)(
		"keeps one transcript index for each of two PostgreSQL tables reached past a schema that holds neither",
		async () => {
			const url = SQL_URLS.postgres!;
			const admin = new SQL(url);
			env.clients.push(admin);
			const tag = `${env.uniqueTag()}`;
			const [empty, schemaA, schemaB] = ["s", "a", "b"].map(name => `omp_s${name}_${tag}`) as [
				string,
				string,
				string,
			];
			for (const schema of [empty, schemaA, schemaB]) await admin.unsafe(`CREATE SCHEMA ${schema}`);
			env.cleanups.push(async () => {
				for (const schema of [empty, schemaA, schemaB])
					await admin.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
			});
			const table = `omp_path_${tag}`;
			const open = async (searchPath: string, createTable: boolean) => {
				const client = new SQL({ url, connection: { search_path: searchPath } } as never);
				env.clients.push(client);
				return SqlSessionStorage.create({ client, table, adapter: "postgres", createTable });
			};
			const project = env.tempDir.join("project");
			const turn = (id: string, text: string) => header(id, project, AT) + message("u1", null, AT, "user", text);
			// The tables, made in two schemas as a migration would, each with its session.
			await storeSession(await open(schemaA, true), project, "path-a", AT, turn("path-a", "alphapath token"));
			await storeSession(await open(schemaB, true), project, "path-b", AT, turn("path-b", "betapath token"));
			// The stores: the first schema on both search paths exists and holds no table, so current_schema() is the same.
			const stores = [await open(`${empty},${schemaA}`, false), await open(`${empty},${schemaB}`, false)];
			for (const storage of stores) await storage.refresh?.();
			const dir = sessionDirForCwd(project);
			expect(stores.map(storage => storage.listFilesSync(dir, "*.jsonl").map(file => path.basename(file)))).toEqual([
				[`${new Date(AT).getTime()}_path-a.jsonl`],
				[`${new Date(AT).getTime()}_path-b.jsonl`],
			]);

			expect(await syncAndSearch(stores, ["alphapath", "betapath"], project)).toEqual({
				synced: [1, 1, 0, 0],
				found: [
					[["path-a"], []],
					[[], ["path-b"]],
				],
			});
		},
	);

	/**
	 * A TCP port on 127.0.0.1 that forwards each new connection to the server it
	 * points at. Pointing it at another server drops every connection to the
	 * last one, as stopping that server and starting another on the port would.
	 * With `drop`, a connection whose client sends a chunk `drop` accepts is
	 * dropped before the chunk reaches the server, as a network fault would.
	 */
	async function serverPort(options: { drop?: (chunk: Buffer) => boolean } = {}): Promise<{
		port: number;
		pointAt(url: string): void;
		dropped(): number;
	}> {
		let target: URL | undefined;
		let dropped = 0;
		const live = new Set<net.Socket>();
		const listener = net.createServer(socket => {
			const upstream = net.connect(Number(target!.port), target!.hostname);
			for (const end of [socket, upstream]) {
				live.add(end);
				end.on("error", () => {});
				end.on("close", () => {
					live.delete(end);
					socket.destroy();
					upstream.destroy();
				});
			}
			socket.on("data", (chunk: Buffer) => {
				if (options.drop?.(chunk)) {
					dropped++;
					socket.destroy();
					upstream.destroy();
					return;
				}
				upstream.write(chunk);
			});
			upstream.pipe(socket);
		});
		const listening = Promise.withResolvers<void>();
		listener.listen(0, "127.0.0.1", () => listening.resolve());
		await listening.promise;
		env.cleanups.push(async () => {
			for (const end of live) end.destroy();
			const closed = Promise.withResolvers<void>();
			listener.close(() => closed.resolve());
			await closed.promise;
		});
		return {
			port: (listener.address() as net.AddressInfo).port,
			pointAt(url) {
				target = new URL(url);
				for (const end of live) end.destroy();
			},
			dropped: () => dropped,
		};
	}

	/**
	 * Opens a store on `url`, puts `session` in it the first time, syncs its
	 * transcript index, searches it for `words`, and closes it, as one omp
	 * process's run against that store would.
	 */
	async function runOnStore(
		url: string,
		open: (client: SQL) => Promise<SqlSessionStorage>,
		session: { id: string; word: string } | undefined,
		words: string[],
		project: string,
	): Promise<{ synced: number; found: string[][]; index: string }> {
		const client = new SQL(url);
		try {
			const storage = await open(client);
			if (session) {
				await storeSession(
					storage,
					project,
					session.id,
					AT,
					header(session.id, project, AT) + message("u1", null, AT, "user", `${session.word} token`),
				);
			}
			const { messages } = await transcriptIndex.syncTranscriptIndex({ sessionsRoot: getSessionsDir(), storage });
			setDefaultSessionStorage(storage);
			const found: string[][] = [];
			for (const word of words) found.push(searchIds(await archive({ action: "search", query: word }, project)));
			setDefaultSessionStorage(env.previousStorage);
			transcriptIndex.closeTranscriptIndex();
			return { synced: messages, found, index: path.basename(transcriptIndex.transcriptIndexDbPath(storage)) };
		} finally {
			await client.end();
		}
	}

	for (const backend of ["postgres", "mysql"] as const) {
		it.skipIf(!SQL_URLS[backend] || !SECOND_SERVER_URLS[backend])(
			`keeps one transcript index for each of two ${backend} servers behind one port, one after the other`,
			async () => {
				const first = SQL_URLS[backend]!;
				const second = SECOND_SERVER_URLS[backend]!;
				const table = `omp_port_${env.uniqueTag()}`;
				env.cleanups.push(async () => {
					for (const url of [first, second]) {
						const admin = new SQL(url);
						try {
							await admin.unsafe(`DROP TABLE IF EXISTS ${table}_parts`);
							await admin.unsafe(`DROP TABLE IF EXISTS ${table}`);
						} finally {
							await admin.end();
						}
					}
				});
				// One URL for both servers: same host, port, user and database; only the server behind the port changes.
				const port = await serverPort();
				const shared = new URL(first);
				shared.hostname = "127.0.0.1";
				shared.port = String(port.port);
				const open = (client: SQL) => SqlSessionStorage.create({ client, table, adapter: backend });
				const project = env.tempDir.join("project");
				const words = ["alphaport", "betaport"];
				const runs: Array<{ synced: number; found: string[][]; index: string }> = [];
				for (const [server, session] of [
					[first, { id: "port-a", word: "alphaport" }],
					[second, { id: "port-b", word: "betaport" }],
					[first, undefined],
					[second, undefined],
				] as const) {
					port.pointAt(server);
					runs.push(await runOnStore(shared.href, open, session, words, project));
				}

				// Each server indexed its own session once; the other's sync dropped nothing of it, and a later
				// client of the same server found its index where the first left it.
				expect({
					synced: runs.map(run => run.synced),
					found: runs.map(run => run.found),
					sameIndexPerServer: [runs[0]!.index === runs[2]!.index, runs[1]!.index === runs[3]!.index],
					oneIndexForBoth: runs[0]!.index === runs[1]!.index,
				}).toEqual({
					synced: [1, 1, 0, 0],
					found: [
						[["port-a"], []],
						[[], ["port-b"]],
						[["port-a"], []],
						[[], ["port-b"]],
					],
					sameIndexPerServer: [true, true],
					oneIndexForBoth: false,
				});
			},
		);
	}

	it.each(SQL_BACKENDS)(
		"scanLines on a %s store visits the lines a split of the whole text gives, across read windows",
		async backend => {
			const { storage } = await env.installBackend(backend);
			const window = 1024 * 1024;
			// Lines that end exactly at, just before and just after window boundaries, multibyte text,
			// empty lines, and one line longer than a window.
			const long =
				[
					"head",
					"",
					`${"x".repeat(window - 6)}`,
					"é€😀".repeat(1000),
					"",
					"",
					`${"é".repeat(window)}`,
					"tail",
				].join("\n") + "\n";
			const texts = ["", "\n", "\n\n", "a", "a\n", "a\nb", "a\n\nb\n", long, long.slice(0, -1), `${long}\n`];
			const seen: Array<{ text: number; lines: string[] }> = [];
			const expected: Array<{ text: number; lines: string[] }> = [];
			const project = env.tempDir.join("project");
			const dir = sessionDirForCwd(project);
			storage.ensureDirSync(dir);
			for (const [n, text] of texts.entries()) {
				const file = path.join(dir, `${1000 + n}_scan.jsonl`);
				await storage.writeText(file, text);
				const lines: string[] = [];
				await storage.scanLines!(file, line => {
					lines.push(line);
					return false;
				});
				// Lines compared by length and ends, so a failure prints a short diff.
				const brief = (line: string) => `${line.length}:${line.slice(0, 8)}…${line.slice(-8)}`;
				seen.push({ text: n, lines: lines.map(brief) });
				expected.push({ text: n, lines: text.split("\n").map(brief) });
			}
			expect(seen).toEqual(expected);

			// A scan the visitor ends stops there.
			const file = path.join(dir, "2000_scan.jsonl");
			await storage.writeText(file, long);
			const upTo: string[] = [];
			await storage.scanLines!(file, line => {
				upTo.push(line);
				return line.startsWith("é€😀");
			});
			expect(upTo.length).toBe(4);
		},
	);

	it.each(SQL_BACKENDS)(
		"names a %s store by its file or its server, database, table and schema, and by no credential",
		async backend => {
			const { storage } = await env.installBackend(backend);
			const store = storage as SqlSessionStorage;
			const { key, shared } = store.storeIdentity!;
			const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
			const index = path.basename(transcriptIndex.transcriptIndexDbPath(store));
			if (backend === "sqlite") {
				// The database file by its resolved path.
				const file = path.resolve(env.tempDir.join("sessions.db"));
				expect({ key, shared, index }).toMatchObject({
					key: expect.stringMatching(new RegExp(`^sql:sqlite:${escape(file)}:${store.table}$`)),
					shared: true,
					index: expect.stringMatching(/^transcripts-[0-9a-f]{16}\.db$/),
				});
				return;
			}
			const url = new URL(SQL_URLS[backend]!);
			const port = url.port || (backend === "postgres" ? "5432" : "3306");
			const database = url.pathname.slice(1);
			// Host, port, database and table from the URL; the identity the server reports, as another client of
			// it reads; on PostgreSQL the schema.
			const admin = new SQL(SQL_URLS[backend]!);
			env.clients.push(admin);
			const [row] = (await admin.unsafe(
				backend === "postgres"
					? "SELECT system_identifier::text AS id FROM pg_catalog.pg_control_system()"
					: "SELECT @@server_uuid AS id",
			)) as Array<{ id: string }>;
			const schema = backend === "postgres" ? ":schema=public" : "";
			expect({ key, shared, index }).toMatchObject({
				key: `sql:${backend}:${url.hostname}:${port}/${database}:${store.table}:server=${row!.id}${schema}`,
				shared: true,
				index: expect.stringMatching(/^transcripts-[0-9a-f]{16}\.db$/),
			});
			// No user, no password, no connection string. A user with no password has no pair to look for.
			const secrets = [SQL_URLS[backend]!, `${url.username}@`];
			if (url.password) secrets.push(`${url.username}:${url.password}`);
			for (const secret of secrets) expect(key).not.toContain(decodeURIComponent(secret));
		},
	);

	it.each(SQL_BACKENDS)("a %s store started again keeps its transcript index", async backend => {
		const { storage } = await env.installBackend(backend);
		const before = transcriptIndex.transcriptIndexDbPath(storage);
		await (storage as SqlSessionStorage).initialize();
		expect(transcriptIndex.transcriptIndexDbPath(storage)).toBe(before);
	});

	it.each(SQL_BACKENDS)("a %s store written to between two starts keeps one transcript index", async backend => {
		const { storage, connect } = await env.installBackend(backend);
		const project = env.tempDir.join("project");
		const first = header("between", project, AT) + message("u1", null, AT, "user", "firststart token");
		const file = await storeSession(storage, project, "between", AT, first);
		const sessionsRoot = getSessionsDir();
		const synced = [(await transcriptIndex.syncTranscriptIndex({ sessionsRoot, storage })).messages];
		const before = transcriptIndex.transcriptIndexDbPath(storage);
		// Another start of the store, after a write: a new client, as the next omp process holds.
		await storage.writeText(file, first + message("u2", "u1", AT, "user", "secondstart token"));
		const again = await connect();
		synced.push((await transcriptIndex.syncTranscriptIndex({ sessionsRoot, storage: again })).messages);
		const indexes = fs.readdirSync(path.dirname(before)).filter(name => /^transcripts-[0-9a-f]{16}\.db$/.test(name));

		expect({
			sameIndex: transcriptIndex.transcriptIndexDbPath(again) === before,
			synced,
			indexes: indexes.length,
		}).toEqual({ sameIndex: true, synced: [1, 1], indexes: 1 });
	});

	it.skipIf(!SQL_URLS.postgres)(
		"a PostgreSQL store whose connection drops while it reads the server's identity fails to start",
		async () => {
			const table = `omp_drop_${env.uniqueTag()}`;
			env.cleanups.push(async () => {
				const admin = new SQL(SQL_URLS.postgres!);
				try {
					await admin.unsafe(`DROP TABLE IF EXISTS ${table}_parts`);
					await admin.unsafe(`DROP TABLE IF EXISTS ${table}`);
				} finally {
					await admin.end();
				}
			});
			const port = await serverPort({ drop: chunk => chunk.includes("pg_control_system") });
			port.pointAt(SQL_URLS.postgres!);
			const url = new URL(SQL_URLS.postgres!);
			url.hostname = "127.0.0.1";
			url.port = String(port.port);
			const client = new SQL(url.href);
			env.clients.push(client);

			const started = await SqlSessionStorage.create({ client, table, adapter: "postgres" }).then(
				storage => ({ started: storage.storeIdentity?.key.replace(/^.*:\d+\//, "…/") }),
				(error: Error) => ({ rejected: error.name }),
			);
			expect({ started, dropped: port.dropped() > 0 }).toEqual({
				started: { rejected: "PostgresError" },
				dropped: true,
			});
		},
	);

	it.skipIf(!SQL_URLS.postgres)(
		"reads a PostgreSQL store's server identity and table schema from pg_catalog when the role's search path puts stand-ins first",
		async () => {
			const url = SQL_URLS.postgres!;
			const admin = new SQL(url);
			env.clients.push(admin);
			const tag = env.uniqueTag();
			const shadow = `omp_shadow_${tag}`;
			const decoy = `omp_decoy_${tag}`;
			const table = `omp_shd_${tag}`;
			for (const schema of [shadow, decoy]) await admin.unsafe(`CREATE SCHEMA ${schema}`);
			env.cleanups.push(async () => {
				for (const schema of [shadow, decoy]) await admin.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
			});
			// Another store's table of the same name, in a schema of its own.
			const decoyClient = new SQL({ url, connection: { search_path: decoy } } as never);
			env.clients.push(decoyClient);
			await SqlSessionStorage.create({ client: decoyClient, table, adapter: "postgres" });
			// Stand-ins where the role's search path puts them before pg_catalog: an identity of 1, a
			// to_regclass that answers the other store's table, a pg_namespace that names every schema alike,
			// a text type that no identity fits, so an unqualified cast fails the start, and an oid `=` and an
			// attribute-number `>` that match nothing, so an unqualified comparison finds no schema or column.
			await admin.unsafe(
				`CREATE FUNCTION ${shadow}.pg_control_system() RETURNS TABLE (system_identifier bigint) LANGUAGE sql AS 'SELECT 1::bigint'`,
			);
			await admin.unsafe(
				`CREATE FUNCTION ${shadow}.to_regclass(text) RETURNS regclass LANGUAGE sql AS $$SELECT pg_catalog.to_regclass('${decoy}.' || $1)$$`,
			);
			await admin.unsafe(
				`CREATE VIEW ${shadow}.pg_namespace AS SELECT oid, 'chosen_by_shadow'::name AS nspname FROM pg_catalog.pg_namespace`,
			);
			await admin.unsafe(`CREATE DOMAIN ${shadow}.text AS bigint CHECK (VALUE < 0)`);
			for (const [operator, left, right] of [
				["=", "oid", "oid"],
				[">", "smallint", "integer"],
			]) {
				await admin.unsafe(
					`CREATE FUNCTION ${shadow}.no_match(${left}, ${right}) RETURNS boolean LANGUAGE sql IMMUTABLE AS 'SELECT false'`,
				);
				await admin.unsafe(
					`CREATE OPERATOR ${shadow}.${operator} (LEFTARG = ${left}, RIGHTARG = ${right}, FUNCTION = ${shadow}.no_match)`,
				);
			}
			const [real] = (await admin.unsafe(
				"SELECT system_identifier::text AS id FROM pg_catalog.pg_control_system()",
			)) as Array<{ id: string }>;
			const client = new SQL({ url, connection: { search_path: `${shadow}, pg_catalog, public` } } as never);
			env.clients.push(client);

			const storage = await SqlSessionStorage.create({ client, table, adapter: "postgres" });
			// The store's table is where the role's search path put it: in the schema first on that path.
			const [held] = (await admin.unsafe(
				`SELECT pg_catalog.to_regclass('${shadow}.${table}') IS NOT NULL AS held`,
			)) as Array<{ held: boolean }>;
			// A start that only checks the schema finds the table's columns through pg_catalog too.
			const checked = await SqlSessionStorage.create({
				client,
				table,
				adapter: "postgres",
				createTable: false,
			}).then(
				() => "started",
				(error: Error) => error.message,
			);
			expect({
				key: storage.storeIdentity!.key.match(/:server=[^:]+:schema=[^:]+$/)?.[0],
				held: held!.held,
				checked,
			}).toEqual({ key: `:server=${real!.id}:schema=${shadow}`, held: true, checked: "started" });
		},
	);

	// Creating the role and revoking `pg_control_system()` from PUBLIC need a superuser.
	it.skipIf(!POSTGRES_SUPERUSER)(
		"names a PostgreSQL store without the server's identity for a role refused it, and the store works",
		async () => {
			const admin = new SQL(SQL_URLS.postgres!);
			env.clients.push(admin);
			const tag = env.uniqueTag();
			const role = `omp_refused_${tag}`;
			const table = `omp_ref_${tag}`;
			await admin.unsafe(`CREATE ROLE ${role} LOGIN PASSWORD 'refused'`);
			await admin.unsafe(`GRANT USAGE, CREATE ON SCHEMA public TO ${role}`);
			// Function privileges are per database: this refuses the identity in the test's database only.
			await admin.unsafe("REVOKE EXECUTE ON FUNCTION pg_catalog.pg_control_system() FROM PUBLIC");
			const url = new URL(SQL_URLS.postgres!);
			url.username = role;
			url.password = "refused";
			const client = new SQL(url.href);
			env.cleanups.push(async () => {
				await client.end();
				await admin.unsafe("GRANT EXECUTE ON FUNCTION pg_catalog.pg_control_system() TO PUBLIC");
				await admin.unsafe(`DROP OWNED BY ${role}`);
				await admin.unsafe(`DROP ROLE ${role}`);
			});

			const storage = await SqlSessionStorage.create({ client, table, adapter: "postgres" });
			const project = env.tempDir.join("project");
			const content = header("refused", project, AT) + message("u1", null, AT, "user", "refusedrole token");
			const file = await storeSession(storage, project, "refused", AT, content);
			expect({
				key: storage.storeIdentity!.key.replace(/^.*:\d+\//, "…/"),
				read: await storage.readText(file),
			}).toEqual({
				key: `…/${url.pathname.slice(1)}:${table}:schema=public`,
				read: content,
			});
		},
	);

	it.each(SQL_BACKENDS.filter(backend => backend !== "sqlite"))(
		"starts a %s store without the server's identity only when the server refuses it",
		async backend => {
			const refusal =
				backend === "postgres"
					? [
							new SQL.PostgresError("permission denied for function pg_control_system", {
								code: "ERR_POSTGRES_SERVER_ERROR",
								errno: "42501",
							} as never),
							new SQL.PostgresError("function pg_control_system() does not exist", {
								code: "ERR_POSTGRES_SERVER_ERROR",
								errno: "42883",
							} as never),
							new SQL.PostgresError("pg_control_system() is not supported", {
								code: "ERR_POSTGRES_SERVER_ERROR",
								errno: "0A000",
							} as never),
						]
					: [
							new SQL.MySQLError("You have an error in your SQL syntax", {
								code: "ERR_MYSQL_SERVER_ERROR",
								errno: 1064,
								sqlState: "42000",
							} as never),
						];
			// Each database's refusals are its own: the other database's codes fail the start like any other error.
			const failure =
				backend === "postgres"
					? [
							new SQL.PostgresError("terminating connection due to administrator command", {
								code: "ERR_POSTGRES_SERVER_ERROR",
								errno: "57P01",
							} as never),
							new SQL.PostgresError("syntax error or access rule violation", {
								code: "ERR_POSTGRES_SERVER_ERROR",
								errno: "42000",
							} as never),
							Object.assign(new Error("Connection closed"), { code: "ERR_POSTGRES_CONNECTION_CLOSED" }),
						]
					: [
							new SQL.MySQLError("Server shutdown in progress", {
								code: "ERR_MYSQL_SERVER_ERROR",
								errno: 1053,
								sqlState: "08S01",
							} as never),
							// Class 42000, but a limit of the moment, not a refusal of the identity.
							new SQL.MySQLError("User omp already has more than 'max_user_connections' active connections", {
								code: "ERR_MYSQL_SERVER_ERROR",
								errno: 1203,
								sqlState: "42000",
							} as never),
							new SQL.MySQLError("User has exceeded the 'max_questions' resource", {
								code: "ERR_MYSQL_SERVER_ERROR",
								errno: 1226,
								sqlState: "42000",
							} as never),
							...["42501", "42883", "0A000"].map(
								sqlState =>
									new SQL.MySQLError(`SQLSTATE ${sqlState}`, {
										code: "ERR_MYSQL_SERVER_ERROR",
										errno: 1105,
										sqlState,
									} as never),
							),
							Object.assign(new Error("Connection closed"), { code: "ERR_MYSQL_CONNECTION_CLOSED" }),
						];
			const table = `omp_idq_${env.uniqueTag()}`;
			env.cleanups.push(async () => {
				const admin = new SQL(SQL_URLS[backend]!);
				try {
					await admin.unsafe(`DROP TABLE IF EXISTS ${table}_parts`);
					await admin.unsafe(`DROP TABLE IF EXISTS ${table}`);
				} finally {
					await admin.end();
				}
			});
			/** Starts a store whose identity query fails with `error`, as the server or the network failed it. */
			const start = async (error: Error) => {
				const client = new SQL(SQL_URLS[backend]!);
				env.clients.push(client);
				const unsafe = client.unsafe.bind(client);
				vi.spyOn(client, "unsafe").mockImplementation(((query: string, params?: unknown[]) =>
					/pg_control_system|server_uuid/.test(query) ? Promise.reject(error) : unsafe(query, params)) as never);
				return SqlSessionStorage.create({ client, table, adapter: backend }).then(
					async storage => {
						const project = env.tempDir.join("project");
						const content = header("idq", project, AT);
						const file = await storeSession(storage, project, "idq", AT, content);
						return {
							named: storage.storeIdentity!.key.includes(":server=") ? "with the identity" : "without it",
							works: (await storage.readText(file)) === content,
						};
					},
					(rejected: Error) => ({ rejected: rejected.message }),
				);
			};
			const outcomes: unknown[] = [];
			for (const error of [...refusal, ...failure]) outcomes.push(await start(error));

			expect(outcomes).toEqual([
				...refusal.map(() => ({ named: "without it", works: true })),
				...failure.map(error => ({ rejected: error.message })),
			]);
		},
	);

	it.each(SQL_BACKENDS)(
		"a %s sync that cannot list the store, or whose read fails part-way, keeps what it read and leaves the index stale",
		async backend => {
			const { storage } = await env.installBackend(backend);
			const project = env.tempDir.join("project");
			const id = `fail-${crypto.randomUUID()}`;
			const { content, messages } = longTranscript(id, project);
			await storeSession(storage, project, id, AT, content);

			// The database is unreachable from the start: the listing's refresh fails.
			const outage = vi
				.spyOn(storage, "refresh")
				.mockRejectedValue(new Error("connect ECONNREFUSED 127.0.0.1:5432"));
			expect(await syncTranscripts()).toEqual({ outcome: "partial", files: 0, messages: 0 });
			expect(transcriptIndex.isTranscriptIndexFresh(60_000)).toBe(false);
			expect(await searchSaysCatchingUp("omega final token", project)).toBe(true);
			expect(transcriptIndex.isTranscriptIndexFresh(60_000)).toBe(false);
			outage.mockRestore();

			const readFrom = storage.readTextFrom!.bind(storage);
			const failure = vi.spyOn(storage, "readTextFrom").mockImplementation(async (key, offset, maxBytes) => {
				if (offset > 0) throw new Error("connection lost");
				return readFrom(key, offset, maxBytes);
			});

			const first = await syncTranscripts();
			expect(first.outcome).toBe("partial");
			expect(first.messages).toBeGreaterThan(0);
			expect(first.messages).toBeLessThan(messages);
			expect(transcriptIndex.isTranscriptIndexFresh(60_000)).toBe(false);

			failure.mockRestore();
			const second = await syncTranscripts();
			expect(second).toEqual({ outcome: "synced", files: 1, messages: messages - first.messages });
			expect(transcriptIndex.isTranscriptIndexFresh(60_000)).toBe(true);
			expect(searchIds(await archive({ action: "search", query: "omega final token" }, project))).toEqual([id]);
		},
	);
});
