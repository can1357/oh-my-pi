/**
 * Integration: `SessionManager` driven by `RedisSessionStorage` instead of a
 * file-backed store. Verifies that the storage substrate is genuinely
 * pluggable — message append, persistence, reload via `open()`, and
 * `SessionManager.list()` all behave the same against Redis-backed keys.
 *
 * Driven by the in-memory Redis double in `test/helpers/fake-redis.ts`, which
 * `redis-session-storage.test.ts` uses too; we don't require a live server.
 */

import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import type { Usage } from "@oh-my-pi/pi-ai";
import { RedisSessionStorage } from "@oh-my-pi/pi-coding-agent/session/redis-session-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { SessionWriteConflictError } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { createFakeRedis } from "../helpers/fake-redis";

function fakeUsage(input: number, output: number): Usage {
	return {
		input,
		output,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: input + output,
		cost: { total: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
}

// `path.resolve` makes the virtual dirs absolute on every platform: on Windows
// `/sessions/x` is drive-relative, and `SessionManager` resolves it when reopening.
const sessionRoot = path.resolve("/sessions");

describe("SessionManager + RedisSessionStorage", () => {
	it("persists appended assistant messages into Redis and reloads them via open()", async () => {
		const redis = createFakeRedis();
		const storage = await RedisSessionStorage.create({ client: redis });
		const sessionDir = path.join(sessionRoot, "proj");

		const manager = SessionManager.create("/cwd", sessionDir, storage);
		manager.appendMessage({
			role: "assistant",
			provider: "anthropic",
			model: "claude-3-7-sonnet",
			content: [{ type: "text", text: "hi" }],
			usage: fakeUsage(10, 5),
			api: "anthropic-messages",
			stopReason: "stop",
			timestamp: Date.now(),
		});

		const sessionFile = manager.getSessionFile();
		expect(sessionFile).toBeDefined();
		const sessionFilePath = sessionFile as string;
		expect(sessionFilePath.startsWith(sessionDir)).toBe(true);

		// `appendMessage` queues the cold-path rewrite onto SessionManager's
		// internal persist chain via a fire-and-forget call. `flush()` awaits
		// that chain; `drain()` mops up the storage-level pending tail.
		await manager.flush();
		await storage.drain();
		await manager.close();

		// Redis now contains the JSONL — title slot + header + one message entry.
		const stored = redis.strings.get(`omp:sessions:file:${sessionFilePath}`);
		expect(stored).toBeDefined();
		const lines = (stored as string).trim().split("\n");
		expect(lines.length).toBeGreaterThanOrEqual(3);
		const slot = JSON.parse(lines[0]);
		expect(slot.type).toBe("title");
		const header = JSON.parse(lines[1]);
		expect(header.type).toBe("session");
		const msg = JSON.parse(lines[lines.length - 1]);
		expect(msg.type).toBe("message");
		expect(msg.message.role).toBe("assistant");
		expect(msg.message.content[0].text).toBe("hi");

		// Reopening the session through SessionManager.open should recover the leaf.
		const reopened = await SessionManager.open(sessionFilePath, sessionDir, storage);
		const leaf = reopened.getLeafEntry();
		expect(leaf).toBeDefined();
		expect(leaf?.type).toBe("message");
		await reopened.close();
	}, 30_000);

	it("SessionManager.list returns Redis-backed sessions for the cwd", async () => {
		const redis = createFakeRedis();
		const storage = await RedisSessionStorage.create({ client: redis });
		const sessionDir = path.join(sessionRoot, "list-proj");

		const a = SessionManager.create("/cwd", sessionDir, storage);
		a.appendMessage({
			role: "assistant",
			provider: "anthropic",
			model: "claude-3-7-sonnet",
			content: [{ type: "text", text: "alpha" }],
			usage: fakeUsage(1, 1),
			api: "anthropic-messages",
			stopReason: "stop",
			timestamp: Date.now(),
		});
		await a.flush();
		await storage.drain();
		await a.close();

		const b = SessionManager.create("/cwd", sessionDir, storage);
		b.appendMessage({
			role: "assistant",
			provider: "anthropic",
			model: "claude-3-7-sonnet",
			content: [{ type: "text", text: "beta" }],
			usage: fakeUsage(1, 1),
			api: "anthropic-messages",
			stopReason: "stop",
			timestamp: Date.now(),
		});
		await b.flush();
		await storage.drain();
		await b.close();

		const aFile = a.getSessionFile();
		const bFile = b.getSessionFile();
		expect(aFile).toBeDefined();
		expect(bFile).toBeDefined();

		const sessions = await SessionManager.list("/cwd", sessionDir, storage);
		const sessionFiles = sessions.map(s => s.path).sort();
		expect(sessionFiles).toContain(aFile as string);
		expect(sessionFiles).toContain(bFile as string);
	}, 30_000);

	it("rejects a stale rewrite after another Redis storage appends", async () => {
		const redis = createFakeRedis();
		const firstStorage = await RedisSessionStorage.create({ client: redis });
		const sharedDir = path.join(sessionRoot, "shared");
		const first = SessionManager.create("/cwd", sharedDir, firstStorage);
		await first.ensureOnDisk();
		const sessionFile = first.getSessionFile();
		if (!sessionFile) throw new Error("Expected session file");

		const secondStorage = await RedisSessionStorage.create({ client: redis });
		const second = await SessionManager.open(sessionFile, sharedDir, secondStorage);
		second.appendMessage({ role: "user", content: "durable Redis peer turn", timestamp: Date.now() });
		await second.close();

		await expect(first.rewriteEntries()).rejects.toBeInstanceOf(SessionWriteConflictError);
		expect(redis.strings.get(`omp:sessions:file:${sessionFile}`)).toContain("durable Redis peer turn");
	}, 30_000);

	it("does not count a session as resumable while its Redis removal is in flight", async () => {
		// The removal has deleted the session's key but has not settled: its script ran on the server and its reply
		// has not arrived (or, on a store that removes with commands of its own, the DEL ran and the HDEL after it
		// stalls). An exit-time resume hint read meanwhile would advertise a session whose content is already gone.
		const redis = createFakeRedis();
		const removalRan = Promise.withResolvers<void>();
		const allowReply = Promise.withResolvers<void>();
		const stall = async (): Promise<void> => {
			removalRan.resolve();
			await allowReply.promise;
		};
		const send = redis.send.bind(redis);
		redis.send = async (command, args) => {
			const result = await send(command, args);
			if (args[0]?.includes("OMP_REMOVE")) await stall();
			return result;
		};
		const hdel = redis.hdel.bind(redis);
		redis.hdel = async (key, ...fields) => {
			await stall();
			return hdel(key, ...fields);
		};
		const storage = await RedisSessionStorage.create({ client: redis });
		const manager = SessionManager.create("/cwd", path.join(sessionRoot, "removing"), storage);
		await manager.ensureOnDisk();
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("Expected session file");
		expect(manager.isSessionConfirmedOnDisk()).toBe(true);

		const removal = manager.dropSession(sessionFile);
		// Never rejects, so the case waits for the removal however it ends, after the reply is let through.
		const settled = removal.then(
			() => undefined,
			(error: unknown) => error,
		);
		let held: { first: "gate" | "settled"; stored: boolean; confirmed: boolean } | undefined;
		try {
			// The gate must win: a removal that settles without reaching it never was in flight here.
			const first = await Promise.race([
				removalRan.promise.then(() => "gate" as const),
				settled.then(() => "settled" as const),
			]);
			held = {
				first,
				stored: redis.strings.has(`omp:sessions:file:${sessionFile}`),
				confirmed: manager.isSessionConfirmedOnDisk(),
			};
		} finally {
			allowReply.resolve();
		}
		expect({ held, error: await settled, after: manager.isSessionConfirmedOnDisk() }).toEqual({
			held: { first: "gate", stored: false, confirmed: false },
			error: undefined,
			after: false,
		});
	}, 30_000);

	it("keeps a session unconfirmed after a Redis removal fails past its file delete", async () => {
		// The removal deleted the session's key, then failed (its script ran and the reply was lost, or, on a store
		// that removes with commands of its own, the HDEL after the DEL failed): the rollback restores the index
		// entry, but the content is gone, so an exit-time resume hint must not offer it.
		const redis = createFakeRedis();
		const storage = await RedisSessionStorage.create({ client: redis });
		const manager = SessionManager.create("/cwd", path.join(sessionRoot, "failed-removal"), storage);
		await manager.ensureOnDisk();
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("Expected session file");
		const send = redis.send.bind(redis);
		redis.send = async (command, args) => {
			const result = await send(command, args);
			if (args[0]?.includes("OMP_REMOVE")) throw new Error("connection lost");
			return result;
		};
		redis.hdel = async () => {
			throw new Error("connection lost");
		};

		await expect(manager.dropSession(sessionFile)).rejects.toThrow("connection lost");
		expect(redis.strings.has(`omp:sessions:file:${sessionFile}`)).toBe(false);
		expect(storage.existsSync(sessionFile)).toBe(true);
		expect(manager.isSessionConfirmedOnDisk()).toBe(false);

		// An append extends whatever the backend holds, which no longer includes the header.
		const writer = storage.openWriter(sessionFile);
		try {
			await writer.append("{}\n");
		} finally {
			await writer.close();
		}
		expect(manager.isSessionConfirmedOnDisk()).toBe(false);

		// A later full write replaces the content, so the backend confirms the path again.
		storage.writeTextSync(sessionFile, "rewritten\n");
		await storage.drain();
		expect(manager.isSessionConfirmedOnDisk()).toBe(true);
	}, 30_000);
});
