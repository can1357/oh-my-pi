import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { syncAllSessions } from "@oh-my-pi/omp-stats/aggregator";
import { closeDb, getOverallStats, getRecentRequests, initDb, insertMessageStats } from "@oh-my-pi/omp-stats/db";
import type { MessageStats } from "@oh-my-pi/omp-stats/types";
import { getSessionsDir, getStatsDbPath } from "@oh-my-pi/pi-utils";
import { installStatsTestIsolation } from "./helpers/temp-agent";

installStatsTestIsolation("@pi-stats-fork-dedup-");

interface AssistantOptions {
	entryId: string;
	parentId?: string | null;
	timestamp: string;
}

function buildUserEntry(entryId: string, timestamp: string, content: string) {
	return {
		type: "message",
		id: entryId,
		parentId: null,
		timestamp,
		message: { role: "user", content },
	};
}

function buildAssistantEntry(opts: AssistantOptions) {
	return {
		type: "message",
		id: opts.entryId,
		parentId: opts.parentId ?? null,
		timestamp: opts.timestamp,
		message: {
			role: "assistant",
			content: [{ type: "text", text: "ok" }],
			api: "openai-responses",
			provider: "openai",
			model: "gpt-5.4",
			responseId: `resp-${opts.entryId}`,
			usage: {
				input: 100,
				output: 50,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 150,
				cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 },
			},
			stopReason: "stop",
			timestamp: Date.parse(opts.timestamp),
			duration: 10,
			ttft: 5,
		},
	};
}

async function writeSessionFile(
	folderSlug: string,
	fileName: string,
	header: { id: string; cwd: string; parentSession?: string },
	entries: unknown[],
): Promise<string> {
	const sessionDir = path.join(getSessionsDir(), folderSlug);
	await fs.mkdir(sessionDir, { recursive: true });
	const sessionFile = path.join(sessionDir, fileName);
	const headerEntry = {
		type: "session",
		version: 3,
		id: header.id,
		timestamp: new Date().toISOString(),
		cwd: header.cwd,
		...(header.parentSession ? { parentSession: header.parentSession } : {}),
	};
	const lines = [headerEntry, ...entries].map(entry => JSON.stringify(entry)).join("\n");
	await Bun.write(sessionFile, `${lines}\n`);
	return sessionFile;
}

function makeStat(sessionFile: string, entryId: string, timestamp: number, premium = 0): MessageStats {
	return {
		sessionFile,
		entryId,
		folder: "/tmp/fork-dedup",
		model: "gpt-5.4",
		provider: "openai",
		api: "openai-responses",
		timestamp,
		duration: 10,
		ttft: 5,
		stopReason: "stop",
		errorMessage: null,
		usage: {
			input: 100,
			output: 50,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 150,
			premiumRequests: premium,
			cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 },
		},
		agentType: "main",
	};
}

describe("stats sync deduplicates forked-session entries", () => {
	it("counts each provider request once even when a fork copied the entries", async () => {
		const ts = new Date("2026-06-24T10:00:00.000Z").toISOString();
		const userEntry = buildUserEntry("user01ab", ts, "hello");
		const assistantEntry = buildAssistantEntry({ entryId: "asst01ab", parentId: "user01ab", timestamp: ts });

		const parentFile = await writeSessionFile(
			"--tmp--fork-dedup",
			"01_parent.jsonl",
			{ id: "parent00", cwd: "/tmp/project" },
			[userEntry, assistantEntry],
		);

		// `SessionManager.createBranchedSession` / `forkFrom` deep-copy the
		// parent's entries into the child file with `parentSession` in the
		// header. Earlier stats sync keyed uniqueness on (session_file,
		// entry_id), so both files contributed the same provider request to
		// every aggregate.
		await writeSessionFile(
			"--tmp--fork-dedup",
			"02_fork.jsonl",
			{ id: "fork0000", cwd: "/tmp/project", parentSession: parentFile },
			[userEntry, assistantEntry],
		);
		await syncAllSessions({ workers: 1 });

		const assistantRequests = getRecentRequests(10).filter(r => r.entryId === "asst01ab");
		expect(assistantRequests).toHaveLength(1);
		expect(assistantRequests[0].sessionFile).toBe(parentFile);

		const overall = getOverallStats();
		expect(overall.totalRequests).toBe(1);
		expect(overall.totalInputTokens).toBe(100);
		expect(overall.totalOutputTokens).toBe(50);
		expect(overall.totalCost).toBeCloseTo(0.003, 8);
	});

	it("admits new entries appended in the forked session", async () => {
		const ts = new Date("2026-06-24T10:00:00.000Z").toISOString();
		const userEntry = buildUserEntry("user01ab", ts, "hello");
		const assistantEntry = buildAssistantEntry({ entryId: "asst01ab", parentId: "user01ab", timestamp: ts });

		const parentFile = await writeSessionFile(
			"--tmp--fork-dedup",
			"01_parent.jsonl",
			{ id: "parent00", cwd: "/tmp/project" },
			[userEntry, assistantEntry],
		);

		// After fork, the child file appends a fresh user+assistant pair.
		// Inherited entries must dedupe; new ones must still count.
		const newTs = new Date("2026-06-24T10:05:00.000Z").toISOString();
		const newUserEntry = buildUserEntry("user02cd", newTs, "follow-up");
		const newAssistantEntry = buildAssistantEntry({
			entryId: "asst02cd",
			parentId: "user02cd",
			timestamp: newTs,
		});
		await writeSessionFile(
			"--tmp--fork-dedup",
			"02_fork.jsonl",
			{ id: "fork0000", cwd: "/tmp/project", parentSession: parentFile },
			[userEntry, assistantEntry, newUserEntry, newAssistantEntry],
		);

		await syncAllSessions({ workers: 1 });

		const overall = getOverallStats();
		expect(overall.totalRequests).toBe(2);
		expect(overall.totalInputTokens).toBe(200);
		expect(overall.totalOutputTokens).toBe(100);
		expect(overall.totalCost).toBeCloseTo(0.006, 8);
	});

	it("collapses pre-existing duplicate rows on init (one-shot migration)", async () => {
		await initDb();
		closeDb();

		// Clear the fork-dedupe sentinel so the migration runs against the
		// hand-inserted dupes, then plant two messages and two user_messages
		// rows that share (entry_id, timestamp) under different session_files
		// — exactly the shape `SessionManager.fork()` leaves behind.
		const database = new Database(getStatsDbPath());
		database.prepare("DELETE FROM meta WHERE key = ?").run("fork_dedupe_v1");
		const ts = Date.now();
		const insertMessage = database.prepare(`
			INSERT INTO messages (
				session_file, entry_id, folder, model, provider, api, timestamp,
				duration, ttft, stop_reason, error_message,
				input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, total_tokens, premium_requests,
				cost_input, cost_output, cost_cache_read, cost_cache_write, cost_total, agent_type
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`);
		const sharedArgs = [
			"/tmp/fork-dedup/project",
			"gpt-5.4",
			"openai",
			"openai-responses",
			ts,
			10,
			5,
			"stop",
			null,
			100,
			50,
			0,
			0,
			150,
			0,
			0.001,
			0.002,
			0,
			0,
			0.003,
			"main",
		];
		insertMessage.run("/tmp/parent.jsonl", "asst01ab", ...sharedArgs);
		insertMessage.run("/tmp/fork.jsonl", "asst01ab", ...sharedArgs);
		const insertUser = database.prepare(`
			INSERT INTO user_messages (
				session_file, entry_id, folder, timestamp, model, provider,
				chars, words, yelling, profanity, anguish,
				negation, repetition, blame
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`);
		const sharedUser = ["/tmp/fork-dedup/project", ts, "gpt-5.4", "openai", 5, 1, 0, 0, 0, 0, 0, 0];
		insertUser.run("/tmp/parent.jsonl", "user01ab", ...sharedUser);
		insertUser.run("/tmp/fork.jsonl", "user01ab", ...sharedUser);
		database.close();

		await initDb();

		const messageRows = getRecentRequests(10).filter(r => r.entryId === "asst01ab");
		expect(messageRows).toHaveLength(1);
		expect(messageRows[0].sessionFile).toBe("/tmp/parent.jsonl");
		const overall = getOverallStats();
		expect(overall.totalRequests).toBe(1);
		expect(overall.totalCost).toBeCloseTo(0.003, 8);

		// The migration is idempotent. Re-running init must not delete the
		// surviving row.
		closeDb();
		await initDb();
		expect(getOverallStats().totalRequests).toBe(1);
	});

	it("still upserts premium_requests for re-syncs of the same session file", async () => {
		await initDb();
		const stat = makeStat("/tmp/session-a.jsonl", "asst01ab", Date.now(), 0);
		insertMessageStats([stat]);
		const upgraded = { ...stat, usage: { ...stat.usage, premiumRequests: 1 } };
		insertMessageStats([upgraded]);

		const requests = getRecentRequests(10).filter(r => r.entryId === "asst01ab");
		expect(requests).toHaveLength(1);
		expect(requests[0].usage.premiumRequests).toBe(1);
	});
});
