/**
 * A PostgreSQL store whose session the server ends (`pg_terminate_backend()`,
 * SQLSTATE 57P01) while a statement of the store is on its way. Each test puts
 * a TCP forwarder between the store's client and the server. At the statement
 * the test picks, the forwarder keeps the client's bytes from the server, has
 * the server end every session of the store's client, and then passes on what
 * the servers sent: the client has sent the statement, the server never ran
 * it, and the client reads the server's 57P01 as its answer, on every run.
 * The servers' ends reach the client in one synchronous write, the kept
 * statement's connection first, so the client reads them all in one turn of
 * its event loop, in that order.
 *
 * Runs when `OMP_TEST_SQL_POSTGRES_URL` names a throwaway PostgreSQL database.
 */
import { SQL } from "bun";
import { afterEach, describe, expect, it } from "bun:test";
import * as net from "node:net";
import { SqlSessionStorage } from "@oh-my-pi/pi-coding-agent/session/sql-session-storage";

const POSTGRES_URL = process.env.OMP_TEST_SQL_POSTGRES_URL;
const SESSION = "/sessions/project/session.jsonl";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

interface Forwarder {
	/** The server's URL through the forwarder, naming the store's connections by `application_name`. */
	url: string;
	/**
	 * End the server's session at the next `times` chunks `match` accepts: the
	 * chunk is kept from the server, every later chunk of that connection too.
	 */
	endAt(match: (chunk: Buffer) => boolean, times: number): void;
	/** How many sessions the forwarder had the server end. */
	ended(): number;
	/**
	 * How many chunks the client sent since {@link endAt} that `seen` accepts, kept or passed on; with
	 * `onConnectionsFrom`, only on the connections opened after that many.
	 */
	count(seen: (chunk: Buffer) => boolean, onConnectionsFrom?: number): number;
	/** How many connections the client opened through the forwarder. */
	opened(): number;
}

/** One client connection through the forwarder, and what its server sent while the forwarder held it back. */
interface Connection {
	client: net.Socket;
	held: Array<Buffer | "end">;
	serverClosed: Promise<void>;
}

async function forwarder(admin: SQL): Promise<Forwarder> {
	const target = new URL(POSTGRES_URL!);
	const applicationName = `omp-terminated-${crypto.randomUUID()}`;
	/** What the client sent since {@link Forwarder.endAt}, each chunk with the index of its connection. */
	const chunks: Array<{ connection: number; chunk: Buffer }> = [];
	let rule: { match: (chunk: Buffer) => boolean; times: number } | undefined;
	let ended = 0;
	const live = new Set<net.Socket>();
	const connections: Connection[] = [];
	/** The connections whose servers' bytes are held back until every one of those servers has closed. */
	let holding: Connection[] | undefined;
	const listener = net.createServer(client => {
		const server = net.connect(Number(target.port || 5432), target.hostname);
		const closed = Promise.withResolvers<void>();
		const connection: Connection = { client, held: [], serverClosed: closed.promise };
		const index = connections.push(connection) - 1;
		let kept = false;
		for (const end of [client, server]) {
			live.add(end);
			end.on("error", () => {});
			end.on("close", () => live.delete(end));
		}
		server.on("close", () => closed.resolve());
		// Everything the server sends reaches the client in order, its 57P01 included, and its end ends the client's side.
		server.on("data", (data: Buffer) => {
			if (holding?.includes(connection)) connection.held.push(data);
			else client.write(data);
		});
		server.on("end", () => {
			if (holding?.includes(connection)) connection.held.push("end");
			else client.end();
		});
		client.on("close", () => server.destroy());
		client.on("data", (chunk: Buffer) => {
			chunks.push({ connection: index, chunk });
			if (kept) return;
			if (rule && rule.times > 0 && rule.match(chunk)) {
				rule.times--;
				kept = true;
				ended++;
				// The statement never reaches the server; the server ends every session of the client, this one
				// waiting for it. A query runs once awaited; if the server cannot end the sessions, the client's
				// side closes instead.
				const ending = [connection, ...connections.filter(other => other !== connection)];
				holding = ending;
				admin
					.unsafe(
						"SELECT pg_catalog.pg_terminate_backend(pid, 10000) FROM pg_catalog.pg_stat_activity WHERE application_name = $1",
						[applicationName],
					)
					.then(() => Promise.all(ending.map(each => each.serverClosed)))
					.then(
						() => {
							holding = undefined;
							for (const each of ending) {
								for (const data of each.held.splice(0)) {
									if (data === "end") each.client.end();
									else each.client.write(data);
								}
							}
						},
						() => client.destroy(),
					);
				return;
			}
			server.write(chunk);
		});
	});
	const listening = Promise.withResolvers<void>();
	listener.listen(0, "127.0.0.1", () => listening.resolve());
	await listening.promise;
	cleanups.push(async () => {
		for (const end of live) end.destroy();
		const closed = Promise.withResolvers<void>();
		listener.close(() => closed.resolve());
		await closed.promise;
	});
	const url = new URL(POSTGRES_URL!);
	url.hostname = "127.0.0.1";
	url.port = String((listener.address() as net.AddressInfo).port);
	url.searchParams.set("application_name", applicationName);
	return {
		url: url.href,
		endAt(match, times) {
			rule = { match, times };
			chunks.length = 0;
		},
		ended: () => ended,
		count: (seen, onConnectionsFrom = 0) =>
			chunks.filter(sent => sent.connection >= onConnectionsFrom && seen(sent.chunk)).length,
		opened: () => connections.length,
	};
}

/**
 * A store on its own table, through a forwarder, on a pool of `pool`
 * connections, holding `head` at {@link SESSION}. `addedParts` counts the
 * rows appends added to that session since; `storedParts` reads them all.
 */
async function storeBehindForwarder(
	head: string,
	pool = 1,
): Promise<{
	storage: SqlSessionStorage;
	client: SQL;
	forwarder: Forwarder;
	addedParts(): Promise<number>;
	storedParts(): Promise<string[]>;
}> {
	const admin = new SQL(POSTGRES_URL!);
	const table = `omp_term_${process.pid}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
	cleanups.push(async () => {
		await admin.unsafe(`DROP TABLE IF EXISTS ${table}_parts`);
		await admin.unsafe(`DROP TABLE IF EXISTS ${table}`);
		await admin.end();
	});
	const fwd = await forwarder(admin);
	const client = new SQL(fwd.url, { max: pool });
	cleanups.push(() => client.end());
	const storage = await SqlSessionStorage.create({ client, table, adapter: "postgres" });
	await storage.writeText(SESSION, head);
	await storage.drain();
	const countParts = async () => {
		const [row] = (await admin.unsafe(`SELECT count(*)::int AS n FROM ${table}_parts WHERE path = $1`, [
			SESSION,
		])) as Array<{ n: number }>;
		return row!.n;
	};
	const before = await countParts();
	return {
		storage,
		client,
		forwarder: fwd,
		addedParts: async () => (await countParts()) - before,
		async storedParts() {
			const rows = (await admin.unsafe(`SELECT content FROM ${table}_parts WHERE path = $1 ORDER BY start_offset`, [
				SESSION,
			])) as Array<{ content: string }>;
			return rows.map(row => row.content);
		},
	};
}

/** A PostgreSQL error's SQLSTATE, or any other error's message. */
function failure(err: unknown): { errno: unknown } {
	if (err instanceof SQL.PostgresError) return { errno: err.errno };
	return { errno: err instanceof Error ? err.message : String(err) };
}

/** Writes `content` over {@link SESSION}, and returns how the write ended. */
async function write(storage: SqlSessionStorage, content: string): Promise<{ ok: true } | { errno: unknown }> {
	try {
		await storage.writeText(SESSION, content);
		await storage.drain();
		return { ok: true };
	} catch (err) {
		return failure(err);
	}
}

/** Appends `line` to {@link SESSION} through a writer, and returns how the append ended. */
async function append(storage: SqlSessionStorage, line: string): Promise<{ ok: true } | { errno: unknown }> {
	const writer = storage.openWriter(SESSION, { flags: "a" });
	try {
		await writer.append(line);
		await writer.flush();
		return { ok: true };
	} catch (err) {
		return failure(err);
	} finally {
		await writer.close().catch(() => {});
	}
}

const isBegin = (chunk: Buffer) => chunk.includes("BEGIN");
const isCommit = (chunk: Buffer) => chunk.includes("COMMIT");

describe.skipIf(!POSTGRES_URL)("SQL session storage on a PostgreSQL session the server ends", () => {
	it("runs a write the server ended before COMMIT once more, on a new connection, and it lands once", async () => {
		const { storage, forwarder, addedParts } = await storeBehindForwarder("head\n");
		forwarder.endAt(isBegin, 1);

		const appended = await append(storage, "line\n");

		expect({
			appended,
			ended: forwarder.ended(),
			begins: forwarder.count(isBegin),
			text: await storage.readText(SESSION),
			parts: await addedParts(),
		}).toEqual({ appended: { ok: true }, ended: 1, begins: 2, text: "head\nline\n", parts: 1 });
	});

	// A whole write runs the row's upsert, then the parts' DELETE, then the parts' INSERT, the only statement that
	// carries the content: keeping that INSERT ends the session after the upsert and the DELETE ran on the server.
	const isRewriteInsert = (chunk: Buffer) => chunk.includes("rewritten");

	it("runs a write the server ended after its earlier statements ran once more, and it lands once", async () => {
		const { storage, forwarder, storedParts } = await storeBehindForwarder("head\n");
		forwarder.endAt(isRewriteInsert, 1);

		const written = await write(storage, "rewritten\n");

		expect({
			written,
			ended: forwarder.ended(),
			begins: forwarder.count(isBegin),
			text: await storage.readText(SESSION),
			parts: await storedParts(),
		}).toEqual({ written: { ok: true }, ended: 1, begins: 2, text: "rewritten\n", parts: ["rewritten\n"] });
	});

	it("rolls back the statements that ran before the server ended the session", async () => {
		const { storage, forwarder, storedParts } = await storeBehindForwarder("head\n");
		// Both tries ran the upsert and the DELETE, and neither committed: the session keeps its one part.
		forwarder.endAt(isRewriteInsert, 2);

		const written = await write(storage, "rewritten\n");

		expect({
			written,
			ended: forwarder.ended(),
			begins: forwarder.count(isBegin),
			parts: await storedParts(),
		}).toEqual({ written: { errno: "57P01" }, ended: 2, begins: 2, parts: ["head\n"] });
	});

	it("runs a write on a pool of two on a new connection, after reading the other connection's end", async () => {
		const { storage, client, forwarder, addedParts } = await storeBehindForwarder("head\n", 2);
		// Two connections in the pool, both idle. The server ends both at the append's BEGIN, and the client reads
		// both ends in one turn: the BEGIN's 57P01 first, then the other connection's. Run at once, the write would
		// go on that other connection before the client read its end.
		await Promise.all([
			client.unsafe("SELECT pg_catalog.pg_sleep(0.05)"),
			client.unsafe("SELECT pg_catalog.pg_sleep(0.05)"),
		]);
		const opened = forwarder.opened();
		forwarder.endAt(isBegin, 1);

		const appended = await append(storage, "line\n");

		expect({
			opened,
			appended,
			ended: forwarder.ended(),
			begins: forwarder.count(isBegin),
			beginsOnNewConnections: forwarder.count(isBegin, opened),
			text: await storage.readText(SESSION),
			parts: await addedParts(),
		}).toEqual({
			opened: 2,
			appended: { ok: true },
			ended: 1,
			begins: 2,
			beginsOnNewConnections: 1,
			text: "head\nline\n",
			parts: 1,
		});
	});

	it("gives the caller a second 57P01 in a row, without a third try", async () => {
		const { storage, forwarder, addedParts } = await storeBehindForwarder("head\n");
		forwarder.endAt(isBegin, 2);

		const appended = await append(storage, "line\n");

		expect({
			appended,
			ended: forwarder.ended(),
			begins: forwarder.count(isBegin),
			text: await storage.readText(SESSION),
			parts: await addedParts(),
		}).toEqual({ appended: { errno: "57P01" }, ended: 2, begins: 2, text: "head\n", parts: 0 });
	});

	it("gives the caller a 57P01 at COMMIT, and does not run the write again", async () => {
		const { storage, forwarder, addedParts } = await storeBehindForwarder("head\n");
		forwarder.endAt(isCommit, 1);

		const appended = await append(storage, "line\n");

		// The server ended the session before it read the COMMIT, so nothing committed; the store cannot tell
		// that from a 57P01 at COMMIT, and leaves the write to its caller.
		expect({
			appended,
			ended: forwarder.ended(),
			begins: forwarder.count(isBegin),
			text: await storage.readText(SESSION),
			parts: await addedParts(),
		}).toEqual({ appended: { errno: "57P01" }, ended: 1, begins: 1, text: "head\n", parts: 0 });
	});

	const isReadFull = (chunk: Buffer) => chunk.includes("SELECT 0 AS kind, 0 AS start_offset, content");

	it("runs a read the server ended once more, on a new connection", async () => {
		const { storage, forwarder } = await storeBehindForwarder("head\nline\n");
		forwarder.endAt(isReadFull, 1);

		const text = await storage.readText(SESSION).catch(failure);

		expect({ text, ended: forwarder.ended(), reads: forwarder.count(isReadFull) }).toEqual({
			text: "head\nline\n",
			ended: 1,
			reads: 2,
		});
	});

	it("runs a read on a pool of two on a new connection, after reading the other connection's end", async () => {
		const { storage, client, forwarder } = await storeBehindForwarder("head\nline\n", 2);
		await Promise.all([
			client.unsafe("SELECT pg_catalog.pg_sleep(0.05)"),
			client.unsafe("SELECT pg_catalog.pg_sleep(0.05)"),
		]);
		const opened = forwarder.opened();
		forwarder.endAt(isReadFull, 1);

		const text = await storage.readText(SESSION).catch(failure);

		expect({
			opened,
			text,
			ended: forwarder.ended(),
			reads: forwarder.count(isReadFull),
			readsOnNewConnections: forwarder.count(isReadFull, opened),
		}).toEqual({ opened: 2, text: "head\nline\n", ended: 1, reads: 2, readsOnNewConnections: 1 });
	});
});
