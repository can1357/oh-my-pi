/**
 * `readSessionTextFrom` on {@link SqlSessionStorage}: the text from a byte
 * offset, at most `maxBytes` of it, and the size the read saw. Tails (the Agent
 * Hub viewer, the activity feed, collab transcript pages) call it on every
 * poll, so it must return exactly the bytes a file read returns while fetching
 * only the bytes it returns, not the whole session. Runs against SQLite always,
 * and against PostgreSQL and MySQL when `OMP_TEST_SQL_POSTGRES_URL` /
 * `OMP_TEST_SQL_MYSQL_URL` name a throwaway database.
 */
import { SQL } from "bun";
import { describe, expect, it } from "bun:test";
import {
	FileSessionStorage,
	readSessionTextFrom,
	type SessionStorage,
} from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { serializeTitleSlot } from "@oh-my-pi/pi-coding-agent/session/session-title-slot";
import {
	SqlSessionStorage,
	type SqlSessionStorageAdapter,
	type SqlSessionStorageClient,
	type SqlSessionStorageResult,
} from "@oh-my-pi/pi-coding-agent/session/sql-session-storage";
import { TempDir } from "@oh-my-pi/pi-utils";

type SqlClient = InstanceType<typeof SQL>;

const MiB = 1024 * 1024;

const BACKENDS: ReadonlyArray<{ adapter: SqlSessionStorageAdapter; url: string | undefined }> = [
	{ adapter: "sqlite", url: "sqlite::memory:" },
	{ adapter: "postgres", url: process.env.OMP_TEST_SQL_POSTGRES_URL },
	{ adapter: "mysql", url: process.env.OMP_TEST_SQL_MYSQL_URL },
];

let tableSeq = 0;

/** One test's database: a fresh table name and the cleanup that drops it. */
class Db implements AsyncDisposable {
	readonly table = `omp_read_from_${process.pid}_${Date.now().toString(36)}_${tableSeq++}`;
	readonly client: SqlClient;
	readonly #clients: SqlClient[] = [];

	constructor(
		readonly adapter: SqlSessionStorageAdapter,
		readonly url: string,
	) {
		this.client = new SQL(url);
		this.#clients.push(this.client);
	}

	/** A second client of the same database; SQLite's in-memory database lives only on the first. */
	connect(): SqlClient {
		if (this.adapter === "sqlite") return this.client;
		const client = new SQL(this.url);
		this.#clients.push(client);
		return client;
	}

	open(client: SqlSessionStorageClient = this.client): Promise<SqlSessionStorage> {
		return SqlSessionStorage.create({ client, table: this.table });
	}

	/** Run fixture SQL written with `?` placeholders on any dialect. */
	async sql(query: string, values: unknown[] = []): Promise<void> {
		let n = 0;
		const text = this.adapter === "postgres" ? query.replace(/\?/g, () => `$${++n}`) : query;
		await this.client.unsafe(text, values);
	}

	async [Symbol.asyncDispose](): Promise<void> {
		await this.client.unsafe(`DROP TABLE IF EXISTS ${this.table}_parts`);
		await this.client.unsafe(`DROP TABLE IF EXISTS ${this.table}`);
		for (const client of this.#clients) await client.end();
	}
}

/** Every `[offset, maxBytes]` read must equal what {@link FileSessionStorage} returns for the same bytes on disk. */
async function expectReadsMatchFile(
	storage: SessionStorage,
	path: string,
	content: string,
	reads: ReadonlyArray<readonly [number, number | undefined]>,
): Promise<void> {
	using dir = TempDir.createSync("@omp-sql-read-from-");
	const file = dir.join("session.jsonl");
	await Bun.write(file, content);
	const reference = new FileSessionStorage();
	for (const [offset, maxBytes] of reads) {
		expect({ offset, maxBytes, read: await readSessionTextFrom(storage, path, offset, maxBytes) }).toEqual({
			offset,
			maxBytes,
			read: await readSessionTextFrom(reference, file, offset, maxBytes),
		});
	}
}

/** Reads starting within two bytes either side of each boundary, uncapped and with caps ending around the next one. */
function readsAround(boundaries: readonly number[]): Array<[number, number | undefined]> {
	const reads: Array<[number, number | undefined]> = [];
	for (const at of boundaries) {
		for (const delta of [-2, -1, 0, 1, 2]) {
			for (const maxBytes of [undefined, 0, 1, 3, 4, 7]) reads.push([Math.max(0, at + delta), maxBytes]);
		}
	}
	return reads;
}

for (const { adapter, url } of BACKENDS) {
	describe.skipIf(!url)(`SqlSessionStorage reads from an offset (${adapter})`, () => {
		const connect = (): Db => new Db(adapter, url ?? "");

		it("returns the bytes a file read returns inside parts, across part edges, and past the end", async () => {
			await using db = connect();
			const storage = await db.open();
			const path = "/sessions/p/tail.jsonl";
			// Three-byte characters put the 1 MiB split point mid-character, so the
			// full write's first part ends one byte early; each append is a part.
			const body = "€".repeat(400_000);
			const appends = ["😀a\n", "€b\n", "😀😀\n"];
			await storage.writeText(path, body);
			const writer = storage.openWriter(path);
			for (const line of appends) await writer.append(line);
			await writer.close();

			const content = body + appends.join("");
			const size = Buffer.byteLength(content);
			await expectReadsMatchFile(storage, path, content, [
				[0, undefined],
				[0, 5],
				[0, MiB + 10],
				[size, undefined],
				[size, 4],
				[size + 7, undefined],
				[size - 1, undefined],
				// From inside the first part into the appended parts.
				[MiB - 4, 4_000_000],
				...readsAround([MiB - 1, 1_200_000, 1_200_006, 1_200_011]),
			]);
		});

		it("reads a legacy row's own content and the parts appended after it", async () => {
			await using db = connect();
			const legacyTable =
				adapter === "mysql"
					? `CREATE TABLE ${db.table} (path VARCHAR(512) NOT NULL PRIMARY KEY, content LONGTEXT NOT NULL, ` +
						`mtime_ms BIGINT NOT NULL, title TEXT NULL, title_source VARCHAR(16) NULL, title_updated_at VARCHAR(64) NULL` +
						`) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`
					: `CREATE TABLE ${db.table} (path TEXT PRIMARY KEY, content TEXT NOT NULL, ` +
						`mtime_ms ${adapter === "postgres" ? "BIGINT" : "INTEGER"} NOT NULL, ` +
						`title TEXT, title_source TEXT, title_updated_at TEXT)`;
			await db.sql(legacyTable);
			const path = "/sessions/p/legacy.jsonl";
			const legacyBody = '{"type":"session","id":"g"}\n€€';
			await db.sql(`INSERT INTO ${db.table} (path, content, mtime_ms) VALUES (?, ?, ?)`, [path, legacyBody, 1]);
			const storage = await db.open();
			const writer = storage.openWriter(path);
			await writer.append("😀 one\n");
			await writer.append("€ two\n");
			await writer.close();

			const content = `${legacyBody}😀 one\n€ two\n`;
			const legacyEnd = Buffer.byteLength(legacyBody);
			await expectReadsMatchFile(storage, path, content, [
				[0, undefined],
				[5, 10],
				[5, 100],
				...readsAround([legacyEnd, legacyEnd + 3, legacyEnd + 11, Buffer.byteLength(content)]),
			]);
		});

		it("shows the title the store holds in a read that starts inside the title slot", async () => {
			await using db = connect();
			const storage = await db.open();
			const path = "/sessions/p/titled.jsonl";
			const header = `${JSON.stringify({ type: "session", id: "s", timestamp: "t1", cwd: "/repo" })}\n`;
			await storage.writeText(
				path,
				`${serializeTitleSlot({ title: "Old", source: "auto", updatedAt: "t1" })}${header}`,
			);
			const writer = storage.openWriter(path);
			await writer.append(`${JSON.stringify({ type: "message", id: "m" })}\n`);
			await writer.close();
			await storage.updateSessionTitle(path, { title: "New", source: "user", updatedAt: "t2" });

			for (const view of [storage, await db.open()]) {
				const whole = Buffer.from(await view.readText(path));
				for (const [offset, maxBytes] of [
					[0, undefined],
					[0, 40],
					[20, 30],
					[255, 10],
					[256, undefined],
					[300, 5],
				] as const) {
					const end = maxBytes === undefined ? undefined : offset + maxBytes;
					expect(await readSessionTextFrom(view, path, offset, maxBytes)).toEqual({
						text: whole.subarray(offset, end).toString("utf8"),
						size: whole.byteLength,
					});
				}
				expect((await readSessionTextFrom(view, path, 0, 256)).text).toContain('"title":"New"');
			}
		});

		it("reads what another client appended after this store loaded its index, with the size it read", async () => {
			await using db = connect();
			const storage = await db.open();
			const path = "/sessions/p/shared.jsonl";
			await storage.writeText(path, "first line\n");
			const peer = await db.open(db.connect());
			const peerWriter = peer.openWriter(path);
			await peerWriter.append("peer line\n");
			await peerWriter.close();

			// This store's index still says 11 bytes; the read reports what it read.
			expect(storage.statSync(path).size).toBe(11);
			expect(await readSessionTextFrom(storage, path, 11)).toEqual({ text: "peer line\n", size: 21 });
			expect(await readSessionTextFrom(storage, path, 6, 9)).toEqual({ text: "line\npeer", size: 21 });
		});

		it("rejects a session the store does not hold as missing", async () => {
			await using db = connect();
			const storage = await db.open();
			await expect(readSessionTextFrom(storage, "/sessions/p/none.jsonl", 0)).rejects.toMatchObject({
				code: "ENOENT",
			});
		});
	});
}

/** Wrap a SQLite client so the column bytes every statement returns are counted. */
function countReturnedBytes(client: SqlClient): { client: SqlSessionStorageClient; bytes: () => number } {
	let total = 0;
	const count = (rows: SqlSessionStorageResult): SqlSessionStorageResult => {
		for (const row of rows as Array<Record<string, unknown>>) {
			for (const value of Object.values(row)) {
				if (value instanceof Uint8Array) total += value.byteLength;
				else if (typeof value === "string") total += Buffer.byteLength(value);
			}
		}
		return rows;
	};
	const wrapped: SqlSessionStorageClient = {
		options: client.options,
		unsafe: async (query, values) => count(await client.unsafe(query, values)),
		transaction: callback =>
			client.transaction(async transaction =>
				callback({ unsafe: async (query, values) => count(await transaction.unsafe(query, values)) }),
			),
	};
	return { client: wrapped, bytes: () => total };
}

describe("SqlSessionStorage offset reads fetch only what they return (sqlite)", () => {
	it("fetches a tail's bytes, not the whole session, however long the session is", async () => {
		const sqlite = new SQL("sqlite::memory:");
		try {
			const path = "/sessions/p/long.jsonl";
			const seeded = await SqlSessionStorage.create({ client: sqlite });
			const lines = Array.from({ length: 2_000 }, (_, line) => `{"n":${line},"s":"${"😀".repeat(20)}"}\n`);
			const writer = seeded.openWriter(path);
			for (const line of lines) await writer.append(line);
			await writer.close();
			const lastLine = lines.at(-1)!;
			const content = lines.join("");
			const size = Buffer.byteLength(content);

			const { client, bytes } = countReturnedBytes(sqlite);
			const storage = await SqlSessionStorage.create({ client });
			const before = bytes();
			const tail = await readSessionTextFrom(storage, path, size - Buffer.byteLength(lastLine));
			expect(tail).toEqual({ text: lastLine, size });
			// One appended line and the row's numbers, not the session's ~200 KB.
			expect(bytes() - before).toBeLessThan(2 * Buffer.byteLength(lastLine));

			const afterTail = bytes();
			const page = await readSessionTextFrom(storage, path, 0, 1_000);
			expect(page).toEqual({ text: Buffer.from(content).subarray(0, 1_000).toString("utf8"), size });
			// The capped page plus at most the rest of the part it ends in.
			expect(bytes() - afterTail).toBeLessThan(1_000 + 2 * Buffer.byteLength(lastLine));
		} finally {
			await sqlite.end();
		}
	});
});
