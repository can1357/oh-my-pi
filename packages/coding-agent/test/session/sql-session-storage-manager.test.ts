/**
 * Integration: `SessionManager` driven by `SqlSessionStorage` (SQLite
 * backend) instead of the file-backed store. Verifies the SQL substrate is
 * genuinely pluggable — append → flush → reload via `open()` works against
 * a real `Bun.SQL` connection, and `SessionManager.list()` enumerates rows
 * out of the table.
 */

import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import type { Usage } from "@oh-my-pi/pi-ai";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { SqlSessionStorage, type SqlSessionStorageClient } from "@oh-my-pi/pi-coding-agent/session/sql-session-storage";
import { SessionWriteConflictError } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { SQL } from "bun";

// Storage keys are platform paths; `/sessions/...` is only drive-relative on Windows,
// so a resolved `open()` would address a different key than `create()` wrote.
const virtualDir = (dir: string): string => path.resolve(dir);

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

class HeldSqlClient implements SqlSessionStorageClient {
	readonly options: SqlSessionStorageClient["options"];
	holdNextReplace = false;
	readonly replaceStarted = Promise.withResolvers<void>();
	readonly allowReplace = Promise.withResolvers<void>();
	readonly #client: InstanceType<typeof SQL>;

	constructor(client: InstanceType<typeof SQL>) {
		this.#client = client;
		this.options = client.options;
	}

	unsafe(query: string, values?: unknown[]) {
		if (this.holdNextReplace && query.startsWith("UPDATE omp_session_files SET content")) {
			this.holdNextReplace = false;
			this.replaceStarted.resolve();
			return this.allowReplace.promise.then(() => this.#client.unsafe(query, values));
		}
		return this.#client.unsafe(query, values);
	}

	transaction(callback: (transaction: SqlSessionStorageClient) => Promise<void>): Promise<void> {
		return this.#client.transaction(transaction => callback(transaction));
	}
}

describe("SessionManager + SqlSessionStorage (SQLite)", () => {
	it("persists appended assistant messages into SQL and reloads via open()", async () => {
		const client = new SQL("sqlite::memory:");
		const storage = await SqlSessionStorage.create({ client });
		const sessionDir = virtualDir("/sessions/proj");

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

		const rows = (await client.unsafe(`SELECT content FROM omp_session_files WHERE path = ?`, [
			sessionFilePath,
		])) as Array<{ content: string }>;
		expect(rows).toHaveLength(1);
		const lines = rows[0].content.trim().split("\n");
		expect(lines.length).toBeGreaterThanOrEqual(3);
		// The fixed-width title slot is always the first physical line; the session header follows.
		const slot = JSON.parse(lines[0]);
		expect(slot.type).toBe("title");
		const header = JSON.parse(lines[1]);
		expect(header.type).toBe("session");
		const msg = JSON.parse(lines[lines.length - 1]);
		expect(msg.type).toBe("message");
		expect(msg.message.role).toBe("assistant");
		expect(msg.message.content[0].text).toBe("hi");

		const reopened = await SessionManager.open(sessionFilePath, sessionDir, storage);
		const leaf = reopened.getLeafEntry();
		expect(leaf).toBeDefined();
		expect(leaf?.type).toBe("message");
		await reopened.close();
		await client.end();
	});

	it("SessionManager.list returns SQL-backed sessions for the cwd", async () => {
		const client = new SQL("sqlite::memory:");
		const storage = await SqlSessionStorage.create({ client });
		const sessionDir = virtualDir("/sessions/list-proj");

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
		await client.end();
	});

	it("rejects a stale rewrite after another SQL storage appends", async () => {
		const client = new SQL("sqlite::memory:");
		const firstStorage = await SqlSessionStorage.create({ client });
		const sessionDir = virtualDir("/sessions/shared");
		const first = SessionManager.create("/cwd", sessionDir, firstStorage);
		await first.ensureOnDisk();
		const sessionFile = first.getSessionFile();
		if (!sessionFile) throw new Error("Expected session file");

		const secondStorage = await SqlSessionStorage.create({ client });
		const second = await SessionManager.open(sessionFile, sessionDir, secondStorage);
		second.appendMessage({ role: "user", content: "durable SQL peer turn", timestamp: Date.now() });
		await second.close();

		await expect(first.rewriteEntries()).rejects.toBeInstanceOf(SessionWriteConflictError);
		expect(await secondStorage.readText(sessionFile)).toContain("durable SQL peer turn");
		await client.end();
	});
	it("recovers a fenced rewrite size conflict with the real SQLite backend", async () => {
		const client = new SQL("sqlite::memory:");
		const heldClient = new HeldSqlClient(client);
		const storage = await SqlSessionStorage.create({ client: heldClient });
		const manager = SessionManager.create("/cwd", virtualDir("/sessions/rewrite-race"), storage);
		await manager.ensureOnDisk();
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("Expected session file");

		manager.appendMessage({
			role: "assistant",
			provider: "anthropic",
			model: "claude-3-7-sonnet",
			content: [{ type: "text", text: "seed reply" }],
			usage: fakeUsage(1, 1),
			api: "anthropic-messages",
			stopReason: "stop",
			timestamp: Date.now(),
		});
		manager.appendMessage({ role: "user", content: "before rewrite", timestamp: Date.now() });
		await manager.flush();
		await storage.drain();
		const turn = manager.getEntries().find(entry => entry.type === "message" && entry.message.role === "user");
		if (turn?.type !== "message" || turn.message.role !== "user") throw new Error("Expected user turn");
		turn.message.content = "pruned before rewrite";

		heldClient.holdNextReplace = true;
		const rewritePublished = manager.rewriteEntries();
		await heldClient.replaceStarted.promise;
		manager.appendMessage({ role: "user", content: "fenced append", timestamp: Date.now() });
		heldClient.allowReplace.resolve();
		await rewritePublished.catch(() => {});
		await manager.flush().catch(() => {});

		manager.appendMessage({ role: "user", content: "later turn", timestamp: Date.now() });
		await manager.flush().catch(() => {});
		await storage.drain().catch(() => {});

		const body = await storage.readText(sessionFile);
		expect(body).toContain("fenced append");
		expect(body).toContain("later turn");
		expect(manager.captureState().expectedDiskSize).toBe(Buffer.byteLength(body, "utf8"));
		await manager.close();
		await client.end();
	});
});
