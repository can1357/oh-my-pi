import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getRecentRequests, initDb, insertMessageStats } from "@oh-my-pi/omp-stats/db";
import { parseSessionFile } from "@oh-my-pi/omp-stats/parser";
import { getConfigRootDir, getSessionsDir, getStatsDbPath } from "@oh-my-pi/pi-utils";
import { installStatsTestIsolation } from "./helpers/temp-agent";

installStatsTestIsolation("@pi-stats-git-branch-");

const T0 = Date.parse("2026-09-14T10:00:00.000Z");

function header(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		type: "session",
		version: 3,
		id: "s1",
		timestamp: new Date(T0).toISOString(),
		cwd: "/tmp/proj",
		...overrides,
	};
}

function assistantEntry(id: string, timestamp = T0): Record<string, unknown> {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: new Date(timestamp).toISOString(),
		message: {
			role: "assistant",
			content: [{ type: "text", text: "ok" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			stopReason: "stop",
			timestamp,
			usage: {
				input: 10,
				output: 5,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 15,
				cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 },
			},
		},
	};
}

function branchChangeEntry(id: string, gitBranch: string | null, timestamp = T0): Record<string, unknown> {
	return {
		type: "custom",
		id,
		parentId: null,
		timestamp: new Date(timestamp).toISOString(),
		customType: "git_branch",
		data: { gitBranch },
	};
}

async function writeSession(name: string, lines: Array<Record<string, unknown>>): Promise<string> {
	const dir = path.join(getSessionsDir(), "--tmp--git-branch");
	await fs.mkdir(dir, { recursive: true });
	const file = path.join(dir, name);
	await Bun.write(file, `${lines.map(line => JSON.stringify(line)).join("\n")}\n`);
	return file;
}

describe("git branch attribution", () => {
	it("stamps each request with the branch the session header recorded", async () => {
		const file = await writeSession("01.jsonl", [
			header({ gitBranch: "feat/branch-attribution" }),
			assistantEntry("a1"),
		]);

		const parsed = await parseSessionFile(file);
		expect(parsed.stats.map(stat => stat.gitBranch)).toEqual(["feat/branch-attribution"]);

		// Round trip through stats.db: the request list is where the branch is read.
		await initDb();
		expect(insertMessageStats(parsed.stats)).toBe(1);
		expect(getRecentRequests(1)[0]?.gitBranch).toBe("feat/branch-attribution");
	});

	it("follows git_branch entries, including across an incremental parse that resumes past them", async () => {
		// `main` at session start, switched to the feature branch mid-session.
		const file = await writeSession("02.jsonl", [
			header({ gitBranch: "main" }),
			assistantEntry("a1"),
			branchChangeEntry("b1", "feat/late-switch", T0 + 1000),
			assistantEntry("a2", T0 + 2000),
		]);

		const first = await parseSessionFile(file);
		expect(first.stats.map(stat => [stat.entryId, stat.gitBranch])).toEqual([
			["a1", "main"],
			["a2", "feat/late-switch"],
		]);

		// A reply lands after the sync advanced past both the header and the
		// switch; the parser must replay the prefix to stamp it correctly.
		await fs.appendFile(file, `${JSON.stringify(assistantEntry("a3", T0 + 3000))}\n`);
		const second = await parseSessionFile(file, first.newOffset);
		expect(second.stats.map(stat => [stat.entryId, stat.gitBranch])).toEqual([["a3", "feat/late-switch"]]);
	});

	it("records null for a session that names no branch", async () => {
		const file = await writeSession("03.jsonl", [header(), assistantEntry("a1")]);

		const parsed = await parseSessionFile(file);
		expect(parsed.stats.map(stat => stat.gitBranch)).toEqual([null]);
	});

	it("stores and returns the branch on a database that predates the column", async () => {
		// A stats.db from before this feature: `initDb` must add `git_branch` the
		// same way it adds every other late column, or every insert fails.
		await fs.mkdir(getConfigRootDir(), { recursive: true });
		const legacy = new Database(getStatsDbPath());
		legacy.run(`
			CREATE TABLE messages (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				session_file TEXT NOT NULL,
				entry_id TEXT NOT NULL,
				folder TEXT NOT NULL,
				model TEXT NOT NULL,
				provider TEXT NOT NULL,
				api TEXT NOT NULL,
				timestamp INTEGER NOT NULL,
				duration INTEGER,
				ttft INTEGER,
				stop_reason TEXT NOT NULL,
				error_message TEXT,
				input_tokens INTEGER NOT NULL,
				output_tokens INTEGER NOT NULL,
				cache_read_tokens INTEGER NOT NULL,
				cache_write_tokens INTEGER NOT NULL,
				total_tokens INTEGER NOT NULL,
				premium_requests REAL NOT NULL,
				cost_input REAL NOT NULL,
				cost_output REAL NOT NULL,
				cost_cache_read REAL NOT NULL,
				cost_cache_write REAL NOT NULL,
				cost_total REAL NOT NULL,
				UNIQUE(session_file, entry_id)
			);
		`);
		legacy.close();

		const file = await writeSession("04.jsonl", [header({ gitBranch: "fix/legacy-db" }), assistantEntry("a1")]);
		const parsed = await parseSessionFile(file);
		await initDb();
		expect(insertMessageStats(parsed.stats)).toBe(1);
		expect(getRecentRequests(1)[0]?.gitBranch).toBe("fix/legacy-db");
	});
});
