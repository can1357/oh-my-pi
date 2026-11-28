/**
 * Functional tests for {@link RedisSessionStorage}. Driven by a hand-rolled
 * fake Redis client (`test/helpers/fake-redis.ts`) so the suite runs without a
 * live server. The fake answers each script the storage sends by the marker on
 * its first line (`-- OMP_…`), doing in TypeScript what that script does; the
 * title cases also run through the storage's own scripts on a Redis server
 * when `OMP_TEST_REDIS_URL` names one.
 *
 * The harness mirrors only the surface the storage actually uses; it is *not*
 * a general-purpose mock. Each test exercises one contract:
 *
 * - the metadata index keeps `existsSync`/`statSync`/`listFilesSync`
 *   coherent with `writeText`/`writer.append`;
 * - `drain()` waits for fire-and-forget background writes;
 * - `deleteSessionWithArtifacts` removes both the JSONL key and any sidecar
 *   keys under the artifacts prefix;
 * - `refresh()` re-loads the keyspace, so a peer process's writes become
 *   visible after an explicit re-scan;
 * - every read takes a session's title metadata in the script that reads its
 *   bytes, so another store's rename or clear shows at once, and a move or a
 *   rewrite carries no earlier title onto the next body;
 * - a full write, a title update, a move or a removal whose hash key holds
 *   another type fails before it changes anything;
 * - no title is stored or read for a session that is gone, and a session an
 *   append starts at its path shows none;
 * - title metadata without a time is none.
 *
 * Each case and hook has a timeout of its own (30 s: a few writes, reads and
 * scripts, on the fake or on a server).
 */

import { RedisClient } from "bun";
import { beforeEach, describe, expect, it } from "bun:test";
import {
	RedisSessionStorage,
	type RedisSessionStorageClient,
} from "@oh-my-pi/pi-coding-agent/session/redis-session-storage";
import { type SessionTitleUpdate, serializeTitleSlot } from "@oh-my-pi/pi-coding-agent/session/session-title-slot";
import { createFakeRedis, type FakeRedis } from "../helpers/fake-redis";

const SESSION_HEADER = `${JSON.stringify({ type: "session", id: "s", timestamp: "t1", cwd: "/repo" })}\n`;

/** The first line every reader of `storage` gives `path`: its text, its head slice and its line scan. */
async function headsOf(storage: RedisSessionStorage, path: string): Promise<Record<string, string>> {
	const firstLine = (text: string): string => text.split("\n")[0] ?? "";
	let scanned = "";
	await storage.scanLines(path, line => {
		scanned = line;
		return true;
	});
	return {
		readText: firstLine(await storage.readText(path)),
		readTextSlices: firstLine((await storage.readTextSlices(path, 4096, 0))[0]),
		scanLines: scanned,
	};
}

/** `line` as the first line of every reader {@link headsOf} asks. */
function everywhere(line: string): Record<string, string> {
	return { readText: line, readTextSlices: line, scanLines: line };
}

/** The title slot `update` makes, as a line. */
function slotLine(update: SessionTitleUpdate): string {
	return serializeTitleSlot(update).slice(0, -1);
}

/** A session's header and one entry naming it, so a read shows whose body it got. */
function bodyOf(name: string): string {
	return `${SESSION_HEADER}${JSON.stringify({ type: "custom", customType: "body", data: name })}\n`;
}

describe("RedisSessionStorage", () => {
	let redis: FakeRedis;

	beforeEach(() => {
		redis = createFakeRedis();
	}, 30_000);

	it("indexes writeText metadata and reads content asynchronously", async () => {
		const storage = await RedisSessionStorage.create({ client: redis });
		await storage.writeText("/sessions/p/a.jsonl", "line1\nline2\n");

		expect(storage.existsSync("/sessions/p/a.jsonl")).toBe(true);
		expect(await storage.readText("/sessions/p/a.jsonl")).toBe("line1\nline2\n");
		expect(redis.strings.get("omp:sessions:file:/sessions/p/a.jsonl")).toBe("line1\nline2\n");

		const stat = storage.statSync("/sessions/p/a.jsonl");
		expect(stat.size).toBe(12);
		expect(typeof stat.mtimeMs).toBe("number");
	}, 30_000);

	it("commits file content and metadata through one atomic Redis script", async () => {
		const storage = await RedisSessionStorage.create({ client: redis });
		const sessionPath = "/sessions/p/atomic.jsonl";
		await storage.writeText(sessionPath, "old\n");
		const oldMtime = redis.hashes.get("omp:sessions:meta")?.get(sessionPath);
		redis.failNext("send", new Error("EVAL transport failed"));

		await expect(storage.writeTextAtomic(sessionPath, "new\n")).rejects.toThrow("EVAL transport failed");

		expect(redis.strings.get(`omp:sessions:file:${sessionPath}`)).toBe("old\n");
		expect(redis.hashes.get("omp:sessions:meta")?.get(sessionPath)).toBe(oldMtime);
		expect(storage.statSync(sessionPath).size).toBe(4);
		expect(redis.calls.some(call => call.method === "send" && call.args[0] === "EVAL")).toBe(true);
	}, 30_000);

	it("create() warms the metadata index with STRLEN and never reads full content", async () => {
		redis.strings.set("omp:sessions:file:/sessions/p/huge.jsonl", "0123456789");
		redis.hashes.set("omp:sessions:meta", new Map([["/sessions/p/huge.jsonl", String(Date.now())]]));

		const storage = await RedisSessionStorage.create({ client: redis });
		expect(storage.statSync("/sessions/p/huge.jsonl").size).toBe(10);
		// Every content read is a script (`send`), as `get` was before.
		expect(redis.calls.some(call => call.method === "get" || call.method === "send")).toBe(false);
		expect(redis.calls.some(call => call.method === "strlen")).toBe(true);
	}, 30_000);

	it("persists title updates as indexed fields across storage reloads", async () => {
		const storage = await RedisSessionStorage.create({ client: redis });
		const sessionPath = "/sessions/p/titled.jsonl";
		const header = `${JSON.stringify({ type: "session", id: "s", timestamp: "t1", cwd: "/repo" })}\n`;
		await storage.writeText(
			sessionPath,
			`${serializeTitleSlot({ title: "Old", source: "auto", updatedAt: "t1" })}${header}`,
		);

		await storage.updateSessionTitle(sessionPath, { title: "New", source: "user", updatedAt: "t2" });

		expect(JSON.parse((await storage.readText(sessionPath)).split("\n")[0])).toMatchObject({
			type: "title",
			title: "New",
			source: "user",
			updatedAt: "t2",
		});
		expect(JSON.parse((await storage.readTextSlices(sessionPath, 256, 0))[0].split("\n")[0])).toMatchObject({
			type: "title",
			title: "New",
			source: "user",
			updatedAt: "t2",
		});

		const reloaded = await RedisSessionStorage.create({ client: redis });
		expect(JSON.parse((await reloaded.readText(sessionPath)).split("\n")[0])).toMatchObject({
			type: "title",
			title: "New",
			source: "user",
			updatedAt: "t2",
		});
		expect(JSON.parse((await reloaded.readTextSlices(sessionPath, 256, 0))[0].split("\n")[0])).toMatchObject({
			type: "title",
			title: "New",
			source: "user",
			updatedAt: "t2",
		});
	}, 30_000);

	it("listFilesSync returns only direct children matching the glob", async () => {
		const storage = await RedisSessionStorage.create({ client: redis });
		await storage.writeText("/dir/a.jsonl", "x");
		await storage.writeText("/dir/b.jsonl", "y");
		await storage.writeText("/dir/sub/c.jsonl", "z"); // nested — not a direct child
		await storage.writeText("/dir/note.bak", "skip");

		const jsonl = storage.listFilesSync("/dir", "*.jsonl").sort();
		expect(jsonl).toEqual(["/dir/a.jsonl", "/dir/b.jsonl"]);

		const bak = storage.listFilesSync("/dir", "*.bak");
		expect(bak).toEqual(["/dir/note.bak"]);
	}, 30_000);

	it("statSync mtimes are strictly monotonic across rapid writes", async () => {
		const storage = await RedisSessionStorage.create({ client: redis });
		await storage.writeText("/s/a", "1");
		await storage.writeText("/s/b", "2");
		await storage.writeText("/s/c", "3");

		const a = storage.statSync("/s/a").mtimeMs;
		const b = storage.statSync("/s/b").mtimeMs;
		const c = storage.statSync("/s/c").mtimeMs;
		expect(b).toBeGreaterThan(a);
		expect(c).toBeGreaterThan(b);
	}, 30_000);

	it("writer.append appends to Redis after drain", async () => {
		const storage = await RedisSessionStorage.create({ client: redis });
		const writer = storage.openWriter("/sessions/p/session.jsonl");
		await writer.append('{"type":"session"}\n');
		await writer.append('{"type":"message"}\n');

		// Reads await queued appends and fetch content from Redis.
		expect(await storage.readText("/sessions/p/session.jsonl")).toBe('{"type":"session"}\n{"type":"message"}\n');

		// Redis has not necessarily caught up yet — drain to force.
		await storage.drain();
		expect(redis.strings.get("omp:sessions:file:/sessions/p/session.jsonl")).toBe(
			'{"type":"session"}\n{"type":"message"}\n',
		);

		await writer.close();
	}, 30_000);

	it("flags='w' truncates both index metadata and Redis", async () => {
		const storage = await RedisSessionStorage.create({ client: redis });
		await storage.writeText("/sessions/p/keep.jsonl", "old content\n");

		const writer = storage.openWriter("/sessions/p/keep.jsonl", { flags: "w" });
		await writer.append("fresh\n");
		await writer.close();

		expect(await storage.readText("/sessions/p/keep.jsonl")).toBe("fresh\n");
		expect(redis.strings.get("omp:sessions:file:/sessions/p/keep.jsonl")).toBe("fresh\n");
	}, 30_000);

	it("drain() surfaces writer errors so background failures are observable", async () => {
		const storage = await RedisSessionStorage.create({ client: redis });
		const writer = storage.openWriter("/sessions/p/fail.jsonl");
		redis.failNext("append", new Error("redis exploded"));
		void writer.append("doomed\n").catch(() => {});

		await expect(storage.drain()).rejects.toThrow("redis exploded");
		expect(writer.getError()?.message).toBe("redis exploded");
	}, 30_000);

	it("deleteSessionWithArtifacts removes JSONL plus any sidecar keys", async () => {
		const storage = await RedisSessionStorage.create({ client: redis });
		await storage.writeText("/sessions/p/s1.jsonl", "session\n");
		await storage.writeText("/sessions/p/s1/draft.txt", "draft body");
		await storage.writeText("/sessions/p/s1/sub/notes", "more");
		await storage.writeText("/sessions/p/other.jsonl", "untouched\n");

		await storage.deleteSessionWithArtifacts("/sessions/p/s1.jsonl");

		expect(storage.existsSync("/sessions/p/s1.jsonl")).toBe(false);
		expect(storage.existsSync("/sessions/p/s1/draft.txt")).toBe(false);
		expect(storage.existsSync("/sessions/p/s1/sub/notes")).toBe(false);
		expect(storage.existsSync("/sessions/p/other.jsonl")).toBe(true);
		expect(redis.strings.has("omp:sessions:file:/sessions/p/s1.jsonl")).toBe(false);
		expect(redis.strings.has("omp:sessions:file:/sessions/p/s1/draft.txt")).toBe(false);
		expect(redis.strings.has("omp:sessions:file:/sessions/p/other.jsonl")).toBe(true);
	}, 30_000);

	it("rename moves content and meta atomically inside the index", async () => {
		const storage = await RedisSessionStorage.create({ client: redis });
		await storage.writeText("/sessions/p/orig.jsonl", "payload\n");
		const originalMtime = storage.statSync("/sessions/p/orig.jsonl").mtimeMs;

		await storage.rename("/sessions/p/orig.jsonl", "/sessions/p/renamed.jsonl");
		expect(storage.existsSync("/sessions/p/orig.jsonl")).toBe(false);
		expect(await storage.readText("/sessions/p/renamed.jsonl")).toBe("payload\n");
		expect(storage.statSync("/sessions/p/renamed.jsonl").mtimeMs).toBe(originalMtime);
		expect(redis.strings.get("omp:sessions:file:/sessions/p/renamed.jsonl")).toBe("payload\n");
		expect(redis.strings.has("omp:sessions:file:/sessions/p/orig.jsonl")).toBe(false);
	}, 30_000);

	it("rename rolls back the index when Redis RENAME fails", async () => {
		const storage = await RedisSessionStorage.create({ client: redis });
		await storage.writeText("/sessions/p/a.jsonl", "keep\n");
		redis.failNext("rename", new Error("ERR redis rejected rename"));

		await expect(storage.rename("/sessions/p/a.jsonl", "/sessions/p/b.jsonl")).rejects.toThrow(
			"ERR redis rejected rename",
		);

		expect(storage.existsSync("/sessions/p/a.jsonl")).toBe(true);
		expect(storage.existsSync("/sessions/p/b.jsonl")).toBe(false);
	}, 30_000);

	it("refresh() reloads the metadata index from Redis after out-of-band writes", async () => {
		const storage = await RedisSessionStorage.create({ client: redis });
		// Simulate a peer process writing directly to Redis.
		redis.strings.set("omp:sessions:file:/peer/x.jsonl", "from peer\n");
		const peerHash = redis.hashes.get("omp:sessions:meta") ?? new Map<string, string>();
		peerHash.set("/peer/x.jsonl", String(Date.now() + 5_000));
		redis.hashes.set("omp:sessions:meta", peerHash);

		expect(storage.existsSync("/peer/x.jsonl")).toBe(false);
		await storage.refresh();
		expect(storage.existsSync("/peer/x.jsonl")).toBe(true);
		expect(await storage.readText("/peer/x.jsonl")).toBe("from peer\n");
	}, 30_000);

	it("readTextSlices returns byte windows from the head and tail", async () => {
		const storage = await RedisSessionStorage.create({ client: redis });
		await storage.writeText("/sessions/p/big.jsonl", "abcdefghij");

		expect((await storage.readTextSlices("/sessions/p/big.jsonl", 4, 0))[0]).toBe("abcd");
		expect((await storage.readTextSlices("/sessions/p/big.jsonl", 100, 0))[0]).toBe("abcdefghij");
		expect((await storage.readTextSlices("/sessions/p/big.jsonl", 0, 0))[0]).toBe("");
		expect((await storage.readTextSlices("/sessions/p/big.jsonl", 0, 3))[1]).toBe("hij");
		expect((await storage.readTextSlices("/sessions/p/big.jsonl", 0, 100))[1]).toBe("abcdefghij");
		expect(await storage.readTextSlices("/sessions/p/big.jsonl", 4, 3)).toEqual(["abcd", "hij"]);
	}, 30_000);

	// If this regresses, a title update the server never stored shows on this store (or its time does) until a
	// refresh, or a later update after a failed one is lost on another store.
	it("keeps the durable title and time on this store and another when a title write fails before it runs, and a later one wins", async () => {
		const storage = await RedisSessionStorage.create({ client: redis });
		const peer = await RedisSessionStorage.create({ client: redis });
		const path = "/s/failed-title.jsonl";
		const durable: SessionTitleUpdate = { title: "Durable", source: "auto", updatedAt: "t1" };
		await storage.writeText(path, `${serializeTitleSlot(durable)}${SESSION_HEADER}`);
		await peer.refresh();
		const before = storage.statSync(path).mtimeMs;

		// The title script's writes; the fake fails the script before it changes anything.
		redis.failNext("hset", new Error("title write refused before it ran"));
		await expect(
			storage.updateSessionTitle(path, { title: "Lost", source: "user", updatedAt: "t2" }),
		).rejects.toThrow("title write refused before it ran");
		const afterFailure = {
			local: await headsOf(storage, path),
			peer: await headsOf(peer, path),
			time: storage.statSync(path).mtimeMs,
		};
		const later: SessionTitleUpdate = { title: "Later", source: "user", updatedAt: "t3" };
		await storage.updateSessionTitle(path, later);
		expect({
			afterFailure,
			afterLater: { local: await headsOf(storage, path), peer: await headsOf(peer, path) },
		}).toEqual({
			afterFailure: { local: everywhere(slotLine(durable)), peer: everywhere(slotLine(durable)), time: before },
			afterLater: { local: everywhere(slotLine(later)), peer: everywhere(slotLine(later)) },
		});
	}, 30_000);

	it("custom prefix isolates keyspaces", async () => {
		const storage = await RedisSessionStorage.create({ client: redis, prefix: "proj-a:" });
		await storage.writeText("/sessions/x.jsonl", "hello\n");
		expect(redis.strings.has("proj-a:file:/sessions/x.jsonl")).toBe(true);
		expect(redis.strings.has("omp:sessions:file:/sessions/x.jsonl")).toBe(false);
	}, 30_000);

	it("unlink on a missing key throws ENOENT", async () => {
		const storage = await RedisSessionStorage.create({ client: redis });
		await expect(storage.unlink("/sessions/p/ghost.jsonl")).rejects.toMatchObject({ code: "ENOENT" });
	}, 30_000);
});

/** A Redis a title case runs on: a client of it, and a key prefix of the case's own for its stores. */
interface TitleRedis {
	readonly client: RedisSessionStorageClient;
	readonly prefix: string;
}

/** `client`, with each call it gets recorded in `calls`: a script by its marker line, any other call by its name. */
function recording(client: RedisSessionStorageClient, calls: string[]): RedisSessionStorageClient {
	const record = <T>(name: string, call: () => Promise<T>): Promise<T> => {
		calls.push(name);
		return call();
	};
	return {
		send: (command, args) =>
			record(command === "EVAL" ? (args[0] ?? "").split("\n")[0] : command, () => client.send(command, args)),
		get: key => record("get", () => client.get(key)),
		getrange: (key, start, end) => record("getrange", () => client.getrange(key, start, end)),
		strlen: key => record("strlen", () => client.strlen(key)),
		set: (key, value) => record("set", () => client.set(key, value)),
		append: (key, value) => record("append", () => client.append(key, value)),
		del: (...keys) => record("del", () => client.del(...keys)),
		rename: (src, dst) => record("rename", () => client.rename(src, dst)),
		scan: (cursor, ...args) => record("scan", () => client.scan(cursor, ...args)),
		hset: (key, field, value) => record("hset", () => client.hset(key, field, value)),
		hgetall: key => record("hgetall", () => client.hgetall(key)),
		hdel: (key, ...fields) => record("hdel", () => client.hdel(key, ...fields)),
	};
}

/**
 * The cases of the title a read takes with the bytes and a move takes or leaves, on the Redis `open` gives each case.
 * A case writes the keys of an older build or another client with the client's own `set` and `hset`, and reads them
 * with `get` and `hgetall`.
 */
function titleCases(open: (cleanup: AsyncDisposableStack) => TitleRedis): void {
	// If this regresses, a head read of a long Redis session fetches its whole value, or reads its windows without
	// the title metadata the store holds, showing the title its stored head carries. The red control for a title
	// read from another version than the bytes is the gated rewrite case in indexed-session-index-entry.test.ts.
	it("readTextSlices reads both windows and the title metadata in one script, never the whole value", async () => {
		await using cleanup = new AsyncDisposableStack();
		const { client, prefix } = open(cleanup);
		const calls: string[] = [];
		const storage = await RedisSessionStorage.create({ client: recording(client, calls), prefix });
		const path = "/sessions/p/big.jsonl";
		const stored = `${serializeTitleSlot({ title: "Stored title", source: "auto", updatedAt: "t1" })}${bodyOf("big")}`;
		await storage.writeText(path, stored);
		const renamed: SessionTitleUpdate = { title: "Renamed title", source: "user", updatedAt: "t2" };
		await storage.updateSessionTitle(path, renamed);
		const slot = Buffer.from(serializeTitleSlot(renamed), "utf-8");
		const text = Buffer.concat([slot, Buffer.from(stored, "utf-8").subarray(slot.length)]);

		calls.length = 0;
		const slices = await storage.readTextSlices(path, 300, 20);
		expect({ slices, calls }).toEqual({
			slices: [
				text.subarray(0, 300).toString("utf-8"),
				Buffer.from(stored, "utf-8").subarray(-20).toString("utf-8"),
			],
			calls: ["-- OMP_READ_SLICES"],
		});
	}, 30_000);

	// If this regresses, a store that opened a session before another store renamed or cleared its title shows the
	// old title until it refreshes, a key an older build wrote shows a title it never had, a cleared title shows
	// the one the stored head carries, or a title hash value the decoder refuses is laid over the head anyway.
	it("reads another store's rename and clear without a refresh, a key without title metadata as stored, and malformed metadata as none", async () => {
		await using cleanup = new AsyncDisposableStack();
		const { client, prefix } = open(cleanup);
		const storage = await RedisSessionStorage.create({ client, prefix });
		const peer = await RedisSessionStorage.create({ client, prefix });
		const path = "/s/peer.jsonl";
		const old: SessionTitleUpdate = { title: "Old", source: "auto", updatedAt: "t1" };
		await storage.writeText(path, `${serializeTitleSlot(old)}${SESSION_HEADER}`);
		await peer.refresh();
		const before = await headsOf(peer, path);
		const renamed: SessionTitleUpdate = { title: "New", source: "user", updatedAt: "t2" };
		await storage.updateSessionTitle(path, renamed);
		const afterRename = await headsOf(peer, path);
		const cleared: SessionTitleUpdate = { title: "", source: "user", updatedAt: "t3" };
		await storage.updateSessionTitle(path, cleared);
		const afterClear = await headsOf(peer, path);

		// Keys as a build before title metadata wrote them: a value and an mtime, no title hash entry.
		const put = async (key: string, body: string): Promise<void> => {
			await client.set(`${prefix}file:${key}`, body);
			await client.hset(`${prefix}meta`, key, "1");
		};
		const storedSlot = serializeTitleSlot({ title: "Stored", source: "auto", updatedAt: "t0" });
		await put("/s/stored-slot.jsonl", `${storedSlot}${SESSION_HEADER}`);
		await put("/s/legacy.jsonl", SESSION_HEADER);
		await put("/s/malformed.jsonl", `${storedSlot}${SESSION_HEADER}`);
		await client.hset(`${prefix}title`, "/s/malformed.jsonl", '{"title":"Not decoded"');
		await peer.refresh();
		expect({
			before,
			afterRename,
			afterClear,
			storedSlot: await headsOf(peer, "/s/stored-slot.jsonl"),
			legacy: await peer.readText("/s/legacy.jsonl"),
			legacyHeads: await headsOf(peer, "/s/legacy.jsonl"),
			malformed: await headsOf(peer, "/s/malformed.jsonl"),
		}).toEqual({
			before: everywhere(slotLine(old)),
			afterRename: everywhere(slotLine(renamed)),
			afterClear: everywhere(slotLine(cleared)),
			storedSlot: everywhere(storedSlot.slice(0, -1)),
			legacy: SESSION_HEADER,
			legacyHeads: everywhere(SESSION_HEADER.slice(0, -1)),
			malformed: everywhere(storedSlot.slice(0, -1)),
		});
	}, 30_000);

	// If this regresses, title metadata without a time, which SQL session stores and earlier builds ignore, is laid
	// over the head of a body without a title slot: every reader gives up to its first 256 bytes as a made-up slot.
	it("reads a legacy body as stored under title metadata without a time, and an empty title with a time as a clear", async () => {
		await using cleanup = new AsyncDisposableStack();
		const { client, prefix } = open(cleanup);
		const reader = await RedisSessionStorage.create({ client, prefix });
		const untimed = "/s/untimed.jsonl";
		const cleared = "/s/cleared.jsonl";
		for (const path of [untimed, cleared]) {
			await client.set(`${prefix}file:${path}`, bodyOf("legacy"));
			await client.hset(`${prefix}meta`, path, "1");
		}
		await client.hset(`${prefix}title`, untimed, JSON.stringify({ title: "Ignored", updatedAt: "" }));
		const clear: SessionTitleUpdate = { title: "", updatedAt: "2026-01-01T00:00:00.000Z" };
		await client.hset(`${prefix}title`, cleared, JSON.stringify(clear));
		await reader.refresh();

		expect({
			untimed: await reader.readText(untimed),
			untimedHeads: await headsOf(reader, untimed),
			clearedHeads: await headsOf(reader, cleared),
		}).toEqual({
			untimed: bodyOf("legacy"),
			untimedHeads: everywhere(SESSION_HEADER.slice(0, -1)),
			clearedHeads: everywhere(slotLine(clear)),
		});
	}, 30_000);

	// If this regresses, the title of what a path held before shows over what it holds next: after a rewrite with
	// no title slot, after its writer empties it, or on the path a session was moved onto.
	it("carries no earlier title over a rewrite without one, a truncation, or a move onto a titled path", async () => {
		await using cleanup = new AsyncDisposableStack();
		const { client, prefix } = open(cleanup);
		const storage = await RedisSessionStorage.create({ client, prefix });
		const peer = await RedisSessionStorage.create({ client, prefix });
		const titled = `${serializeTitleSlot({ title: "Before", source: "user", updatedAt: "t1" })}${SESSION_HEADER}`;
		for (const path of ["/s/rewritten.jsonl", "/s/truncated.jsonl", "/s/target.jsonl"]) {
			await storage.writeText(path, titled);
			await storage.updateSessionTitle(path, { title: "Renamed before", source: "user", updatedAt: "t2" });
		}
		await storage.writeText("/s/moved.jsonl", SESSION_HEADER);

		await storage.writeText("/s/rewritten.jsonl", SESSION_HEADER);
		const writer = storage.openWriter("/s/truncated.jsonl", { flags: "w" });
		// Closed whatever the append does; a second close does nothing.
		cleanup.defer(() => writer.close());
		await writer.append(SESSION_HEADER);
		await writer.close();
		await storage.rename("/s/moved.jsonl", "/s/target.jsonl");
		await storage.drain();

		await peer.refresh();
		const header = everywhere(SESSION_HEADER.slice(0, -1));
		for (const view of [storage, peer]) {
			expect({
				rewritten: await headsOf(view, "/s/rewritten.jsonl"),
				truncated: await headsOf(view, "/s/truncated.jsonl"),
				target: await headsOf(view, "/s/target.jsonl"),
			}).toEqual({ rewritten: header, truncated: header, target: header });
		}
	}, 30_000);

	// If this regresses, a move drops the title a session was given after its body was written: another store shows
	// the moved session under the title its body was written with, or none, instead of its current one.
	it("carries the title a session was given after its body onto the titled path it moves over, for another store", async () => {
		await using cleanup = new AsyncDisposableStack();
		const { client, prefix } = open(cleanup);
		const storage = await RedisSessionStorage.create({ client, prefix });
		const peer = await RedisSessionStorage.create({ client, prefix });
		const src = "/s/retitled.jsonl";
		const dst = "/s/replaced.jsonl";
		const written = serializeTitleSlot({ title: "Written", source: "auto", updatedAt: "t1" });
		await storage.writeText(src, `${written}${bodyOf("source")}`);
		const updated: SessionTitleUpdate = { title: "Updated", source: "user", updatedAt: "t2" };
		await storage.updateSessionTitle(src, updated);
		const destination = serializeTitleSlot({ title: "Destination", source: "user", updatedAt: "t3" });
		await storage.writeText(dst, `${destination}${bodyOf("destination")}`);
		await peer.refresh();

		await storage.rename(src, dst);
		expect({ text: await peer.readText(dst), heads: await headsOf(peer, dst) }).toEqual({
			text: `${serializeTitleSlot(updated)}${bodyOf("source")}`,
			heads: everywhere(slotLine(updated)),
		});
	}, 30_000);

	// If this regresses, a move whose meta hash key another client replaced with a string runs its RENAME before the
	// script fails on that hash: the session's key sits at the destination with no title, while the store lists the
	// session at its source, where it reads as missing.
	it("fails a move whose meta hash key holds a string before it changes anything", async () => {
		await using cleanup = new AsyncDisposableStack();
		const { client, prefix } = open(cleanup);
		const storage = await RedisSessionStorage.create({ client, prefix });
		const src = "/s/unmoved.jsonl";
		const dst = "/s/never-moved.jsonl";
		const title = JSON.stringify({ title: "Kept", source: "user", updatedAt: "t1" });
		await storage.writeText(src, bodyOf("source"));
		await client.hset(`${prefix}title`, src, title);
		const mtimeMs = storage.statSync(src).mtimeMs;
		// Another client replaces the meta hash, and the mtimes it held, with a string.
		await client.set(`${prefix}meta`, "not a hash");

		await expect(storage.rename(src, dst)).rejects.toThrow(/WRONGTYPE/);
		expect({
			source: await client.get(`${prefix}file:${src}`),
			destination: await client.get(`${prefix}file:${dst}`),
			meta: await client.get(`${prefix}meta`),
			titles: { ...(await client.hgetall(`${prefix}title`)) },
			index: { source: storage.statSync(src).mtimeMs, destination: storage.existsSync(dst) },
		}).toEqual({
			source: bodyOf("source"),
			destination: null,
			meta: "not a hash",
			titles: { [src]: title },
			index: { source: mtimeMs, destination: false },
		});
	}, 30_000);

	// If this regresses, a full write, a title update or a removal whose meta or title hash key another client
	// replaced with a string makes its first writes before the script fails on that hash: Redis keeps them, so the
	// session's body or time changes, or its body goes, while the store's index goes back to what it listed before.
	const wrongTypeCases: ReadonlyArray<{
		operation: string;
		hash: "meta" | "title";
		run: (storage: RedisSessionStorage, path: string) => Promise<void>;
	}> = [
		{ operation: "a full write", hash: "meta", run: (storage, path) => storage.writeText(path, bodyOf("rewritten")) },
		{
			operation: "a full write",
			hash: "title",
			run: (storage, path) => storage.writeText(path, bodyOf("rewritten")),
		},
		{
			operation: "a title update",
			hash: "title",
			run: (storage, path) =>
				storage.updateSessionTitle(path, { title: "Never stored", source: "user", updatedAt: "t2" }),
		},
		{ operation: "a removal", hash: "meta", run: (storage, path) => storage.unlink(path) },
	];
	for (const { operation, hash, run } of wrongTypeCases) {
		const other = hash === "meta" ? "title" : "meta";
		it(`fails ${operation} whose ${hash} hash key holds a string before it changes anything`, async () => {
			await using cleanup = new AsyncDisposableStack();
			const { client, prefix } = open(cleanup);
			const storage = await RedisSessionStorage.create({ client, prefix });
			const path = "/s/unchanged.jsonl";
			await storage.writeText(path, bodyOf("stored"));
			await client.hset(`${prefix}title`, path, JSON.stringify({ title: "Kept", source: "user", updatedAt: "t1" }));
			const kept = { ...(await client.hgetall(`${prefix}${other}`)) };
			const stat = storage.statSync(path);
			// Another client replaces the hash, and the fields it held, with a string.
			await client.set(`${prefix}${hash}`, "not a hash");

			await expect(run(storage, path)).rejects.toThrow(/WRONGTYPE/);
			expect({
				body: await client.get(`${prefix}file:${path}`),
				[hash]: await client.get(`${prefix}${hash}`),
				[other]: { ...(await client.hgetall(`${prefix}${other}`)) },
				index: storage.statSync(path),
			}).toEqual({ body: bodyOf("stored"), [hash]: "not a hash", [other]: kept, index: stat });
		}, 30_000);
	}

	// If this regresses, a store whose index still lists a session another store deleted stores its title update
	// for the missing body: another store's head read shows that title for a session `readText` reports missing,
	// and a session an append starts at the path later shows the deleted session's title over its own head.
	it("refuses a title update for a session another store deleted, and reads the path as gone, then as what an append starts there", async () => {
		await using cleanup = new AsyncDisposableStack();
		const { client, prefix } = open(cleanup);
		const storage = await RedisSessionStorage.create({ client, prefix });
		const stale = await RedisSessionStorage.create({ client, prefix });
		const reader = await RedisSessionStorage.create({ client, prefix });
		const path = "/s/deleted.jsonl";
		const deleted = serializeTitleSlot({ title: "Deleted", source: "user", updatedAt: "t1" });
		await storage.writeText(path, `${deleted}${SESSION_HEADER}`);
		await stale.refresh();
		await reader.refresh();
		await storage.unlink(path);

		const update = await stale.updateSessionTitle(path, { title: "Stale", source: "user", updatedAt: "t2" }).then(
			() => "stored",
			(error: NodeJS.ErrnoException) => error.code,
		);
		const gone = {
			readText: await reader.readText(path).then(
				() => "read",
				(error: NodeJS.ErrnoException) => error.code,
			),
			readTextSlices: await reader.readTextSlices(path, 4096, 0),
		};
		const writer = storage.openWriter(path);
		cleanup.defer(() => writer.close());
		await writer.append(SESSION_HEADER);
		await writer.close();
		expect({ update, gone, recreated: await headsOf(reader, path) }).toEqual({
			update: "ENOENT",
			gone: { readText: "ENOENT", readTextSlices: ["", ""] },
			recreated: everywhere(SESSION_HEADER.slice(0, -1)),
		});
	}, 30_000);

	// If this regresses, title metadata a path holds for no body (an older build's title update after another store
	// deleted the session there) shows: a head read gives it for the missing session, and a session an append
	// starts at the path shows it over its own head.
	it("shows no title stored for a missing body, on the missing session or on one an append starts at its path", async () => {
		await using cleanup = new AsyncDisposableStack();
		const { client, prefix } = open(cleanup);
		const storage = await RedisSessionStorage.create({ client, prefix });
		const reader = await RedisSessionStorage.create({ client, prefix });
		const path = "/s/orphaned.jsonl";
		await storage.writeText(path, SESSION_HEADER);
		await reader.refresh();
		await storage.unlink(path);
		// What an older build's title update stores for a path whose session is gone.
		await client.hset(`${prefix}title`, path, JSON.stringify({ title: "Orphaned", source: "user", updatedAt: "t2" }));

		const gone = await reader.readTextSlices(path, 4096, 0);
		const writer = storage.openWriter(path);
		cleanup.defer(() => writer.close());
		await writer.append(SESSION_HEADER);
		await writer.close();
		expect({ gone, recreated: await headsOf(reader, path) }).toEqual({
			gone: ["", ""],
			recreated: everywhere(SESSION_HEADER.slice(0, -1)),
		});
	}, 30_000);
}

/**
 * A key prefix of the case's own on `url`'s server, and a client of it. `cleanup` closes the client, then deletes the
 * prefix's keys on a client of its own.
 */
function serverRedis(url: string, cleanup: AsyncDisposableStack): TitleRedis {
	const prefix = `omp-test:redis-title:${crypto.randomUUID()}:`;
	// Registered before the client, so it runs after the client closes.
	cleanup.defer(async () => {
		const cleaner = new RedisClient(url);
		try {
			const keys = (await cleaner.send("KEYS", [`${prefix}*`])) as string[];
			if (keys.length > 0) await cleaner.send("DEL", keys);
		} finally {
			cleaner.close();
		}
	});
	const client = new RedisClient(url);
	cleanup.defer(() => client.close());
	return { client, prefix };
}

const REDIS_URL = process.env.OMP_TEST_REDIS_URL;

describe("RedisSessionStorage reads a session's title with its bytes (fake)", () => {
	titleCases(() => ({ client: createFakeRedis(), prefix: "omp:sessions:" }));
});

describe.skipIf(!REDIS_URL)("RedisSessionStorage reads a session's title with its bytes (Redis server)", () => {
	titleCases(cleanup => serverRedis(REDIS_URL ?? "", cleanup));
});
