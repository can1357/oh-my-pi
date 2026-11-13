import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { syncAllSessions } from "@oh-my-pi/omp-stats/aggregator";
import { initDb, insertMessageStats } from "@oh-my-pi/omp-stats/db";
import { dedupeProjects, getGainDashboardStats, normalizeProjectPath } from "@oh-my-pi/omp-stats/gain-aggregator";
import type { MessageStats } from "@oh-my-pi/omp-stats/types";
import { getSessionsDir, getStatsDbPath } from "@oh-my-pi/pi-utils";
import { installStatsTestIsolation } from "./helpers/temp-agent";

installStatsTestIsolation("@pi-stats-gain-");

function makeMessage(sessionFile: string, folder: string, entryId: string, timestamp: number): MessageStats {
	return {
		sessionFile,
		entryId,
		folder,
		model: "gpt-5.4",
		provider: "openai-codex",
		api: "openai-codex-responses",
		timestamp,
		duration: 1000,
		ttft: 100,
		stopReason: "stop",
		errorMessage: null,
		usage: {
			input: 1000,
			output: 500,
			cacheRead: 200,
			cacheWrite: 0,
			totalTokens: 1700,
			cost: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				total: 0,
			},
		},
		agentType: "main",
	};
}

async function writeSnapcompactJournal(records: unknown[]): Promise<void> {
	const journalPath = path.join(path.dirname(getStatsDbPath()), "snapcompact-savings.jsonl");
	await fs.mkdir(path.dirname(journalPath), { recursive: true });
	await Bun.write(journalPath, `${records.map(record => JSON.stringify(record)).join("\n")}\n`);
}

async function writeSession(fileName: string, entries: unknown[]): Promise<string> {
	const sessionDir = path.join(getSessionsDir(), "--Users--me--Code--foo");
	await fs.mkdir(sessionDir, { recursive: true });
	const sessionFile = path.join(sessionDir, fileName);
	const header = { type: "session", version: 3, id: fileName, timestamp: "2026-11-01T00:00:00.000Z", cwd: "/" };
	await Bun.write(sessionFile, `${[header, ...entries].map(entry => JSON.stringify(entry)).join("\n")}\n`);
	return sessionFile;
}

function compactionEntry(id: string, method: string, tokensBefore: number, tokensAfter: number) {
	return {
		type: "compaction",
		id,
		parentId: null,
		timestamp: "2026-11-01T12:00:00.000Z",
		summary: "archived",
		firstKeptEntryId: "kept",
		tokensBefore,
		tokensAfter,
		method,
	};
}

describe("gain project normalization", () => {
	it("normalizes conventional worktree paths without author-specific path rules", () => {
		expect(normalizeProjectPath("/Users/me/Code/app/.worktrees/lane/packages/stats")).toBe("/Users/me/Code/app");
		expect(normalizeProjectPath("/Users/me/Code/app-wt/lane/packages/stats")).toBe("/Users/me/Code/app");
		expect(normalizeProjectPath("/Users/me/IDEProjects/app")).toBe("/Users/me/IDEProjects/app");
		expect(normalizeProjectPath("/Users/me/tool/worktrees/app/packages/stats")).toBe(
			"/Users/me/tool/worktrees/app/packages/stats",
		);
		expect(normalizeProjectPath("/tmp/pi-bash-exec/session")).toBeNull();
	});

	it("dedupes normalized project roots with separator-aware parent matching", () => {
		expect(
			dedupeProjects(
				new Set([
					"/Users/me/Code/foo",
					"/Users/me/Code/foo/packages/stats",
					"/Users/me/Code/foobar",
					"/Users/me/Code/foo/.worktrees/lane/src",
				]),
			),
		).toEqual(["/Users/me/Code/foo", "/Users/me/Code/foobar"]);
	});
});

describe("getGainDashboardStats", () => {
	it("scopes snapcompact records by selected project and keeps path prefixes separator-aware", async () => {
		await initDb();
		const now = Date.now();
		const sessionFoo = "/tmp/foo.jsonl";
		const sessionFooWorktree = "/tmp/foo-worktree.jsonl";
		const sessionFoobar = "/tmp/foobar.jsonl";
		const sessionOld = "/tmp/old.jsonl";

		insertMessageStats([
			makeMessage(sessionFoo, "/Users/me/Code/foo", "foo", now),
			makeMessage(sessionFooWorktree, "/Users/me/Code/foo/.worktrees/lane/packages/stats", "foo-worktree", now),
			makeMessage(sessionFoobar, "/Users/me/Code/foobar", "foobar", now),
			makeMessage(sessionOld, "/Users/me/Code/foo", "old", now - 48 * 60 * 60 * 1000),
		]);
		await writeSnapcompactJournal([
			{ ts: now, session: sessionFoo, provider: "openai", model: "gpt", toolCallId: "a", savedTokens: 100 },
			{ ts: now, session: sessionFooWorktree, provider: "openai", model: "gpt", toolCallId: "b", savedTokens: 50 },
			{ ts: now, session: sessionFoobar, provider: "openai", model: "gpt", toolCallId: "c", savedTokens: 200 },
			{ ts: now, session: sessionFoobar, provider: "openai", model: "gpt", toolCallId: "c", savedTokens: 999 },
			{
				ts: now - 48 * 60 * 60 * 1000,
				session: sessionOld,
				provider: "openai",
				model: "gpt",
				toolCallId: "old",
				savedTokens: 500,
			},
		]);

		const allStats = await getGainDashboardStats("24h");
		expect(allStats.overall.savedTokens).toBe(350);
		expect(allStats.overall.savedBytes).toBe(1400);
		expect(allStats.overall.hits).toBe(3);
		expect(allStats.overall.reductionPercent).toBeNull();
		expect(allStats.projects).toEqual(["/Users/me/Code/foo", "/Users/me/Code/foobar"]);

		const fooStats = await getGainDashboardStats("24h", "/Users/me/Code/foo");
		expect(fooStats.overall.savedTokens).toBe(150);
		expect(fooStats.bySource.snapcompact.hits).toBe(2);
		expect(fooStats.timeSeries).toEqual([
			{ date: new Date(now).toISOString().slice(0, 10), snapcompact: 150, compaction: 0, total: 150 },
		]);

		const foobarStats = await getGainDashboardStats("24h", "/Users/me/Code/foobar");
		expect(foobarStats.overall.savedTokens).toBe(200);
		expect(foobarStats.bySource.snapcompact.hits).toBe(1);
	});

	it("counts the context snapcompact compactions freed, once per entry across forks and rewrites", async () => {
		const entries = [compactionEntry("c1", "snapcompact", 1000, 400), compactionEntry("c2", "soft", 1000, 100)];
		const parent = await writeSession("01_parent.jsonl", entries);
		await writeSession("02_fork.jsonl", entries);
		await syncAllSessions({ workers: 1 });

		const stats = await getGainDashboardStats("all");
		expect(stats.bySource.compaction).toMatchObject({ savedTokens: 600, hits: 1, reductionPercent: 0.6 });
		expect(stats.overall.reductionPercent).toBe(0.6);
		expect(stats.timeSeries).toEqual([{ date: "2026-11-01", snapcompact: 0, compaction: 600, total: 600 }]);
		expect(stats.projects).toEqual(["/Users/me/Code/foo"]);
		expect((await getGainDashboardStats("all", "/Users/me/Code/bar")).overall.savedTokens).toBe(0);

		// The session rewrites an entry in place when a rescue re-projects its tokensAfter.
		await Bun.write(parent, (await Bun.file(parent).text()).replace('"tokensAfter":400', '"tokensAfter":500'));
		await syncAllSessions({ workers: 1 });
		expect((await getGainDashboardStats("all")).bySource.compaction.savedTokens).toBe(500);

		// A parent that drops the entry hands it to the fork still holding the original.
		await writeSession("01_parent.jsonl", [entries[1]]);
		await syncAllSessions({ workers: 1 });
		expect((await getGainDashboardStats("all")).bySource.compaction.savedTokens).toBe(600);
	});
});
