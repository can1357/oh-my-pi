import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { syncAllSessions } from "@pk-nerdsaver-ai/omp-stats/aggregator";
import { closeDb, getBehaviorOverall, getFileOffset, initDb } from "@pk-nerdsaver-ai/omp-stats/db";
import { getAgentDir, getStatsDbPath, setAgentDir, TempDir } from "@pk-nerdsaver-ai/pi-utils";

const originalConfigDir = process.env.PI_CONFIG_DIR;
const originalAgentDir = getAgentDir();
let tempDir: TempDir | null = null;

beforeEach(() => {
	tempDir = TempDir.createSync("@pi-stats-behavior-backfill-");
	const configDir = path.relative(os.homedir(), tempDir.join("config"));
	process.env.PI_CONFIG_DIR = configDir;
	setAgentDir(path.join(os.homedir(), configDir, "agent"));
});

afterEach(() => {
	closeDb();
	if (originalConfigDir === undefined) {
		delete process.env.PI_CONFIG_DIR;
	} else {
		process.env.PI_CONFIG_DIR = originalConfigDir;
	}
	setAgentDir(originalAgentDir);
	// Best-effort: the stats SQLite handles can still be open when teardown
	// runs, and Windows then refuses the delete with EBUSY — failing a test whose
	// assertions all passed and masking any genuine failure behind it.
	// Reclaiming an OS temp dir is not what these tests assert.
	try {
		tempDir?.removeSync();
	} catch {
		// leave it to the OS temp reaper
	}
	tempDir = null;
});

async function writeSessionFile(): Promise<string> {
	const sessionDir = path.join(getAgentDir(), "sessions", "--tmp--behavior-backfill");
	await fs.mkdir(sessionDir, { recursive: true });
	const sessionFile = path.join(sessionDir, "session.jsonl");
	const timestamp = new Date().toISOString();
	const user = {
		type: "message",
		id: "user-1",
		parentId: null,
		timestamp,
		message: { role: "user", content: "PLEASE FIX THIS NOW" },
	};
	const assistant = {
		type: "message",
		id: "assistant-1",
		parentId: "user-1",
		timestamp,
		message: {
			role: "assistant",
			content: [{ type: "text", text: "ok" }],
			api: "openai-responses",
			provider: "openai",
			model: "gpt-5.4",
			usage: {
				input: 1,
				output: 2,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 3,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
			duration: 10,
			ttft: 5,
		},
	};
	await Bun.write(sessionFile, `${JSON.stringify(user)}\n${JSON.stringify(assistant)}\n`);
	return sessionFile;
}

describe("behavior backfill", () => {
	it("retries when a failed compiled sync left old backfill sentinels behind", async () => {
		const sessionFile = await writeSessionFile();
		await initDb();
		closeDb();

		const stats = await fs.stat(sessionFile);
		const database = new Database(getStatsDbPath());
		database
			.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)")
			.run("user_messages_v6", "1778589361860");
		database
			.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)")
			.run("user_message_links_v1", "1778589361862");
		database
			.prepare("INSERT OR REPLACE INTO file_offsets (session_file, offset, last_modified) VALUES (?, ?, ?)")
			.run(sessionFile, stats.size, stats.mtimeMs);
		database.close();

		const synced = await syncAllSessions();
		const behavior = getBehaviorOverall(null);

		expect(synced.files).toBe(1);
		expect(behavior.totalMessages).toBe(1);
		expect(behavior.totalYelling).toBe(1);
	});

	it("does not re-wipe existing progress when the backfill sentinel is already pending", async () => {
		const sessionFile = await writeSessionFile();
		await syncAllSessions();
		expect(getBehaviorOverall(null).totalMessages).toBe(1);
		expect(getFileOffset(sessionFile)).not.toBeNull();
		closeDb();

		const database = new Database(getStatsDbPath());
		database.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run("user_messages_v6", "pending");
		database
			.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)")
			.run("user_message_links_v1", "pending");
		database.close();

		await initDb();
		expect(getBehaviorOverall(null).totalMessages).toBe(1);
		expect(getFileOffset(sessionFile)).not.toBeNull();
	});
});
