/**
 * Functional tests for {@link RedisSessionStorage}. Driven by a hand-rolled
 * fake Redis client so the suite runs without a live server.
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
 *   visible after an explicit re-scan.
 */

import { RedisClient } from "bun";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	RedisSessionStorage,
	type RedisSessionStorageClient,
} from "@oh-my-pi/pi-coding-agent/session/redis-session-storage";
import { serializeTitleSlot } from "@oh-my-pi/pi-coding-agent/session/session-title-slot";

interface FakeRedisCall {
	method: string;
	args: unknown[];
}

interface FakeRedis extends RedisSessionStorageClient {
	calls: FakeRedisCall[];
	strings: Map<string, string>;
	hashes: Map<string, Map<string, string>>;
	/** Override the next call to `method` to reject with `error`. */
	failNext(method: string, error: Error): void;
}

function createFakeRedis(): FakeRedis {
	const strings = new Map<string, string>();
	const hashes = new Map<string, Map<string, string>>();
	const calls: FakeRedisCall[] = [];
	const failures = new Map<string, Error[]>();

	const checkFailure = (method: string): void => {
		const queue = failures.get(method);
		if (!queue || queue.length === 0) return;
		throw queue.shift() as Error;
	};

	const record = (method: string, args: unknown[]): void => {
		calls.push({ method, args });
	};

	const getHash = (key: string): Map<string, string> => {
		let h = hashes.get(key);
		if (!h) {
			h = new Map();
			hashes.set(key, h);
		}
		return h;
	};

	const client: FakeRedis = {
		calls,
		strings,
		hashes,
		failNext(method: string, error: Error): void {
			const queue = failures.get(method) ?? [];
			queue.push(error);
			failures.set(method, queue);
		},
		async send(command, args) {
			record("send", [command, args]);
			checkFailure("send");
			if (command !== "EVAL") throw new Error(`Unsupported Redis command: ${command}`);
			const script = args[0] ?? "";
			const keyCount = Number(args[1] ?? "0");
			const keys = args.slice(2, 2 + keyCount);
			const argv = args.slice(2 + keyCount);
			if (script.includes("OMP_WRITE_FULL")) {
				checkFailure("set");
				checkFailure("hset");
				const [fileKey, metaKey, titleKey] = keys;
				const [content, filePath, mtimeMs, hasTitle, title] = argv;
				strings.set(fileKey, content);
				getHash(metaKey).set(filePath, mtimeMs);
				if (hasTitle === "1") getHash(titleKey).set(filePath, title);
				else getHash(titleKey).delete(filePath);
				return 1;
			}
			if (script.includes("OMP_APPEND")) {
				checkFailure("append");
				checkFailure("hset");
				const [fileKey, metaKey] = keys;
				const [line, filePath, mtimeMs] = argv;
				const next = (strings.get(fileKey) ?? "") + line;
				strings.set(fileKey, next);
				getHash(metaKey).set(filePath, mtimeMs);
				return Buffer.byteLength(next, "utf-8");
			}
			if (script.includes("OMP_UPDATE_TITLE")) {
				checkFailure("hset");
				const [metaKey, titleKey] = keys;
				const [filePath, mtimeMs, title] = argv;
				getHash(metaKey).set(filePath, mtimeMs);
				getHash(titleKey).set(filePath, title);
				return 1;
			}
			if (script.includes("OMP_MOVE")) {
				// As the script runs on a Redis 7 server: 0 when a no-replace destination exists.
				checkFailure("rename");
				const [srcKey, dstKey, metaKey, titleKey] = keys;
				const [src, dst, mtimeMs, noReplace] = argv;
				if (noReplace === "1" && strings.has(dstKey)) return 0;
				if (!strings.has(srcKey)) throw new Error("ERR no such key");
				strings.set(dstKey, strings.get(srcKey) as string);
				if (srcKey !== dstKey) strings.delete(srcKey);
				getHash(metaKey).delete(src);
				getHash(metaKey).set(dst, mtimeMs);
				const title = getHash(titleKey).get(src);
				getHash(titleKey).delete(src);
				if (title !== undefined) getHash(titleKey).set(dst, title);
				else getHash(titleKey).delete(dst);
				return 1;
			}
			if (script.includes("OMP_REMOVE")) {
				checkFailure("del");
				const [metaKey, titleKey] = keys;
				const [filePrefix, pattern, ...paths] = argv;
				if (pattern) {
					// The pattern is an escaped key prefix followed by `*`.
					const keyPrefix = pattern.slice(0, -1).replace(/\\(.)/g, "$1");
					for (const key of strings.keys()) {
						if (key.startsWith(keyPrefix)) paths.push(key.slice(filePrefix.length));
					}
				}
				for (const filePath of paths) {
					strings.delete(filePrefix + filePath);
					getHash(metaKey).delete(filePath);
					getHash(titleKey).delete(filePath);
				}
				return paths.length;
			}
			throw new Error("Unsupported Redis script");
		},
		async get(key) {
			record("get", [key]);
			checkFailure("get");
			return strings.has(key) ? (strings.get(key) as string) : null;
		},
		async getrange(key, start, end) {
			record("getrange", [key, start, end]);
			checkFailure("getrange");
			const bytes = Buffer.from(strings.get(key) ?? "", "utf-8");
			if (bytes.length === 0) return "";
			const from = Math.max(0, start < 0 ? bytes.length + start : start);
			const to = Math.min(bytes.length - 1, end < 0 ? bytes.length + end : end);
			if (to < from) return "";
			return bytes.subarray(from, to + 1).toString("utf-8");
		},
		async strlen(key) {
			record("strlen", [key]);
			checkFailure("strlen");
			return Buffer.byteLength(strings.get(key) ?? "", "utf-8");
		},
		async set(key, value) {
			record("set", [key, value]);
			checkFailure("set");
			strings.set(key, value);
			return "OK";
		},
		async append(key, value) {
			record("append", [key, value]);
			checkFailure("append");
			const current = strings.get(key) ?? "";
			const next = current + value;
			strings.set(key, next);
			return Buffer.byteLength(next, "utf-8");
		},
		async scan(cursor, ...rest) {
			record("scan", [cursor, ...rest]);
			checkFailure("scan");
			let pattern = "*";
			for (let i = 0; i < rest.length; i++) {
				if (String(rest[i]).toUpperCase() === "MATCH") {
					pattern = String(rest[i + 1] ?? "*");
				}
			}
			const regex = new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`);
			const matches = Array.from(strings.keys()).filter(k => regex.test(k));
			return ["0", matches];
		},
		async hgetall(key) {
			record("hgetall", [key]);
			checkFailure("hgetall");
			const h = hashes.get(key);
			if (!h) return {};
			const out: Record<string, string> = {};
			for (const [k, v] of h) out[k] = v;
			return out;
		},
	};

	return client;
}

describe("RedisSessionStorage", () => {
	let redis: FakeRedis;

	beforeEach(() => {
		redis = createFakeRedis();
	});

	it("indexes writeText metadata and reads content asynchronously", async () => {
		const storage = await RedisSessionStorage.create({ client: redis });
		await storage.writeText("/sessions/p/a.jsonl", "line1\nline2\n");

		expect(storage.existsSync("/sessions/p/a.jsonl")).toBe(true);
		expect(await storage.readText("/sessions/p/a.jsonl")).toBe("line1\nline2\n");
		expect(redis.strings.get("omp:sessions:file:/sessions/p/a.jsonl")).toBe("line1\nline2\n");

		const stat = storage.statSync("/sessions/p/a.jsonl");
		expect(stat.size).toBe(12);
		expect(typeof stat.mtimeMs).toBe("number");
	});

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
	});

	it("create() warms the metadata index with STRLEN and never GETs full content", async () => {
		redis.strings.set("omp:sessions:file:/sessions/p/huge.jsonl", "0123456789");
		redis.hashes.set("omp:sessions:meta", new Map([["/sessions/p/huge.jsonl", String(Date.now())]]));

		const storage = await RedisSessionStorage.create({ client: redis });
		expect(storage.statSync("/sessions/p/huge.jsonl").size).toBe(10);
		expect(redis.calls.some(call => call.method === "get")).toBe(false);
		expect(redis.calls.some(call => call.method === "strlen")).toBe(true);
	});

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
	});

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
	});

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
	});

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
	});

	it("flags='w' truncates both index metadata and Redis", async () => {
		const storage = await RedisSessionStorage.create({ client: redis });
		await storage.writeText("/sessions/p/keep.jsonl", "old content\n");

		const writer = storage.openWriter("/sessions/p/keep.jsonl", { flags: "w" });
		await writer.append("fresh\n");
		await writer.close();

		expect(await storage.readText("/sessions/p/keep.jsonl")).toBe("fresh\n");
		expect(redis.strings.get("omp:sessions:file:/sessions/p/keep.jsonl")).toBe("fresh\n");
	});

	it("drain() surfaces writer errors so background failures are observable", async () => {
		const storage = await RedisSessionStorage.create({ client: redis });
		const writer = storage.openWriter("/sessions/p/fail.jsonl");
		redis.failNext("append", new Error("redis exploded"));
		void writer.append("doomed\n").catch(() => {});

		await expect(storage.drain()).rejects.toThrow("redis exploded");
		expect(writer.getError()?.message).toBe("redis exploded");
	});

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
	});

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
	});

	it("rename rolls back the index when Redis RENAME fails", async () => {
		const storage = await RedisSessionStorage.create({ client: redis });
		await storage.writeText("/sessions/p/a.jsonl", "keep\n");
		redis.failNext("rename", new Error("ERR redis rejected rename"));

		await expect(storage.rename("/sessions/p/a.jsonl", "/sessions/p/b.jsonl")).rejects.toThrow(
			"ERR redis rejected rename",
		);

		expect(storage.existsSync("/sessions/p/a.jsonl")).toBe(true);
		expect(storage.existsSync("/sessions/p/b.jsonl")).toBe(false);
	});

	it("renameNoReplace refuses a destination key another client set, leaving both keys", async () => {
		const storage = await RedisSessionStorage.create({ client: redis });
		await storage.writeText("/sessions/p/a.jsonl", "ours\n");
		// Another process sets the destination after this store loaded its index.
		redis.strings.set("omp:sessions:file:/sessions/p/b.jsonl", "theirs\n");

		const error = await storage.renameNoReplace("/sessions/p/a.jsonl", "/sessions/p/b.jsonl").then(
			() => undefined,
			(err: unknown) => err,
		);

		expect(error).toMatchObject({ code: "EEXIST", path: "/sessions/p/b.jsonl" });
		expect(redis.strings.get("omp:sessions:file:/sessions/p/a.jsonl")).toBe("ours\n");
		expect(redis.strings.get("omp:sessions:file:/sessions/p/b.jsonl")).toBe("theirs\n");
		expect(await storage.readText("/sessions/p/a.jsonl")).toBe("ours\n");
	});

	it("renameNoReplace moves to a free key", async () => {
		const storage = await RedisSessionStorage.create({ client: redis });
		await storage.writeText("/sessions/p/a.jsonl", "ours\n");

		await storage.renameNoReplace("/sessions/p/a.jsonl", "/sessions/p/c.jsonl");

		expect(redis.strings.has("omp:sessions:file:/sessions/p/a.jsonl")).toBe(false);
		expect(await storage.readText("/sessions/p/c.jsonl")).toBe("ours\n");
	});

	it("moves a key with its mtime and title in one script, dropping a stale title at the destination", async () => {
		const storage = await RedisSessionStorage.create({ client: redis });
		await storage.writeText("/sessions/p/a.jsonl", "ours\n");
		const titles = redis.hashes.get("omp:sessions:title") ?? new Map<string, string>();
		redis.hashes.set("omp:sessions:title", titles);
		titles.set("/sessions/p/a.jsonl", JSON.stringify({ title: "Ours", updatedAt: "t1" }));
		titles.set("/sessions/p/b.jsonl", JSON.stringify({ title: "Stale", updatedAt: "t0" }));
		redis.calls.length = 0;

		await storage.renameNoReplace("/sessions/p/a.jsonl", "/sessions/p/b.jsonl");

		// Nothing runs after the script, so no other client's write can land between the parts.
		expect(redis.calls.map(call => call.method)).toEqual(["send"]);
		expect(titles.get("/sessions/p/b.jsonl")).toBe(JSON.stringify({ title: "Ours", updatedAt: "t1" }));
		expect(titles.has("/sessions/p/a.jsonl")).toBe(false);
		expect(redis.hashes.get("omp:sessions:meta")?.has("/sessions/p/a.jsonl")).toBe(false);
		expect(redis.hashes.get("omp:sessions:meta")?.has("/sessions/p/b.jsonl")).toBe(true);
	});

	it("deleteSessionWithArtifacts removes a child key another client set after the refresh", async () => {
		const storage = await RedisSessionStorage.create({ client: redis });
		await storage.writeText("/sessions/p/s1.jsonl", "session\n");
		const refresh = storage.refresh.bind(storage);
		let injected = false;
		storage.refresh = async () => {
			await refresh();
			// Another process commits a subagent transcript once this view is loaded.
			redis.strings.set("omp:sessions:file:/sessions/p/s1/Late.jsonl", "late\n");
			injected = true;
		};

		await storage.deleteSessionWithArtifacts("/sessions/p/s1.jsonl");

		expect(injected).toBe(true);
		expect(redis.strings.has("omp:sessions:file:/sessions/p/s1.jsonl")).toBe(false);
		expect(redis.strings.has("omp:sessions:file:/sessions/p/s1/Late.jsonl")).toBe(false);
	});

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
	});

	it("readTextSlices returns byte windows from the head and tail", async () => {
		const storage = await RedisSessionStorage.create({ client: redis });
		await storage.writeText("/sessions/p/big.jsonl", "abcdefghij");

		expect((await storage.readTextSlices("/sessions/p/big.jsonl", 4, 0))[0]).toBe("abcd");
		expect((await storage.readTextSlices("/sessions/p/big.jsonl", 100, 0))[0]).toBe("abcdefghij");
		expect((await storage.readTextSlices("/sessions/p/big.jsonl", 0, 0))[0]).toBe("");
		expect((await storage.readTextSlices("/sessions/p/big.jsonl", 0, 3))[1]).toBe("hij");
		expect((await storage.readTextSlices("/sessions/p/big.jsonl", 0, 100))[1]).toBe("abcdefghij");
		expect(await storage.readTextSlices("/sessions/p/big.jsonl", 4, 3)).toEqual(["abcd", "hij"]);
	});

	it("readTextSlices uses GETRANGE instead of GET", async () => {
		const storage = await RedisSessionStorage.create({ client: redis });
		await storage.writeText("/sessions/p/big.jsonl", "abcdefghij");

		redis.calls.length = 0;
		expect(await storage.readTextSlices("/sessions/p/big.jsonl", 4, 3)).toEqual(["abcd", "hij"]);
		expect(redis.calls.map(call => call.method)).toEqual(["getrange", "getrange"]);
		expect(redis.calls[0].args).toEqual(["omp:sessions:file:/sessions/p/big.jsonl", 0, 3]);
		expect(redis.calls[1].args).toEqual(["omp:sessions:file:/sessions/p/big.jsonl", -3, -1]);
	});

	it("custom prefix isolates keyspaces", async () => {
		const storage = await RedisSessionStorage.create({ client: redis, prefix: "proj-a:" });
		await storage.writeText("/sessions/x.jsonl", "hello\n");
		expect(redis.strings.has("proj-a:file:/sessions/x.jsonl")).toBe(true);
		expect(redis.strings.has("omp:sessions:file:/sessions/x.jsonl")).toBe(false);
	});

	it("unlink on a missing key throws ENOENT", async () => {
		const storage = await RedisSessionStorage.create({ client: redis });
		await expect(storage.unlink("/sessions/p/ghost.jsonl")).rejects.toMatchObject({ code: "ENOENT" });
	});
});

// The fake above does not run Lua; these run the move and remove scripts on a
// real server when `OMP_TEST_REDIS_URL` names a throwaway Redis 7.
describe.skipIf(!process.env.OMP_TEST_REDIS_URL)("RedisSessionStorage on a Redis server", () => {
	const clients: RedisClient[] = [];
	let prefix = "";
	const open = async (): Promise<{ client: RedisClient; storage: RedisSessionStorage }> => {
		const client = new RedisClient(process.env.OMP_TEST_REDIS_URL!);
		clients.push(client);
		return { client, storage: await RedisSessionStorage.create({ client, prefix }) };
	};
	const hget = async (client: RedisClient, hash: string, field: string) =>
		client.send("HGET", [`${prefix}${hash}`, field]);

	beforeEach(() => {
		prefix = `omp-test:${process.pid}:${Date.now().toString(36)}:`;
	});
	afterEach(async () => {
		const [first] = clients;
		if (first) {
			for (const key of (await first.send("KEYS", [`${prefix}*`])) as string[]) await first.send("DEL", [key]);
		}
		for (const client of clients.splice(0)) client.close();
	});

	it("a refused move leaves both keys and both hashes as they were", async () => {
		const { client, storage } = await open();
		const other = await open();
		await storage.writeText("/s/a.jsonl", "ours\n");
		await other.storage.writeText("/s/b.jsonl", "theirs\n");
		const before = [await client.hgetall(`${prefix}meta`), await client.hgetall(`${prefix}title`)];

		await expect(storage.renameNoReplace("/s/a.jsonl", "/s/b.jsonl")).rejects.toMatchObject({
			code: "EEXIST",
			path: "/s/b.jsonl",
		});

		expect(await client.get(`${prefix}file:/s/a.jsonl`)).toBe("ours\n");
		expect(await client.get(`${prefix}file:/s/b.jsonl`)).toBe("theirs\n");
		expect([await client.hgetall(`${prefix}meta`), await client.hgetall(`${prefix}title`)]).toEqual(before);
	});

	it("a move carries the title metadata and drops a stale title at the destination", async () => {
		const { client, storage } = await open();
		await storage.writeText("/s/a.jsonl", "ours\n");
		await client.send("HSET", [`${prefix}title`, "/s/a.jsonl", '{"title":"Ours","updatedAt":"t1"}']);
		await client.send("HSET", [`${prefix}title`, "/s/c.jsonl", '{"title":"Stale","updatedAt":"t0"}']);

		await storage.renameNoReplace("/s/a.jsonl", "/s/c.jsonl");

		expect(await client.get(`${prefix}file:/s/c.jsonl`)).toBe("ours\n");
		expect(await hget(client, "title", "/s/c.jsonl")).toBe('{"title":"Ours","updatedAt":"t1"}');
		expect(await hget(client, "title", "/s/a.jsonl")).toBeNull();
		expect(await hget(client, "meta", "/s/a.jsonl")).toBeNull();
		expect(await hget(client, "meta", "/s/c.jsonl")).not.toBeNull();
	});

	it("deleting a session removes, in one command, every key and its metadata under the directory", async () => {
		const { client, storage } = await open();
		const other = await open();
		await storage.writeText("/s/p.jsonl", "parent\n");
		// Set by another client after this store loaded its view, and never refreshed into it.
		await other.storage.writeText("/s/p/Late*[x].jsonl", "late\n");
		await other.storage.writeText("/s/p-sibling.jsonl", "sibling\n");
		const send = client.send.bind(client);
		const commands: string[] = [];
		client.send = (command: string, args: string[]) => {
			commands.push(command);
			return send(command, args);
		};
		storage.refresh = async () => {};

		await storage.deleteSessionWithArtifacts("/s/p.jsonl");

		expect(commands).toEqual(["EVAL"]);
		expect(await client.exists(`${prefix}file:/s/p.jsonl`)).toBe(false);
		expect(await client.exists(`${prefix}file:/s/p/Late*[x].jsonl`)).toBe(false);
		expect(await hget(client, "meta", "/s/p/Late*[x].jsonl")).toBeNull();
		expect(await client.get(`${prefix}file:/s/p-sibling.jsonl`)).toBe("sibling\n");
	});
});
