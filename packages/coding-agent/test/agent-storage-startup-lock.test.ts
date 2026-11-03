/**
 * An omp start must not fail because another omp process holds agent.db's write lock: a start that
 * finds the schema current only reads it. Before, AgentStorage.open's auth-store init ran an
 * `INSERT OR IGNORE` on every open, so a peer's long write transaction exhausted the open's BUSY
 * retries and headless starts exited with "database is locked".
 */
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { closeMemoryDb, openMemoryDb } from "@oh-my-pi/pi-coding-agent/memories/storage";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { TempDir } from "@oh-my-pi/pi-utils";

describe("agent.db opens under a peer's write lock", () => {
	let tempDir: TempDir | undefined;

	afterEach(async () => {
		AgentStorage.close();
		await tempDir?.remove();
		tempDir = undefined;
	});

	it("opens a current AgentStorage and memory schema without waiting for the writer", async () => {
		tempDir = TempDir.createSync("@omp-agent-storage-lock-");
		const dbPath = path.join(tempDir.path(), "agent.db");
		const created = await AgentStorage.open(dbPath);
		created.recordModelUsage("anthropic/claude-test");
		AgentStorage.close();
		closeMemoryDb(openMemoryDb(dbPath));

		const peer = new Database(dbPath);
		try {
			peer.run("PRAGMA busy_timeout = 0");
			peer.run("BEGIN IMMEDIATE");
			peer.run("INSERT INTO meta (key, value) VALUES ('peer', 'writing')");

			const storage = await AgentStorage.open(dbPath);
			expect(storage.getModelUsageOrder()).toEqual(["anthropic/claude-test"]);
			expect(storage.listAuthCredentials()).toEqual([]);
			closeMemoryDb(openMemoryDb(dbPath));
		} finally {
			peer.run("ROLLBACK");
			peer.close();
		}
	}, 20_000);
});
