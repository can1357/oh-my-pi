/**
 * Integration: `SessionManager` driven by `RedisSessionStorage` instead of a
 * file-backed store. Verifies that the storage substrate is genuinely
 * pluggable — message append, persistence, reload via `open()`, and
 * `SessionManager.list()` all behave the same against Redis-backed keys.
 *
 * Driven by the same hand-rolled in-memory Redis double used in
 * `redis-session-storage.test.ts`; we don't require a live server.
 */

import { describe, expect, it } from "bun:test";
import type { Usage } from "@oh-my-pi/pi-ai";
import {
	RedisSessionStorage,
	type RedisSessionStorageClient,
} from "@oh-my-pi/pi-coding-agent/session/redis-session-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";

interface FakeRedis extends RedisSessionStorageClient {
	strings: Map<string, string>;
	hashes: Map<string, Map<string, string>>;
}

function createFakeRedis(): FakeRedis {
	const strings = new Map<string, string>();
	const hashes = new Map<string, Map<string, string>>();

	const getHash = (key: string): Map<string, string> => {
		let h = hashes.get(key);
		if (!h) {
			h = new Map();
			hashes.set(key, h);
		}
		return h;
	};

	return {
		strings,
		hashes,
		async send(command, args) {
			if (command !== "EVAL") throw new Error(`Unsupported Redis command: ${command}`);
			const script = args[0] ?? "";
			const keyCount = Number(args[1] ?? "0");
			const keys = args.slice(2, 2 + keyCount);
			const argv = args.slice(2 + keyCount);
			if (script.includes("OMP_WRITE_FULL")) {
				const [fileKey, metaKey, titleKey] = keys;
				const [content, filePath, mtimeMs, hasTitle, title] = argv;
				strings.set(fileKey, content);
				getHash(metaKey).set(filePath, mtimeMs);
				if (hasTitle === "1") getHash(titleKey).set(filePath, title);
				else getHash(titleKey).delete(filePath);
				return 1;
			}
			if (script.includes("OMP_APPEND")) {
				const [fileKey, metaKey] = keys;
				const [line, filePath, mtimeMs] = argv;
				const next = (strings.get(fileKey) ?? "") + line;
				strings.set(fileKey, next);
				getHash(metaKey).set(filePath, mtimeMs);
				return Buffer.byteLength(next, "utf-8");
			}
			if (script.includes("OMP_UPDATE_TITLE")) {
				const [metaKey, titleKey] = keys;
				const [filePath, mtimeMs, title] = argv;
				getHash(metaKey).set(filePath, mtimeMs);
				getHash(titleKey).set(filePath, title);
				return 1;
			}
			throw new Error("Unsupported Redis script");
		},
		async get(key) {
			return strings.has(key) ? (strings.get(key) as string) : null;
		},
		async getrange(key, start, end) {
			const bytes = Buffer.from(strings.get(key) ?? "", "utf-8");
			if (bytes.length === 0) return "";
			const from = Math.max(0, start < 0 ? bytes.length + start : start);
			const to = Math.min(bytes.length - 1, end < 0 ? bytes.length + end : end);
			if (to < from) return "";
			return bytes.subarray(from, to + 1).toString("utf-8");
		},
		async strlen(key) {
			return Buffer.byteLength(strings.get(key) ?? "", "utf-8");
		},
		async set(key, value) {
			strings.set(key, value);
			return "OK";
		},
		async append(key, value) {
			const current = strings.get(key) ?? "";
			const next = current + value;
			strings.set(key, next);
			return Buffer.byteLength(next, "utf-8");
		},
		async del(...keys) {
			let n = 0;
			for (const k of keys) {
				if (strings.delete(k)) n += 1;
			}
			return n;
		},
		async rename(src, dst) {
			if (!strings.has(src)) throw new Error("ERR no such key");
			strings.set(dst, strings.get(src) as string);
			strings.delete(src);
			return "OK";
		},
		async scan(_cursor, ...rest) {
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
		async hset(key, field, value) {
			getHash(key).set(field, value);
			return 1;
		},
		async hgetall(key) {
			const h = hashes.get(key);
			if (!h) return {};
			const out: Record<string, string> = {};
			for (const [k, v] of h) out[k] = v;
			return out;
		},
		async hdel(key, ...fields) {
			const h = hashes.get(key);
			if (!h) return 0;
			let n = 0;
			for (const f of fields) {
				if (h.delete(f)) n += 1;
			}
			return n;
		},
	};
}

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

describe("SessionManager + RedisSessionStorage", () => {
	it("persists appended assistant messages into Redis and reloads them via open()", async () => {
		const redis = createFakeRedis();
		const storage = await RedisSessionStorage.create({ client: redis });
		const sessionDir = "/sessions/proj";

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
	});

	it("SessionManager.list returns Redis-backed sessions for the cwd", async () => {
		const redis = createFakeRedis();
		const storage = await RedisSessionStorage.create({ client: redis });
		const sessionDir = "/sessions/list-proj";

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
	});
});
