import { describe, expect, it } from "bun:test";
import { initDb, insertMessageStats } from "@oh-my-pi/omp-stats/db";
import { getOverallStats, getStatsByProvider, refreshRollups } from "@oh-my-pi/omp-stats/rollup";
import type { MessageStats } from "@oh-my-pi/omp-stats/types";
import { installStatsTestIsolation } from "./helpers/temp-agent";

installStatsTestIsolation("@pi-stats-ai-credits-");

const HOUR = 60 * 60 * 1000;
const BASE = Math.floor(Date.now() / HOUR) * HOUR - 5 * HOUR;

function message(
	entryId: string,
	provider: string,
	usage: Partial<MessageStats["usage"]> = {},
	timestamp = BASE + 10 * 60_000,
): MessageStats {
	return {
		sessionFile: `/tmp/${entryId}.jsonl`,
		entryId,
		folder: "/work/a",
		model: "model-x",
		provider,
		api: "openai-responses",
		timestamp,
		duration: 2000,
		ttft: 300,
		stopReason: "stop",
		errorMessage: null,
		usage: {
			input: 100,
			output: 40,
			cacheRead: 60,
			cacheWrite: 0,
			totalTokens: 200,
			cost: { input: 0.01, output: 0.02, cacheRead: 0.001, cacheWrite: 0, total: 0.031 },
			...usage,
		},
		agentType: "main",
	};
}

describe("AI credits in stats", () => {
	it("reports no total, not zero, until a request carries a billing frame; live and rolled totals agree", async () => {
		await initDb();
		insertMessageStats([message("a", "openai-codex"), message("b", "github-copilot")]);
		expect(getOverallStats(null).totalAiuNano).toBeNull();

		insertMessageStats([message("c", "github-copilot", { aiu: { nano: 436_590_000 } }, BASE + 20 * 60_000)]);
		insertMessageStats([message("d", "github-copilot", { aiu: { nano: 6_790_000 } }, BASE + 30 * 60_000)]);
		const live = getOverallStats(null).totalAiuNano;
		expect(live).toBe(443_380_000);

		await refreshRollups();
		expect(getOverallStats(null).totalAiuNano).toBe(live);
		const byProvider = new Map(getStatsByProvider(null).map(p => [p.provider, p.totalAiuNano]));
		expect(byProvider.get("github-copilot")).toBe(443_380_000);
		expect(byProvider.get("openai-codex")).toBeNull();
	});

	it("stores a malformed charge as unknown, apart from the premium count", async () => {
		await initDb();
		const malformed = [Number.NaN, -1, "12" as unknown as number];
		insertMessageStats(
			malformed.map((nano, index) =>
				message(
					`bad${index}`,
					"github-copilot",
					{ premiumRequests: 1, aiu: { nano } },
					BASE + (40 + index) * 60_000,
				),
			),
		);
		expect(getOverallStats(null)).toMatchObject({ totalAiuNano: null, totalPremiumRequests: 3 });
	});
});
