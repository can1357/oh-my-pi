import { beforeEach, describe, expect, it } from "bun:test";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { getSessionSummaries, initDb, insertMessageStats } from "@oh-my-pi/omp-stats/db";
import type { MessageStats } from "@oh-my-pi/omp-stats/types";
import { installStatsTestIsolation } from "./helpers/temp-agent";

installStatsTestIsolation("@pi-stats-summaries-");

function makeStats(
	entryId: string,
	sessionFile: string,
	input: number,
	output: number,
	cacheRead: number,
): MessageStats {
	return {
		sessionFile,
		entryId,
		folder: "/tmp/project",
		model: "gpt-5.4",
		provider: "openai-codex",
		api: "openai-codex-responses",
		timestamp: Date.now(),
		duration: 1000,
		ttft: 100,
		stopReason: "stop",
		errorMessage: null,
		usage: {
			input,
			output,
			cacheRead,
			cacheWrite: 0,
			totalTokens: input + output + cacheRead,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		agentType: "main",
	};
}

describe("stats getSessionSummaries", () => {
	beforeEach(async () => {
		await initDb();
	});

	it("aggregates per-session requests and tokens", async () => {
		const fileA = "/tmp/session-a.jsonl";
		const fileB = "/tmp/session-b.jsonl";
		await insertMessageStats([
			makeStats("e1", fileA, 1000, 500, 200),
			makeStats("e2", fileA, 1000, 500, 200),
			makeStats("e3", fileB, 200, 100, 50),
		]);

		const summaries = getSessionSummaries();
		const byFile = new Map(summaries.map(s => [s.sessionFile, s]));

		expect(byFile.get(fileA)?.requests).toBe(2);
		expect(byFile.get(fileA)?.inputTokens).toBe(2000);
		expect(byFile.get(fileA)?.outputTokens).toBe(1000);
		expect(byFile.get(fileA)?.cacheRead).toBe(400);
		expect(byFile.get(fileB)?.requests).toBe(1);
		expect(byFile.get(fileB)?.inputTokens).toBe(200);
		expect(byFile.get(fileB)?.outputTokens).toBe(100);
	});

	it("computes cost from catalog pricing", async () => {
		const fileA = "/tmp/session-cost-a.jsonl";
		const input = 1000;
		const output = 500;
		const cacheRead = 200;
		await insertMessageStats([makeStats("e1", fileA, input, output, cacheRead)]);

		const modelCost = getBundledModel("openai-codex", "gpt-5.4").cost;
		const expectedCost =
			(modelCost.input / 1_000_000) * input +
			(modelCost.output / 1_000_000) * output +
			(modelCost.cacheRead / 1_000_000) * cacheRead;

		const summary = getSessionSummaries().find(s => s.sessionFile === fileA);
		expect(summary).toBeDefined();
		expect(summary!.cost).toBeCloseTo(expectedCost, 6);
	});

	it("respects the cutoff (excludes future-timestamped queries)", async () => {
		const fileA = "/tmp/session-cutoff-a.jsonl";
		await insertMessageStats([makeStats("e1", fileA, 1000, 500, 200)]);

		expect(getSessionSummaries(Date.now() + 60_000).length).toBe(0);
		expect(getSessionSummaries(undefined).length).toBe(1);
		expect(getSessionSummaries(0).length).toBe(1);
	});
});
