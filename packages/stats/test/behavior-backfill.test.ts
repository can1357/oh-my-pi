import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { syncAllSessions } from "@oh-my-pi/omp-stats/aggregator";
import { closeDb, getFileOffset, getFrustrationOverall, initDb } from "@oh-my-pi/omp-stats/db";
import { getFrustrationDashboardStats } from "@oh-my-pi/omp-stats/frustration";
import { getAgentDir, getStatsDbPath } from "@oh-my-pi/pi-utils";
import { installStatsTestIsolation } from "./helpers/temp-agent";

installStatsTestIsolation("@pi-stats-behavior-backfill-");

async function writeSessionFile(options: { agentSteer?: boolean } = {}): Promise<string> {
	const sessionDir = path.join(getAgentDir(), "sessions", "--tmp--behavior-backfill");
	await fs.mkdir(sessionDir, { recursive: true });
	const sessionFile = path.join(sessionDir, "session.jsonl");
	const timestamp = new Date().toISOString();
	const user = {
		type: "message",
		id: "user-1",
		parentId: null,
		timestamp,
		message: { role: "user", content: "PLEASE FIX THIS NOW", attribution: "user" },
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
	const agentSteer = options.agentSteer
		? {
				type: "message",
				id: "agent-1",
				parentId: "user-1",
				timestamp,
				message: { role: "user", content: "PLEASE FIX THIS NOW", attribution: "agent", steering: true },
			}
		: null;
	await Bun.write(
		sessionFile,
		`${[user, agentSteer, assistant]
			.filter(entry => entry !== null)
			.map(entry => JSON.stringify(entry))
			.join("\n")}\n`,
	);
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
			.run("user_messages_v10", "1778589361860");
		database
			.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)")
			.run("user_message_links_v1", "1778589361862");
		database
			.prepare("INSERT OR REPLACE INTO file_offsets (session_file, offset, last_modified) VALUES (?, ?, ?)")
			.run(sessionFile, stats.size, stats.mtimeMs);
		database.close();

		const synced = await syncAllSessions();
		const counts = getFrustrationOverall(null);

		expect(synced.files).toBe(1);
		expect(counts.messages).toBe(1);
		expect(counts.annoyed).toBe(1);
	});

	it("drops historical agent-attributed rows and preserves user verdicts after a one-time reparse", async () => {
		const sessionFile = await writeSessionFile({ agentSteer: true });
		await syncAllSessions({ workers: 1 });
		closeDb();

		const database = new Database(getStatsDbPath());
		database.exec(`
			INSERT INTO user_messages (
				session_file, entry_id, folder, timestamp, model, provider, chars, words,
				yelling, profanity, anguish, negation, repetition, blame, prose, prose_hash
			)
			SELECT session_file, 'agent-1', folder, timestamp, model, provider, chars, words,
				yelling, profanity, anguish, negation, repetition, blame, prose, prose_hash
			FROM user_messages WHERE entry_id = 'user-1';
			INSERT INTO frustration_verdicts (prose_hash, p_annoyed, p_angry, target, judge, judged_at)
			SELECT prose_hash, 1, 1, 'assistant', 'test/judge', 1 FROM user_messages WHERE entry_id = 'user-1';
			DELETE FROM meta WHERE key = 'user_messages_v10';
		`);
		database.close();

		await initDb();
		expect(getFrustrationOverall(null).messages).toBe(0);
		expect(getFileOffset(sessionFile)).toBeNull();

		await syncAllSessions({ workers: 1 });
		const { overall, byModel } = await getFrustrationDashboardStats("all");
		expect(overall).toMatchObject({ messages: 1, judged: 1, annoyed: 1, atAssistant: 1, angry: 1 });
		expect(byModel).toHaveLength(1);
		expect(byModel[0]).toMatchObject({ messages: 1, annoyed: 1, atAssistant: 1, angry: 1 });
		closeDb();

		await initDb();
		expect(getFrustrationOverall(null).messages).toBe(1);
		expect(getFileOffset(sessionFile)).not.toBeNull();
	});

	it("does not re-wipe existing progress when the backfill sentinel is already pending", async () => {
		const sessionFile = await writeSessionFile();
		await syncAllSessions();
		expect(getFrustrationOverall(null).messages).toBe(1);
		expect(getFileOffset(sessionFile)).not.toBeNull();
		closeDb();

		const database = new Database(getStatsDbPath());
		database.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run("user_messages_v10", "pending");
		database
			.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)")
			.run("user_message_links_v1", "pending");
		database.close();

		await initDb();
		expect(getFrustrationOverall(null).messages).toBe(1);
		expect(getFileOffset(sessionFile)).not.toBeNull();
	});

	it("marks full-session backfills complete after a successful sync", async () => {
		await writeSessionFile();
		await syncAllSessions({ workers: 1 });
		closeDb();

		const database = new Database(getStatsDbPath(), { readonly: true });
		const rows = database
			.query(
				"SELECT key, value FROM meta WHERE key IN ('user_messages_v10', 'tool_calls_v3', 'user_message_links_v1', 'premium_requests_priority_v2') ORDER BY key",
			)
			.all() as { key: string; value: string }[];
		database.close();

		expect(rows).toEqual([
			{ key: "premium_requests_priority_v2", value: "complete" },
			{ key: "tool_calls_v3", value: "complete" },
			{ key: "user_message_links_v1", value: "complete" },
			{ key: "user_messages_v10", value: "complete" },
		]);
	});
});
