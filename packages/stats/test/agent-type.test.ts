import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getOverviewStats } from "@oh-my-pi/omp-stats/aggregator";
import { getStatsByAgentType, initDb, insertMessageStats } from "@oh-my-pi/omp-stats/db";
import { classifyAgentType } from "@oh-my-pi/omp-stats/parser";
import type { AgentType, MessageStats } from "@oh-my-pi/omp-stats/types";
import { getConfigRootDir, getSessionsDir, getStatsDbPath } from "@oh-my-pi/pi-utils";
import { installStatsTestIsolation } from "./helpers/temp-agent";

installStatsTestIsolation("@pi-stats-agent-type-");

interface Tokens {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

function makeMessage(entryId: string, agentType: AgentType, tokens: Tokens): MessageStats {
	return {
		sessionFile: `/tmp/${agentType}.jsonl`,
		entryId,
		folder: "/tmp/project",
		model: "claude-sonnet-4.5",
		provider: "anthropic",
		api: "anthropic-messages",
		timestamp: Date.now(),
		duration: 1000,
		ttft: 100,
		stopReason: "stop",
		errorMessage: null,
		usage: {
			input: tokens.input,
			output: tokens.output,
			cacheRead: tokens.cacheRead,
			cacheWrite: tokens.cacheWrite,
			totalTokens: tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite,
			cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 },
		},
		agentType,
	};
}

describe("classifyAgentType", () => {
	it("classifies transcripts by their location inside the session directory", () => {
		const project = path.join(getSessionsDir(), "--work--pi");
		const session = path.join(project, "1700000000000_abc");

		expect(classifyAgentType(path.join(project, "1700000000000_abc.jsonl"))).toBe("main");
		expect(classifyAgentType(path.join(session, "AuthLoader.jsonl"))).toBe("subagent");
		expect(classifyAgentType(path.join(session, "__advisor.jsonl"))).toBe("advisor");
		// A subagent's own advisor still counts as advisor, however deep it nests.
		expect(classifyAgentType(path.join(session, "AuthLoader", "__advisor.jsonl"))).toBe("advisor");
		// A subagent that spawned its own subagent is still a subagent.
		expect(classifyAgentType(path.join(session, "AuthLoader", "Nested.jsonl"))).toBe("subagent");
		// Named (multi-advisor) transcripts `__advisor.<slug>.jsonl` also count as advisor.
		expect(classifyAgentType(path.join(session, "__advisor.arch.jsonl"))).toBe("advisor");
		expect(classifyAgentType(path.join(session, "AuthLoader", "__advisor.security.jsonl"))).toBe("advisor");
		// `__advisor-2.jsonl` (output-manager bump namespace) is NOT an advisor transcript.
		expect(classifyAgentType(path.join(session, "__advisor-2.jsonl"))).toBe("subagent");
	});
});

describe("getStatsByAgentType", () => {
	it("groups token usage and requests by agent type", async () => {
		await initDb();
		insertMessageStats([
			makeMessage("m1", "main", { input: 100, output: 50, cacheRead: 10, cacheWrite: 0 }),
			makeMessage("m2", "main", { input: 100, output: 50, cacheRead: 10, cacheWrite: 0 }),
			makeMessage("s1", "subagent", { input: 40, output: 20, cacheRead: 0, cacheWrite: 0 }),
			makeMessage("a1", "advisor", { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 }),
		]);

		const byType = new Map(getStatsByAgentType().map(stat => [stat.agentType, stat]));
		expect(byType.get("main")).toMatchObject({
			totalRequests: 2,
			totalInputTokens: 200,
			totalOutputTokens: 100,
			totalCacheReadTokens: 20,
		});
		expect(byType.get("subagent")).toMatchObject({ totalRequests: 1, totalInputTokens: 40 });
		expect(byType.get("advisor")).toMatchObject({ totalRequests: 1, totalOutputTokens: 5 });
	});

	it("surfaces the breakdown through the overview payload", async () => {
		await initDb();
		insertMessageStats([
			makeMessage("m1", "main", { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 }),
			makeMessage("a1", "advisor", { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 }),
		]);

		const overview = await getOverviewStats("all");
		const types = overview.byAgentType.map(stat => stat.agentType).sort();
		expect(types).toEqual(["advisor", "main"]);
	});
});

describe("agent_type migration backfill", () => {
	it("adds the column and reclassifies legacy rows by transcript path on init", async () => {
		const project = path.join(getSessionsDir(), "--work--pi");
		const session = path.join(project, "1700000000000_abc");
		const mainFile = path.join(project, "1700000000000_abc.jsonl");
		const subFile = path.join(session, "AuthLoader.jsonl");
		const advisorFile = path.join(session, "__advisor.jsonl");

		// Construct a pre-agent_type database: the messages schema as it existed
		// before this feature, with rows defaulting to no classification.
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
		const insert = legacy.prepare(`
			INSERT INTO messages (
				session_file, entry_id, folder, model, provider, api, timestamp,
				duration, ttft, stop_reason, error_message,
				input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, total_tokens, premium_requests,
				cost_input, cost_output, cost_cache_read, cost_cache_write, cost_total
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`);
		for (const [index, file] of [mainFile, subFile, advisorFile].entries()) {
			insert.run(
				file,
				`e${index + 1}`,
				"/work/pi",
				"claude-sonnet-4.5",
				"anthropic",
				"anthropic-messages",
				Date.now(),
				1000,
				100,
				"stop",
				null,
				100,
				50,
				0,
				0,
				150,
				0,
				0.01,
				0.02,
				0,
				0,
				0.03,
			);
		}
		legacy.close();

		await initDb();

		const byType = new Map(getStatsByAgentType().map(stat => [stat.agentType, stat.totalRequests]));
		expect(byType.get("main")).toBe(1);
		expect(byType.get("subagent")).toBe(1);
		expect(byType.get("advisor")).toBe(1);
	});
});
