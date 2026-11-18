import { describe, expect, it } from "bun:test";
import { getOverviewStats } from "@oh-my-pi/omp-stats/aggregator";
import { initDb, insertMessageStats } from "@oh-my-pi/omp-stats/db";
import { refreshRollups } from "@oh-my-pi/omp-stats/rollup";
import type { AgentType, DashboardStats, MessageStats, UsageAttributionTotals } from "@oh-my-pi/omp-stats/types";
import { installStatsTestIsolation } from "./helpers/temp-agent";

installStatsTestIsolation("@pi-stats-side-channels-");

/** One stored model call: an assistant turn without `purpose`, a `model_usage` row with one. */
function call(
	entryId: string,
	agentType: AgentType,
	tokens: number,
	purpose?: string,
	api = "anthropic-messages",
): MessageStats {
	return {
		sessionFile: `/tmp/${agentType}.jsonl`,
		entryId,
		folder: "/tmp/project",
		model: api === "typesafe" ? "jev-latest" : "claude-sonnet-4.5",
		provider: api === "typesafe" ? "typesafe" : "anthropic",
		api,
		timestamp: Date.now(),
		duration: 1000,
		ttft: 100,
		stopReason: "stop",
		errorMessage: null,
		usage: {
			input: tokens,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: tokens,
			cost: { input: 0.01, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 },
		},
		agentType,
		purpose,
	};
}

function requestsAndTokens(stat: UsageAttributionTotals): [requests: number, tokens: number] {
	return [
		stat.totalRequests,
		stat.totalInputTokens + stat.totalOutputTokens + stat.totalCacheReadTokens + stat.totalCacheWriteTokens,
	];
}

/** `[requests, tokens]` per agent type and per `category/served-by` group, order-independent. */
function attribution({ byAgentType, bySideChannel }: Pick<DashboardStats, "byAgentType" | "bySideChannel">) {
	return {
		agents: Object.fromEntries(byAgentType.map(stat => [stat.agentType, requestsAndTokens(stat)])),
		sideChannels: Object.fromEntries(
			bySideChannel.map(stat => [
				`${stat.category}/${stat.decision ? "decision" : "model"}`,
				requestsAndTokens(stat),
			]),
		),
	};
}

describe("usage attribution of side channels", () => {
	it("keeps side channels out of the agent shares and groups them by category and decision model", async () => {
		await initDb();
		insertMessageStats([
			call("turn-main", "main", 100),
			// Billed usage of a discarded assistant turn: journaled as model_usage, still a turn.
			call("turn-discarded", "main", 40, "discarded-turn"),
			call("turn-sub", "subagent", 30),
			// Two purposes of one category, one of them from a subagent transcript.
			call("title", "main", 10, "title"),
			call("title-drift", "subagent", 5, "title-drift"),
			// The same category on a native judgment api and on a language model.
			call("judge-decision", "main", 7, "judge", "typesafe"),
			call("judge-model", "main", 3, "judge"),
			call("unlisted", "main", 2, "my-extension"),
			call("suffixed", "main", 9, "cache-warm:extension-override"),
		]);
		const expected = {
			agents: { main: [2, 140], subagent: [1, 30] },
			sideChannels: {
				"title/model": [2, 15],
				"judge/decision": [1, 7],
				"judge/model": [1, 3],
				"my-extension/model": [1, 2],
				"cache/model": [1, 9],
			},
		};

		// Fresh rows are read raw from their dirty hour, then from the rollup once it is refreshed.
		expect(attribution(await getOverviewStats("all"))).toEqual(expected);
		await refreshRollups();
		expect(attribution(await getOverviewStats("all"))).toEqual(expected);
	});
});
