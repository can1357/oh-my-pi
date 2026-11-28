/**
 * A SQL or Redis session store shows, on every read, the title the backend
 * holds for the bytes that read returns, and keeps no session's title in its
 * in-memory index:
 *
 * - a store that opened a session before another store renamed, cleared or
 *   rewrote it shows the new title at once, without a refresh;
 * - a read that another client's full write races gives one version's title
 *   with that version's bytes, wherever the write lands around the read's
 *   statement (Redis script);
 * - on Redis, a move and a removal change a session's body, time and title
 *   together, so a reader never sees a moved body under the title its
 *   destination had, and a removal never strips the title of a body written
 *   at the path right after it;
 * - the index entry of a session holds no title after full writes, a title
 *   update, an append or a refresh;
 * - on PostgreSQL and MySQL, a title update for a session another process
 *   deleted rejects with `ENOENT` and leaves the session deleted (the SQLite
 *   leg is in sql-session-storage.test.ts);
 * - on MySQL, a title update that changes no row counts as stored only when the
 *   row read after it, as the driver returns it, holds every value the update
 *   set: a row another process already set to them resolves, and a row another
 *   process creates after the update with other values rejects with `ENOENT`.
 *
 * SQLite always; PostgreSQL, MySQL and Redis when `OMP_TEST_SQL_POSTGRES_URL`,
 * `OMP_TEST_SQL_MYSQL_URL` and `OMP_TEST_REDIS_URL` name a server.
 */
import { describe, expect, it } from "bun:test";
import type { IndexedSessionStorage } from "@oh-my-pi/pi-coding-agent/session/indexed-session-storage";
import {
	RedisSessionStorage,
	type RedisSessionStorageClient,
} from "@oh-my-pi/pi-coding-agent/session/redis-session-storage";
import {
	parseTitleSlotFromContent,
	type SessionTitleUpdate,
	serializeTitleSlot,
} from "@oh-my-pi/pi-coding-agent/session/session-title-slot";
import {
	type SqlSessionStorageAdapter,
	SqlSessionStorage,
	type SqlSessionStorageClient,
} from "@oh-my-pi/pi-coding-agent/session/sql-session-storage";
import { TempDir } from "@oh-my-pi/pi-utils";
import { RedisClient, SQL } from "bun";

const TIMESTAMP = "2026-11-27T00:00:00.000Z";
const ID = "01a1f000-0000-7000-8000-0000000000b7";
const PAD_BYTES = 4096;
const CASE_TIMEOUT = 120_000;
/**
 * How long a look at the heap waits for an index entry that a write replaced to go: JSC can keep such an object
 * past a few full collections, while an entry the index still holds stays for the whole wait.
 */
const SETTLE_MS = 5_000;

function sessionFile(name: string): string {
	return `/sessions/-project-/2026-11-27T00-00-00-000Z_${name}.jsonl`;
}

/** The header and two entries of a session, without a title slot: longer than the slot. */
const UNTITLED_BODY = `${[
	{ type: "session", version: 3, id: ID, timestamp: TIMESTAMP, cwd: "/project" },
	{
		type: "message",
		id: "m1",
		parentId: null,
		timestamp: TIMESTAMP,
		message: { role: "user", content: "x".repeat(300) },
	},
	{ type: "message", id: "m2", parentId: "m1", timestamp: TIMESTAMP, message: { role: "user", content: "second" } },
]
	.map(entry => JSON.stringify(entry))
	.join("\n")}\n`;

function titled(update: SessionTitleUpdate): string {
	return `${serializeTitleSlot(update)}${UNTITLED_BODY}`;
}

/** One committed version of a session: the title the store holds for it, and the fill of its pads. */
interface Version {
	readonly title: string;
	readonly fill: string;
}

/** Two versions whose bodies have one size. */
const FIRST: Version = { title: "Title of the first version", fill: "f" };
const SECOND: Version = { title: "Title of the other version", fill: "s" };

/** `version`'s body: its title slot (unless `untitled`), the header, then three pads of its fill. */
function bodyOf(version: Version, untitled = false): string {
	const header = { type: "session", version: 3, id: ID, timestamp: TIMESTAMP, cwd: "/project" };
	const pads = Array.from({ length: 3 }, (_, n) =>
		JSON.stringify({
			type: "custom",
			customType: "pad",
			id: `p${n}`,
			parentId: null,
			timestamp: TIMESTAMP,
			data: version.fill.repeat(PAD_BYTES),
		}),
	);
	const slot = untitled ? "" : serializeTitleSlot({ title: version.title, source: "user", updatedAt: TIMESTAMP });
	return `${slot}${[JSON.stringify(header), ...pads].join("\n")}\n`;
}

/**
 * The pair a read's text shows: the title its head carries and the fill of the pads it holds, as
 * `<title> / <fills>`; a text holding a pad of each version shows both fills.
 */
function pairOf(head: string, rest = head): string {
	const title = /"title":"([^"]*)"/.exec(head)?.[1] ?? "(no title)";
	const fills = [FIRST, SECOND].filter(version => rest.includes(version.fill.repeat(64))).map(({ fill }) => fill);
	return `${title} / ${fills.join("") || "(no pad)"}`;
}

const ONE_VERSION = [`${FIRST.title} / ${FIRST.fill}`, `${SECOND.title} / ${SECOND.fill}`];

/** Where another client's write lands: right before or right after the command numbered `at`, from 0. */
interface Point {
	readonly at: number;
	readonly after: boolean;
}

function pointsUpTo(sent: number): Point[] {
	return Array.from({ length: sent }, (_, at) => [
		{ at, after: false },
		{ at, after: true },
	]).flat();
}

function pointName(point: Point): string {
	return `${point.after ? "after" : "before"} #${point.at}`;
}

/**
 * Counts the commands (SQL statements, Redis commands) a store sends from {@link arm} on, and runs the race once,
 * right before or right after the one numbered `point.at`.
 */
class Gate {
	#sent = 0;
	#point: Point | undefined;
	#race: (() => Promise<void>) | undefined;
	ran = false;

	arm(point?: Point, race?: () => Promise<void>): void {
		this.#sent = 0;
		this.#point = point;
		this.#race = race;
		this.ran = false;
	}

	get sent(): number {
		return this.#sent;
	}

	async around<T>(call: () => Promise<T>): Promise<T> {
		const at = this.#sent++;
		if (this.#point?.at === at && !this.#point.after) await this.#run();
		const result = await call();
		if (this.#point?.at === at && this.#point.after) await this.#run();
		return result;
	}

	async #run(): Promise<void> {
		const race = this.#race;
		this.#race = undefined;
		if (!race) return;
		this.ran = true;
		await race();
	}
}

/** `client` with every statement it or its transactions send passed through `gate`. */
function gatedSql(client: SqlSessionStorageClient, gate: Gate): SqlSessionStorageClient {
	return {
		options: client.options,
		unsafe: (query, values) => gate.around(() => client.unsafe(query, values)),
		transaction: callback =>
			client.transaction(transaction =>
				callback({ unsafe: (query, values) => gate.around(() => transaction.unsafe(query, values)) }),
			),
	};
}

/** `client` with every command it sends passed through `gate`. */
function gatedRedis(client: RedisSessionStorageClient, gate: Gate): RedisSessionStorageClient {
	return {
		send: (command, args) => gate.around(() => client.send(command, args)),
		get: key => gate.around(() => client.get(key)),
		getrange: (key, start, end) => gate.around(() => client.getrange(key, start, end)),
		strlen: key => gate.around(() => client.strlen(key)),
		set: (key, value) => gate.around(() => client.set(key, value)),
		append: (key, value) => gate.around(() => client.append(key, value)),
		del: (...keys) => gate.around(() => client.del(...keys)),
		rename: (src, dst) => gate.around(() => client.rename(src, dst)),
		scan: (cursor, ...args) => gate.around(() => client.scan(cursor, ...args)),
		hset: (key, field, value) => gate.around(() => client.hset(key, field, value)),
		hgetall: key => gate.around(() => client.hgetall(key)),
		hdel: (key, ...fields) => gate.around(() => client.hdel(key, ...fields)),
	};
}

/** One shared session store, and stores over it, each with a connection of its own, as separate processes have. */
interface SharedStore {
	/** A store over the shared one, its commands passed through `gate` when one is given. */
	open(gate?: Gate): Promise<IndexedSessionStorage>;
}

/** A {@link SharedStore} over a SQL table, and clients of their own on its database for a test's own statements. */
interface SharedSqlStore extends SharedStore {
	readonly table: string;
	/** A client of its own on the table's database, ended by the store's cleanup. */
	connect(): InstanceType<typeof SQL>;
}

/**
 * A table of its own on `url`'s database (a file of its own for SQLite). `cleanup` ends each client as it is made,
 * then drops the table on a client of its own, then ends that client, then removes the file's directory, each
 * release tried whatever the others did.
 */
async function sqlStore(
	adapter: SqlSessionStorageAdapter,
	url: string,
	cleanup: AsyncDisposableStack,
): Promise<SharedSqlStore> {
	const dir = adapter === "sqlite" ? await TempDir.create("@omp-index-entry-") : undefined;
	if (dir) cleanup.defer(() => dir.remove());
	const table = `omp_index_entry_${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`;
	const client = (): InstanceType<typeof SQL> =>
		dir ? new SQL({ adapter: "sqlite", filename: dir.join("sessions.db") }) : new SQL(url);
	// Registered before any client a store opens, so they run after those end: the drop, then the dropping
	// client's end (the stack runs them last first).
	let dropper: InstanceType<typeof SQL> | undefined;
	cleanup.defer(async () => {
		await dropper?.end();
	});
	cleanup.defer(async () => {
		dropper = client();
		await dropper.unsafe(`DROP TABLE IF EXISTS ${table}`);
	});
	const connect = (): InstanceType<typeof SQL> => {
		const opened = client();
		cleanup.defer(() => opened.end());
		return opened;
	};
	return {
		table,
		connect,
		async open(gate) {
			const opened = connect();
			return SqlSessionStorage.create({ client: gate ? gatedSql(opened, gate) : opened, table });
		},
	};
}

/**
 * A store over `shared` whose title updates run `race` with the update's statement and values, right before the update
 * when `before`, else right after it, as another process's statement lands there.
 */
async function racedTitleUpdates(
	shared: SharedSqlStore,
	before: boolean,
	race: (statement: string, values: unknown[]) => Promise<unknown>,
): Promise<IndexedSessionStorage> {
	const opened: SqlSessionStorageClient = shared.connect();
	const client: SqlSessionStorageClient = {
		options: opened.options,
		transaction: callback => opened.transaction(callback),
		async unsafe(query, values = []) {
			const titleUpdate = /^UPDATE \w+ SET title = /.test(query);
			if (titleUpdate && before) await race(query, values);
			const result = await opened.unsafe(query, values);
			if (titleUpdate && !before) await race(query, values);
			return result;
		},
	};
	return SqlSessionStorage.create({ client, table: shared.table });
}

/**
 * A key prefix of its own on `url`'s server. `cleanup` closes each client as it is made, then deletes the prefix's
 * keys on a client of its own.
 */
function redisStore(url: string, cleanup: AsyncDisposableStack): SharedStore {
	const prefix = `omp-test:index-entry:${crypto.randomUUID()}:`;
	// Registered before any client a store opens, so it runs after they close.
	cleanup.defer(async () => {
		const cleaner = new RedisClient(url);
		try {
			const keys = (await cleaner.send("KEYS", [`${prefix}*`])) as string[];
			if (keys.length > 0) await cleaner.send("DEL", keys);
		} finally {
			cleaner.close();
		}
	});
	return {
		open(gate) {
			const client = new RedisClient(url);
			cleanup.defer(() => client.close());
			return RedisSessionStorage.create({ client: gate ? gatedRedis(client, gate) : client, prefix });
		},
	};
}

/** The first line every reader of `storage` gives `file`: its text, its head slice and its line scan. */
async function headsOf(storage: IndexedSessionStorage, file: string): Promise<Record<string, string>> {
	const firstLine = (text: string): string => text.split("\n")[0] ?? "";
	let scanned = "";
	await storage.scanLines(file, line => {
		scanned = line;
		return true;
	});
	return {
		readText: firstLine(await storage.readText(file)),
		readTextSlices: firstLine((await storage.readTextSlices(file, 512, 0))[0]),
		scanLines: scanned,
	};
}

/** `line` as the first line of every reader {@link headsOf} asks. */
function everywhere(line: string): Record<string, string> {
	return { readText: line, readTextSlices: line, scanLines: line };
}

function slotLine(update: SessionTitleUpdate): string {
	return serializeTitleSlot(update).slice(0, -1);
}

/** The cases every backend runs, on the shared store `open` opens. */
function storeCases(open: (cleanup: AsyncDisposableStack) => Promise<SharedStore>): void {
	// If this regresses, a store that opened a session before another store (another process) renamed, cleared or
	// rewrote it keeps showing the title it saw first, over the session's new bytes, until it refreshes: the
	// picker, the session list and a resume show a title the session no longer has.
	it(
		"an open store reads another store's rename, clear and rewrites with the bytes, before and after a refresh",
		async () => {
			await using cleanup = new AsyncDisposableStack();
			const shared = await open(cleanup);
			const writer = await shared.open();
			const file = sessionFile("peer");
			const old: SessionTitleUpdate = { title: "Old title", source: "auto", updatedAt: "2026-11-27T00:00:01.000Z" };
			await writer.writeText(file, titled(old));
			const reader = await shared.open();
			const seen: Record<string, Record<string, string>> = { opened: await headsOf(reader, file) };

			const renamed: SessionTitleUpdate = {
				title: "Renamed",
				source: "user",
				updatedAt: "2026-11-27T00:00:02.000Z",
			};
			await writer.updateSessionTitle(file, renamed);
			seen.renamed = await headsOf(reader, file);
			const cleared: SessionTitleUpdate = { title: "", source: "user", updatedAt: "2026-11-27T00:00:03.000Z" };
			await writer.updateSessionTitle(file, cleared);
			seen.cleared = await headsOf(reader, file);
			const rewritten: SessionTitleUpdate = {
				title: "Rewritten",
				source: "auto",
				updatedAt: "2026-11-27T00:00:04.000Z",
			};
			await writer.writeText(file, titled(rewritten));
			seen.rewritten = await headsOf(reader, file);

			await reader.refresh();
			seen.refreshed = await headsOf(reader, file);
			const later: SessionTitleUpdate = { title: "Later", source: "user", updatedAt: "2026-11-27T00:00:05.000Z" };
			await writer.updateSessionTitle(file, later);
			seen.renamedAfterRefresh = await headsOf(reader, file);
			await writer.writeText(file, UNTITLED_BODY);
			seen.untitled = await headsOf(reader, file);

			expect(seen).toEqual({
				opened: everywhere(slotLine(old)),
				renamed: everywhere(slotLine(renamed)),
				cleared: everywhere(slotLine(cleared)),
				rewritten: everywhere(slotLine(rewritten)),
				refreshed: everywhere(slotLine(rewritten)),
				renamedAfterRefresh: everywhere(slotLine(later)),
				untitled: everywhere(UNTITLED_BODY.slice(0, UNTITLED_BODY.indexOf("\n"))),
			});
		},
		CASE_TIMEOUT,
	);

	const reads: ReadonlyArray<{
		name: string;
		read: (reader: IndexedSessionStorage, file: string) => Promise<string>;
	}> = [
		{ name: "readText", read: async (reader, file) => pairOf(await reader.readText(file)) },
		{
			name: "readTextSlices, the head and the tail",
			read: async (reader, file) => {
				const [head, tail] = await reader.readTextSlices(file, 400, 1024);
				return pairOf(head, tail);
			},
		},
	];
	for (const { name, read } of reads) {
		// If this regresses, a reader lays the title of one version of a session over the bytes of another: the
		// picker, the roster and a resume show a title the transcript they show never had.
		it(
			`${name} gives one version's title with that version's bytes when another store's full write lands before or after any command of it`,
			async () => {
				await using cleanup = new AsyncDisposableStack();
				const shared = await open(cleanup);
				const writer = await shared.open();
				const file = sessionFile("raced");
				await writer.writeText(file, bodyOf(FIRST));
				const gate = new Gate();
				const reader = await shared.open(gate);
				gate.arm();
				expect(await read(reader, file)).toBe(ONE_VERSION[0]);

				const outcomes: Array<{ point: string; raced: boolean; pair: string }> = [];
				for (const point of pointsUpTo(gate.sent)) {
					await writer.writeText(file, bodyOf(FIRST));
					gate.arm(point, () => writer.writeText(file, bodyOf(SECOND)));
					const pair = await read(reader, file);
					outcomes.push({ point: pointName(point), raced: gate.ran, pair });
				}
				expect(outcomes.filter(({ raced, pair }) => !raced || !ONE_VERSION.includes(pair))).toEqual([]);
			},
			CASE_TIMEOUT,
		);
	}
}

const SQL_BACKENDS: ReadonlyArray<{ adapter: SqlSessionStorageAdapter; url: string | undefined }> = [
	{ adapter: "sqlite", url: "sqlite" },
	{ adapter: "postgres", url: process.env.OMP_TEST_SQL_POSTGRES_URL },
	{ adapter: "mysql", url: process.env.OMP_TEST_SQL_MYSQL_URL },
];

for (const { adapter, url } of SQL_BACKENDS) {
	describe.skipIf(!url)(`a SQL store reads a session's title with its bytes (${adapter})`, () => {
		storeCases(cleanup => sqlStore(adapter, url ?? "", cleanup));

		// If this regresses, a title update for a session another process deleted resolves as if stored: the session
		// manager then marks the session current instead of rewriting it, so the session stays missing from the table.
		if (adapter !== "sqlite") {
			it(
				"rejects a title update with ENOENT when another process deleted the session's row, and leaves the session deleted",
				async () => {
					await using cleanup = new AsyncDisposableStack();
					const shared = await sqlStore(adapter, url ?? "", cleanup);
					const storage = await shared.open();
					const file = sessionFile("deleted");
					await storage.writeText(file, UNTITLED_BODY);
					const other = shared.connect();
					const wherePath = `WHERE path = ${adapter === "postgres" ? "$1" : "?"}`;
					await other.unsafe(`DELETE FROM ${shared.table} ${wherePath}`, [file]);

					await expect(
						storage.updateSessionTitle(file, { title: "Stale", source: "user", updatedAt: TIMESTAMP }),
					).rejects.toMatchObject({ code: "ENOENT" });
					expect(Array.from(await other.unsafe(`SELECT path FROM ${shared.table} ${wherePath}`, [file]))).toEqual(
						[],
					);
				},
				CASE_TIMEOUT,
			);
		}

		if (adapter === "mysql") {
			// If this regresses, a title update whose row another process already set to the same title, source, time
			// and mtime rejects as missing on a MySQL server: the session manager then rewrites a session that is there.
			it(
				"resolves a title update that leaves its row as another process already set it",
				async () => {
					await using cleanup = new AsyncDisposableStack();
					const shared = await sqlStore(adapter, url ?? "", cleanup);
					const other = shared.connect();
					// Another process runs the same update first, so this store's update leaves the row as it was.
					const storage = await racedTitleUpdates(shared, true, (statement, values) =>
						other.unsafe(statement, values),
					);
					const file = sessionFile("unchanged");
					await storage.writeText(file, UNTITLED_BODY);
					const update: SessionTitleUpdate = { title: "Same", source: "user", updatedAt: TIMESTAMP };

					const outcome = await storage.updateSessionTitle(file, update).then(
						() => "stored",
						(error: NodeJS.ErrnoException) => error.code,
					);
					expect({ outcome, heads: await headsOf(storage, file) }).toEqual({
						outcome: "stored",
						heads: everywhere(slotLine(update)),
					});
				},
				CASE_TIMEOUT,
			);

			// If this regresses, a title update that matched no row resolves on a MySQL server when another process
			// creates a row at the path before the check after the update: the session manager marks the session
			// current though its title was never written. A row that holds every value the update set is the row the
			// update would have left, and counts as stored.
			it(
				"rejects a title update with ENOENT, writing nothing, when a row another process creates after it holds other title metadata or time, and resolves when it holds the update's",
				async () => {
					await using cleanup = new AsyncDisposableStack();
					const shared = await sqlStore(adapter, url ?? "", cleanup);
					const other = shared.connect();
					const selectRow = `SELECT title, title_source, title_updated_at, mtime_ms FROM ${shared.table} WHERE path = ?`;
					const update: SessionTitleUpdate = { title: "Ours", source: "user", updatedAt: TIMESTAMP };
					// The title, source, time and mtime of the row another process creates once the update has matched
					// none: the update's values but the one named.
					const differing: Record<string, (values: unknown[]) => unknown[]> = {
						none: values => values.slice(0, 4),
						title: ([, source, time, mtime]) => ["Theirs", source, time, mtime],
						source: ([title, , time, mtime]) => [title, "auto", time, mtime],
						time: ([title, source, , mtime]) => [title, source, "2026-11-27T00:00:09.000Z", mtime],
						mtime: ([title, source, time, mtime]) => [title, source, time, Number(mtime) - 1],
					};
					const actual: Record<string, unknown> = {};
					const expected: Record<string, unknown> = {};
					for (const [field, differ] of Object.entries(differing)) {
						const file = sessionFile(`created-${field}`);
						let created: unknown[] = [];
						const storage = await racedTitleUpdates(shared, false, async (_statement, values) => {
							const [title, source, time, mtime] = differ(values);
							await other.unsafe(
								`INSERT INTO ${shared.table} (path, content, mtime_ms, title, title_source, title_updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
								[file, UNTITLED_BODY, mtime, title, source, time],
							);
							created = Array.from(await other.unsafe(selectRow, [file]));
						});
						await storage.writeText(file, UNTITLED_BODY);
						await other.unsafe(`DELETE FROM ${shared.table} WHERE path = ?`, [file]);

						const outcome = await storage.updateSessionTitle(file, update).then(
							() => "stored",
							(error: NodeJS.ErrnoException) => error.code,
						);
						actual[field] = { outcome, row: Array.from(await other.unsafe(selectRow, [file])) };
						expected[field] = { outcome: field === "none" ? "stored" : "ENOENT", row: created };
					}
					expect(actual).toEqual(expected);
				},
				CASE_TIMEOUT,
			);
		}
	});
}

const REDIS_URL = process.env.OMP_TEST_REDIS_URL;

describe.skipIf(!REDIS_URL)("a Redis store reads a session's title with its bytes (Redis server)", () => {
	storeCases(async cleanup => redisStore(REDIS_URL ?? "", cleanup));

	// If this regresses, a session moved onto a path whose session had a title shows that title over the moved
	// transcript, for a while (a reader between the move's commands) or for good (the destination's title is never
	// deleted when the moved session has none).
	it(
		"a move of an untitled session onto a titled one gives a reader the old pair before it and the untitled body after it",
		async () => {
			await using cleanup = new AsyncDisposableStack();
			const shared = redisStore(REDIS_URL ?? "", cleanup);
			const gate = new Gate();
			const mover = await shared.open(gate);
			const src = sessionFile("moved");
			const dst = sessionFile("target");
			const reset = async (): Promise<void> => {
				await mover.writeText(src, bodyOf(SECOND, true));
				await mover.writeText(dst, bodyOf(FIRST));
			};
			await reset();
			const reader = await shared.open();
			gate.arm();
			await mover.rename(src, dst);
			const moved = `(no title) / ${SECOND.fill}`;

			const outcomes: Array<{ point: string; raced: boolean; during: string; after: string }> = [];
			for (const point of pointsUpTo(gate.sent)) {
				await reset();
				let during = "(no read)";
				gate.arm(point, async () => {
					during = pairOf(await reader.readText(dst));
				});
				await mover.rename(src, dst);
				const after = pairOf(await reader.readText(dst));
				outcomes.push({ point: pointName(point), raced: gate.ran, during, after });
			}
			expect(
				outcomes.filter(
					({ raced, during, after }) =>
						!raced || ![`${FIRST.title} / ${FIRST.fill}`, moved].includes(during) || after !== moved,
				),
			).toEqual([]);
		},
		CASE_TIMEOUT,
	);

	// If this regresses, a session written at a path right after another store removed the session there loses
	// its title (and its time) to the removal's late metadata delete: it lists and resumes under the title its
	// bytes carried when written, not the one set after.
	it(
		"a removal racing a recreate at the same path leaves the path gone or the recreated session with its later title",
		async () => {
			await using cleanup = new AsyncDisposableStack();
			const shared = redisStore(REDIS_URL ?? "", cleanup);
			const gate = new Gate();
			const remover = await shared.open(gate);
			const recreator = await shared.open();
			const file = sessionFile("recreated");
			const later: SessionTitleUpdate = {
				title: "Title set after the recreate",
				source: "user",
				updatedAt: "2026-11-27T00:00:06.000Z",
			};
			await remover.writeText(file, bodyOf(FIRST));
			gate.arm();
			await remover.unlink(file);

			const outcomes: Array<{ point: string; raced: boolean; outcome: string }> = [];
			for (const point of pointsUpTo(gate.sent)) {
				await remover.writeText(file, bodyOf(FIRST));
				gate.arm(point, async () => {
					await recreator.writeText(file, bodyOf(SECOND));
					await recreator.updateSessionTitle(file, later);
				});
				await remover.unlink(file);
				const checker = await shared.open();
				const outcome = checker.existsSync(file) ? pairOf(await checker.readText(file)) : "gone";
				outcomes.push({ point: pointName(point), raced: gate.ran, outcome });
			}
			expect(
				outcomes.filter(
					({ raced, outcome }) => !raced || !["gone", `${later.title} / ${SECOND.fill}`].includes(outcome),
				),
			).toEqual([]);
		},
		CASE_TIMEOUT,
	);
});

interface HeapSnapshot {
	snapshot: {
		meta: {
			node_fields: string[];
			node_types: Array<string | string[]>;
			edge_fields: string[];
			edge_types: Array<string | string[]>;
		};
	};
	nodes: number[];
	edges: number[];
	strings: string[];
}

/** Node kinds whose text is a string's characters. */
const STRING_NODE_TYPES: Readonly<Record<string, true>> = {
	string: true,
	"concatenated string": true,
	"sliced string": true,
};
/** Edge kinds that keep their target alive. */
const STRONG_EDGE_TYPES: Readonly<Record<string, true>> = {
	property: true,
	context: true,
	element: true,
	internal: true,
	hidden: true,
};

/**
 * The strings carrying `marker` that a plain object no other heap object holds keeps, as
 * `(Object a table holds).<property>: <the string>`. A Map keeps its values in a table the heap snapshot records
 * no edge out of, so the entry the storage's index keeps for a path is such an object, as is the value of any other
 * Map or Set; an object the test or a pending call holds has a retainer the snapshot shows.
 */
function keptInTables(snapshot: HeapSnapshot, marker: string): string[] {
	const {
		node_fields: nodeFields,
		node_types: nodeTypes,
		edge_fields: edgeFields,
		edge_types: edgeTypes,
	} = snapshot.snapshot.meta;
	const nodeTypeNames = nodeTypes[nodeFields.indexOf("type")];
	const edgeTypeNames = edgeTypes[edgeFields.indexOf("type")];
	if (!Array.isArray(nodeTypeNames) || !Array.isArray(edgeTypeNames)) throw new Error("Unexpected heap snapshot");
	const nodeStride = nodeFields.length;
	const edgeStride = edgeFields.length;
	const typeAt = nodeFields.indexOf("type");
	const nameAt = nodeFields.indexOf("name");
	const edgeCountAt = nodeFields.indexOf("edge_count");
	const edgeTypeAt = edgeFields.indexOf("type");
	const edgeNameAt = edgeFields.indexOf("name_or_index");
	const edgeToAt = edgeFields.indexOf("to_node");
	const { nodes, edges, strings } = snapshot;
	const nodeCount = nodes.length / nodeStride;
	const type = (node: number): string => nodeTypeNames[nodes[node * nodeStride + typeAt]!] ?? "";
	const name = (node: number): string => strings[nodes[node * nodeStride + nameAt]!] ?? "";
	/** Each strong edge, as `visit(from, edge type, edge name index, to)`. */
	const eachEdge = (visit: (from: number, edgeType: string, edgeName: number, to: number) => void): void => {
		for (let node = 0, edge = 0; node < nodeCount; node++) {
			const end = edge + nodes[node * nodeStride + edgeCountAt]!;
			for (; edge < end; edge++) {
				const edgeType = edgeTypeNames[edges[edge * edgeStride + edgeTypeAt]!] ?? "";
				if (!STRONG_EDGE_TYPES[edgeType]) continue;
				const to = edges[edge * edgeStride + edgeToAt]! / nodeStride;
				if (to !== node) visit(node, edgeType, edges[edge * edgeStride + edgeNameAt]!, to);
			}
		}
	};

	const marked = new Set<number>();
	for (let node = 0; node < nodeCount; node++) {
		if (STRING_NODE_TYPES[type(node)] && name(node).includes(marker)) marked.add(node);
	}
	const holders: Array<{ object: number; property: string; text: string }> = [];
	eachEdge((from, edgeType, edgeName, to) => {
		if (edgeType !== "property" || !marked.has(to) || type(from) !== "object" || name(from) !== "Object") return;
		holders.push({ object: from, property: strings[edgeName] ?? "", text: name(to) });
	});
	const objects = new Set(holders.map(({ object }) => object));
	const held = new Set<number>();
	eachEdge((_from, _edgeType, _edgeName, to) => {
		if (objects.has(to)) held.add(to);
	});
	return holders
		.filter(({ object }) => !held.has(object))
		.map(({ property, text }) => `(Object a table holds).${property}: ${text}`)
		.sort();
}

/** {@link keptInTables} after full collections, looked at until none is left or {@link SETTLE_MS} passed. */
async function titlesKeptInTables(marker: string): Promise<string[]> {
	for (const deadline = Date.now() + SETTLE_MS; ;) {
		for (let round = 0; round < 4; round++) {
			await Bun.sleep(0);
			Bun.gc(true);
		}
		const found = keptInTables(JSON.parse(Bun.generateHeapSnapshot("v8")) as HeapSnapshot, marker);
		if (found.length === 0 || Date.now() >= deadline) return found;
		// A real wait: what lets JSC drop a replaced object is later turns of the event loop.
		await Bun.sleep(100);
	}
}

describe("IndexedSessionStorage keeps no title in its index", () => {
	// If this regresses, every session a process wrote, renamed, appended to or found in a refresh keeps a copy of
	// its title, the title's source and its time in the index for as long as the process lives (a parked subagent's
	// among them), or a reader stops giving the title the store holds.
	it(
		"holds no title in an index entry after queued, awaited and atomic full writes, a title update, an append and a refresh, while every reader gives the stored title",
		async () => {
			await using cleanup = new AsyncDisposableStack();
			const client = new SQL("sqlite::memory:");
			cleanup.defer(() => client.end());
			const storage = await SqlSessionStorage.create({ client });
			const marker = `title-marker-${crypto.randomUUID()}`;
			const targets = Array.from({ length: 6 }, (_, index) => sessionFile(`held-${index}`));
			const bodies = targets.map((_, index) =>
				titled({ title: `Own title ${index} ${marker}`, source: "auto", updatedAt: TIMESTAMP }),
			);
			for (const [index, target] of targets.entries()) {
				if (index % 3 === 0) storage.writeTextSync(target, bodies[index]);
				else if (index % 3 === 1) await storage.writeText(target, bodies[index]);
				else await storage.writeTextAtomic(target, bodies[index]);
			}
			await storage.drain();
			const held: Record<string, string[]> = { afterFullWrites: await titlesKeptInTables(marker) };

			await storage.updateSessionTitle(targets[0], {
				title: `Renamed ${marker}`,
				source: "user",
				updatedAt: "2026-11-27T00:00:07.000Z",
			});
			held.afterTitleUpdate = await titlesKeptInTables(marker);

			const line = `${JSON.stringify({ type: "custom", customType: "note", id: "n1", parentId: "m2" })}\n`;
			const writer = storage.openWriter(targets[1]);
			cleanup.defer(() => writer.close());
			await writer.append(line);
			await writer.close();
			await storage.drain();
			held.afterAppend = await titlesKeptInTables(marker);

			await storage.refresh();
			held.afterRefresh = await titlesKeptInTables(marker);

			const titles: Array<string | undefined> = [];
			for (const target of targets) titles.push(parseTitleSlotFromContent(await storage.readText(target))?.title);
			expect({
				held,
				titles,
				sizes: targets.map(target => storage.statSync(target).size),
			}).toEqual({
				held: { afterFullWrites: [], afterTitleUpdate: [], afterAppend: [], afterRefresh: [] },
				titles: targets.map((_, index) => (index === 0 ? `Renamed ${marker}` : `Own title ${index} ${marker}`)),
				sizes: bodies.map((body, index) => Buffer.byteLength(index === 1 ? body + line : body)),
			});
		},
		CASE_TIMEOUT,
	);
});
