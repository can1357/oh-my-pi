/**
 * Every byte-window read of a session gives, on every backend, the window of
 * the text `readText` gives: the stored bytes with the title slot of the
 * session's title laid over their head. One table of cases runs on each
 * backend and each window read, and each answer it expects comes from one
 * reference, which cuts the text's bytes as every window read cuts them.
 *
 * Where the backends' reads gave different answers to one case before the
 * title moved into the read, each backend keeps its own: those answers are the
 * named exceptions in {@link EXCEPTIONS}, each with its reason. The cases of
 * untitled bodies pass unchanged on the commit before that move.
 *
 * Memory, file and SQLite storage always run, and Redis storage over a fake
 * client; PostgreSQL, MySQL (or MariaDB) and a Redis server when
 * `OMP_TEST_SQL_POSTGRES_URL`, `OMP_TEST_SQL_MYSQL_URL` and
 * `OMP_TEST_REDIS_URL` name one. Each backend's clients, files, table and
 * keys are released after its cases, each release tried whatever the others
 * did, and every case and hook has a timeout of its own.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
	RedisSessionStorage,
	type RedisSessionStorageClient,
} from "@oh-my-pi/pi-coding-agent/session/redis-session-storage";
import {
	FileSessionStorage,
	MemorySessionStorage,
	type SessionStorage,
} from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { type SessionTitleUpdate, serializeTitleSlot } from "@oh-my-pi/pi-coding-agent/session/session-title-slot";
import {
	type SqlSessionStorageAdapter,
	SqlSessionStorage,
} from "@oh-my-pi/pi-coding-agent/session/sql-session-storage";
import { TempDir } from "@oh-my-pi/pi-utils";
import { RedisClient, SQL } from "bun";
import { createFakeRedis } from "../helpers/fake-redis";

const WRITTEN: SessionTitleUpdate = { title: "Written title", source: "auto", updatedAt: "2026-11-27T00:00:01.000Z" };
const RENAMED: SessionTitleUpdate = {
	title: "Renamed title é漢",
	source: "user",
	updatedAt: "2026-11-27T00:00:02.000Z",
};
const CLEARED: SessionTitleUpdate = { title: "", source: "user", updatedAt: "2026-11-27T00:00:03.000Z" };
/** A header and an entry: longer than the title slot, without one. */
const LONG = `${JSON.stringify({ type: "session", version: 3, id: "s", timestamp: "t", cwd: "/p" })}\n${JSON.stringify({ type: "custom", data: "x".repeat(300) })}\n`;

/** A session the table reads: what its writer writes, then the title it is given or the title metadata it loses. */
interface Body {
	readonly id: string;
	readonly name: string;
	readonly written: string;
	readonly retitle?: SessionTitleUpdate;
	/** The store drops the title metadata it keeps beside the bytes, as a store from before that metadata left it. */
	readonly forgetTitle?: true;
}

const BODIES: readonly Body[] = [
	{ id: "short", name: "a short untitled body", written: "abc" },
	{ id: "long", name: "an untitled body longer than the title slot", written: LONG },
	{ id: "titled", name: "a titled body", written: `${serializeTitleSlot(WRITTEN)}${LONG}`, retitle: RENAMED },
	{ id: "short-titled", name: "a body shorter than the title slot, given a title", written: "abc", retitle: RENAMED },
	{
		id: "cleared",
		name: "a body whose title was cleared",
		written: `${serializeTitleSlot(WRITTEN)}${LONG}`,
		retitle: CLEARED,
	},
	{
		id: "legacy",
		name: "a legacy body with a stored title slot and no title metadata",
		written: `${serializeTitleSlot(WRITTEN)}${LONG}`,
		forgetTitle: true,
	},
	{ id: "bom", name: "an untitled body that starts with a UTF-8 byte-order mark", written: "\uFEFFabc" },
	{ id: "multibyte", name: "untitled multi-byte text", written: "aé漢😀z" },
];

/** The text `readText` gives: the stored bytes, with the slot of the title the session was given over their head. */
function textOf(body: Body): Buffer {
	const stored = Buffer.from(body.written, "utf-8");
	if (!body.retitle) return stored;
	const slot = Buffer.from(serializeTitleSlot(body.retitle), "utf-8");
	return Buffer.concat([slot, stored.subarray(slot.length)]);
}

/** How a backend's reads cut and decode a session's bytes, where it differs from the reference's rules. */
interface Rules {
	/** `readText` drops a byte-order mark that starts the text. */
	readonly readTextDropsBom: boolean;
	/** How a slice's bytes become text: as they are, or with a byte-order mark that starts them dropped (always, or unless the slice is the whole text). */
	readonly sliceDecoding:
		| "keeps a byte-order mark"
		| "drops a byte-order mark"
		| "drops a byte-order mark unless whole";
	/** A slice's suffix is cut from the stored bytes, not from the text with its title slot. */
	readonly storedSuffix: boolean;
}

const REFERENCE_RULES: Rules = {
	readTextDropsBom: false,
	sliceDecoding: "keeps a byte-order mark",
	storedSuffix: false,
};

type BackendName = "memory" | "file" | "sqlite" | "postgres" | "mysql" | "redis (fake)" | "redis (server)";
const SQL_BACKENDS: readonly BackendName[] = ["sqlite", "postgres", "mysql"];
const INDEXED_BACKENDS: readonly BackendName[] = [...SQL_BACKENDS, "redis (fake)", "redis (server)"];

/**
 * The answers a backend gives that the reference does not, each what that backend's reads gave before the title
 * moved into the read, kept, with why.
 */
const EXCEPTIONS: ReadonlyArray<{ backends: readonly BackendName[]; rules: Partial<Rules>; reason: string }> = [
	{
		backends: ["file"],
		rules: { readTextDropsBom: true },
		reason: "Bun's file text() drops a byte-order mark that starts the file; its windows still count the mark",
	},
	{
		backends: ["file", ...SQL_BACKENDS],
		rules: { sliceDecoding: "drops a byte-order mark" },
		reason: "slices are decoded with a TextDecoder, which drops a byte-order mark that starts its input",
	},
	{
		backends: ["memory"],
		rules: { sliceDecoding: "drops a byte-order mark unless whole" },
		reason: "a slice shorter than the text is decoded with a TextDecoder; a whole one is the stored string",
	},
	{
		backends: INDEXED_BACKENDS,
		rules: { storedSuffix: true },
		reason:
			"the title slot is laid over the prefix only: the suffix is stored bytes, whose head holds the slot stored",
	},
];

function rulesOf(backend: BackendName): Rules {
	return Object.assign(
		{},
		REFERENCE_RULES,
		...EXCEPTIONS.filter(exception => exception.backends.includes(backend)).map(exception => exception.rules),
	);
}

function decode(bytes: Buffer, dropsBom: boolean): string {
	return dropsBom ? new TextDecoder().decode(bytes) : bytes.toString("utf-8");
}

/** The whole bytes a window of at most `maxBytes` holds: none for a count that is not positive. */
function windowBytes(maxBytes: number): number {
	return maxBytes > 0 ? Math.trunc(maxBytes) : 0;
}

/** The reference `readTextSlices`: the first `prefixBytes` and last `suffixBytes` of the text's bytes. */
function expectedSlices(body: Body, rules: Rules, prefixBytes: number, suffixBytes: number): [string, string] {
	const text = textOf(body);
	const suffixOf = rules.storedSuffix ? Buffer.from(body.written, "utf-8") : text;
	const head = Math.min(windowBytes(prefixBytes), text.length);
	const tail = Math.min(windowBytes(suffixBytes), suffixOf.length);
	const dropsBom = (whole: boolean): boolean =>
		rules.sliceDecoding === "drops a byte-order mark" ||
		(rules.sliceDecoding === "drops a byte-order mark unless whole" && !whole);
	return [
		decode(text.subarray(0, head), dropsBom(head === text.length)),
		decode(suffixOf.subarray(suffixOf.length - tail), dropsBom(tail === suffixOf.length)),
	];
}

/** Byte counts of a slice: negative, zero, small, inside the title slot, at its end, past it, and at or past the end. */
function sliceCounts(size: number): number[] {
	return [...new Set([-3, 0, 1, 2, 5, 100, 255, 256, 300, size - 1, size, size + 100])];
}

/** The `[prefixBytes, suffixBytes]` pairs of a slice: each of {@link sliceCounts} with each. */
function slicePairs(size: number): Array<readonly [number, number]> {
	const counts = sliceCounts(size);
	return counts.flatMap(prefixBytes => counts.map(suffixBytes => [prefixBytes, suffixBytes] as const));
}

/** One store, written by one storage and read by another opened after the writes, as another process reads it. */
interface Store {
	readonly writer: SessionStorage;
	reopen(): Promise<SessionStorage>;
	path(body: Body): string;
	/** Drop the title metadata the store keeps for `path` beside its bytes (none where the title is the stored slot). */
	forgetTitle(path: string): Promise<void>;
}

function sessionPath(body: Body): string {
	return `/sessions/-project-/2026-11-27T00-00-00-000Z_${body.id}.jsonl`;
}

async function memoryStore(): Promise<Store> {
	const storage = new MemorySessionStorage();
	return {
		writer: storage,
		reopen: async () => storage,
		path: sessionPath,
		forgetTitle: async () => {},
	};
}

/** A directory of its own, removed by `cleanup`. */
async function fileStore(cleanup: AsyncDisposableStack): Promise<Store> {
	const dir = await TempDir.create("@omp-byte-windows-");
	cleanup.defer(() => dir.remove());
	return {
		writer: new FileSessionStorage(),
		reopen: async () => new FileSessionStorage(),
		path: body => dir.join(`${body.id}.jsonl`),
		forgetTitle: async () => {},
	};
}

/**
 * A table of its own on `url`'s database (a file of its own for SQLite). `cleanup` ends each client as it is made,
 * then drops the table on a client of its own, then ends that client whether or not the drop failed, then removes
 * the file's directory.
 */
async function sqlStore(adapter: SqlSessionStorageAdapter, url: string, cleanup: AsyncDisposableStack): Promise<Store> {
	const table = `omp_byte_windows_${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`;
	const dir = adapter === "sqlite" ? await TempDir.create("@omp-byte-windows-") : undefined;
	if (dir) cleanup.defer(() => dir.remove());
	const client = (): SQL => (dir ? new SQL({ adapter: "sqlite", filename: dir.join("sessions.db") }) : new SQL(url));
	// Registered before any client the store opens, so they run after those end: the drop, then the dropping
	// client's end (the stack runs them last first). The store makes only `table`.
	let dropper: SQL | undefined;
	cleanup.defer(async () => {
		await dropper?.end();
	});
	cleanup.defer(async () => {
		dropper = client();
		await dropper.unsafe(`DROP TABLE IF EXISTS ${table}`);
	});
	const connect = (): SQL => {
		const opened = client();
		cleanup.defer(() => opened.end());
		return opened;
	};
	const first = connect();
	return {
		writer: await SqlSessionStorage.create({ client: first, table }),
		reopen: () => SqlSessionStorage.create({ client: connect(), table }),
		path: sessionPath,
		async forgetTitle(path) {
			const parameter = adapter === "postgres" ? "$1" : "?";
			await first.unsafe(
				`UPDATE ${table} SET title = NULL, title_source = NULL, title_updated_at = NULL WHERE path = ${parameter}`,
				[path],
			);
		},
	};
}

/**
 * A key prefix of its own on a server (or on the fake). `cleanup` closes each client as it is made, then deletes the
 * prefix's keys on a client of its own.
 */
async function redisStore(url: string | undefined, cleanup: AsyncDisposableStack): Promise<Store> {
	const prefix = `omp-test:byte-windows:${crypto.randomUUID()}:`;
	const fake = url === undefined ? createFakeRedis() : undefined;
	if (url !== undefined) {
		// Registered before any client the store opens, so it runs after they close.
		cleanup.defer(async () => {
			const cleaner = new RedisClient(url);
			try {
				const keys = (await cleaner.send("KEYS", [`${prefix}*`])) as string[];
				if (keys.length > 0) await cleaner.send("DEL", keys);
			} finally {
				cleaner.close();
			}
		});
	}
	const connect = (): RedisSessionStorageClient => {
		if (fake) return fake;
		const client = new RedisClient(url ?? "");
		cleanup.defer(() => client.close());
		return client;
	};
	const first = connect();
	return {
		writer: await RedisSessionStorage.create({ client: first, prefix }),
		reopen: () => RedisSessionStorage.create({ client: connect(), prefix }),
		path: sessionPath,
		async forgetTitle(path) {
			if (fake) await fake.hdel(`${prefix}title`, path);
			else await first.send("HDEL", [`${prefix}title`, path]);
		},
	};
}

const BACKENDS: ReadonlyArray<{
	name: BackendName;
	available: boolean;
	open(cleanup: AsyncDisposableStack): Promise<Store>;
}> = [
	{ name: "memory", available: true, open: memoryStore },
	{ name: "file", available: true, open: fileStore },
	{ name: "sqlite", available: true, open: cleanup => sqlStore("sqlite", "sqlite", cleanup) },
	{
		name: "postgres",
		available: !!process.env.OMP_TEST_SQL_POSTGRES_URL,
		open: cleanup => sqlStore("postgres", process.env.OMP_TEST_SQL_POSTGRES_URL ?? "", cleanup),
	},
	{
		name: "mysql",
		available: !!process.env.OMP_TEST_SQL_MYSQL_URL,
		open: cleanup => sqlStore("mysql", process.env.OMP_TEST_SQL_MYSQL_URL ?? "", cleanup),
	},
	{ name: "redis (fake)", available: true, open: cleanup => redisStore(undefined, cleanup) },
	{
		name: "redis (server)",
		available: !!process.env.OMP_TEST_REDIS_URL,
		open: cleanup => redisStore(process.env.OMP_TEST_REDIS_URL, cleanup),
	},
];

/** A case the read answered otherwise than the reference, with both answers. */
interface Mismatch {
	readonly args: ReadonlyArray<number | undefined>;
	readonly expected: unknown;
	readonly actual: unknown;
}

for (const backend of BACKENDS) {
	describe.skipIf(!backend.available)(`byte windows of a session (${backend.name})`, () => {
		const rules = rulesOf(backend.name);
		// Each resource the backend's store takes, released by `afterAll` whether or not the setup finished.
		const cleanup = new AsyncDisposableStack();
		let store: Store | undefined;
		let reader: SessionStorage;

		beforeAll(async () => {
			const opened = await backend.open(cleanup);
			store = opened;
			for (const body of BODIES) {
				const path = opened.path(body);
				await opened.writer.writeText(path, body.written);
				if (body.retitle) await opened.writer.updateSessionTitle(path, body.retitle);
			}
			await opened.writer.drain();
			for (const body of BODIES) if (body.forgetTitle) await opened.forgetTitle(opened.path(body));
			reader = await opened.reopen();
		}, 60_000);

		afterAll(() => cleanup.disposeAsync(), 60_000);

		for (const body of BODIES) {
			it(`readText of ${body.name}`, async () => {
				const text = textOf(body).toString("utf-8");
				const expected = rules.readTextDropsBom && text.startsWith("\uFEFF") ? text.slice(1) : text;
				expect(await reader.readText(store?.path(body) ?? "")).toBe(expected);
			}, 60_000);

			it(`readTextSlices of ${body.name}`, async () => {
				const path = store?.path(body) ?? "";
				const mismatches: Mismatch[] = [];
				for (const [prefixBytes, suffixBytes] of slicePairs(textOf(body).length)) {
					const expected = expectedSlices(body, rules, prefixBytes, suffixBytes);
					const actual = await reader.readTextSlices(path, prefixBytes, suffixBytes);
					if (!Bun.deepEquals(actual, expected))
						mismatches.push({ args: [prefixBytes, suffixBytes], expected, actual });
				}
				expect(mismatches).toEqual([]);
			}, 60_000);
		}
	});
}
