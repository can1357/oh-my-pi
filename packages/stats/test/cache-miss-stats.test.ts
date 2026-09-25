import { describe, expect, it } from "bun:test";
import { getCacheMissStats, initDb, insertMessageStats } from "@oh-my-pi/omp-stats/db";
import type { AgentType, MessageStats } from "@oh-my-pi/omp-stats/types";
import { installStatsTestIsolation } from "./helpers/temp-agent";

installStatsTestIsolation("@pi-stats-cache-miss-");

const T0 = Date.UTC(2026, 6, 20, 10, 0, 0);
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const INPUT_PRICE = 1e-6;
const CACHE_READ_PRICE = 1e-7;

interface RequestSpec {
	sessionFile: string;
	entryId: string;
	timestamp: number;
	input: number;
	cacheRead?: number;
	model?: string;
	provider?: string;
	stopReason?: MessageStats["stopReason"];
	agentType?: AgentType;
}

function request(spec: RequestSpec): MessageStats {
	const cacheRead = spec.cacheRead ?? 0;
	const costInput = spec.input * INPUT_PRICE;
	const costCacheRead = cacheRead * CACHE_READ_PRICE;
	return {
		sessionFile: spec.sessionFile,
		entryId: spec.entryId,
		folder: "/tmp/project",
		model: spec.model ?? "model-x",
		provider: spec.provider ?? "prov-a",
		api: "openai-completions",
		timestamp: spec.timestamp,
		duration: SECOND,
		ttft: 100,
		stopReason: spec.stopReason ?? "stop",
		errorMessage: spec.stopReason === "error" ? "boom" : null,
		usage: {
			input: spec.input,
			output: 100,
			cacheRead,
			cacheWrite: 0,
			totalTokens: spec.input + cacheRead + 100,
			cost: {
				input: costInput,
				output: 0.001,
				cacheRead: costCacheRead,
				cacheWrite: 0,
				total: costInput + costCacheRead + 0.001,
			},
		},
		agentType: spec.agentType ?? "main",
	};
}

const MAIN = "/tmp/project/main.jsonl";
const SUB = "/tmp/project/main/sub.jsonl";

// Timeline of the main session; each request lasts one second.
const R3 = T0 + 20 * SECOND;
const R4 = R3 + SECOND + 6 * MINUTE;

function seed(): void {
	insertMessageStats([
		// Warm pair, full hit: expected 10000, missed 0.
		request({ sessionFile: MAIN, entryId: "m1", timestamp: T0, input: 10_000 }),
		request({ sessionFile: MAIN, entryId: "m2", timestamp: T0 + 10 * SECOND, input: 500, cacheRead: 10_000 }),
		// Warm pair, nothing read: expected 10500, missed 10500 (bad turn).
		request({ sessionFile: MAIN, entryId: "m3", timestamp: R3, input: 11_000 }),
		// Idle 6 minutes: cache may have expired, excluded.
		request({ sessionFile: MAIN, entryId: "m4", timestamp: R4, input: 11_500 }),
		// Prompt shrank (compaction): excluded.
		request({ sessionFile: MAIN, entryId: "m5", timestamp: R4 + 10 * SECOND, input: 5_000 }),
		// Model switch: excluded.
		request({ sessionFile: MAIN, entryId: "m6", timestamp: R4 + 20 * SECOND, input: 6_000, model: "model-y" }),
		// Errored request: excluded as the later and as the earlier side.
		request({
			sessionFile: MAIN,
			entryId: "m7",
			timestamp: R4 + 30 * SECOND,
			input: 6_500,
			model: "model-y",
			stopReason: "error",
		}),
		request({ sessionFile: MAIN, entryId: "m8", timestamp: R4 + 40 * SECOND, input: 7_000, model: "model-y" }),
		// Small partial miss: expected 7000, missed 500 (counted, not bad).
		request({
			sessionFile: MAIN,
			entryId: "m9",
			timestamp: R4 + 50 * SECOND,
			input: 1_000,
			cacheRead: 6_500,
			model: "model-y",
		}),
		// Subagent interleaved in time with the main session: pairs stay per transcript.
		request({ sessionFile: SUB, entryId: "s1", timestamp: T0 + 5 * SECOND, input: 20_000, agentType: "subagent" }),
		// Expected 20000, missed 2000: under max(2048, 10%), so not a bad turn.
		request({
			sessionFile: SUB,
			entryId: "s2",
			timestamp: T0 + 15 * SECOND,
			input: 2_000,
			cacheRead: 18_000,
			agentType: "subagent",
		}),
	]);
}

describe("getCacheMissStats", () => {
	it("counts only warm same-model pairs and splits main from subagent", async () => {
		await initDb();
		seed();

		const stats = getCacheMissStats();

		expect(stats.map(s => [s.provider, s.agentType])).toEqual([
			["prov-a", "main"],
			["prov-a", "subagent"],
		]);
		const [main, sub] = stats;
		expect(main).toMatchObject({ pairs: 3, badPairs: 1, expectedTokens: 27_500, missedTokens: 11_000 });
		expect(main.missRate).toBeCloseTo(11_000 / 27_500, 10);
		expect(main.badPairRate).toBeCloseTo(1 / 3, 10);
		expect(main.avoidableCost).toBeCloseTo(11_000 * (INPUT_PRICE - CACHE_READ_PRICE), 12);

		expect(sub).toMatchObject({ pairs: 1, badPairs: 0, expectedTokens: 20_000, missedTokens: 2_000 });
		expect(sub.missRate).toBeCloseTo(0.1, 10);
		expect(sub.avoidableCost).toBeCloseTo(2_000 * (INPUT_PRICE - CACHE_READ_PRICE), 12);
	});

	it("skips models that never reported a cache read", async () => {
		await initDb();
		seed();
		// A warm, growing prompt with zero cache reads would be a full miss, but
		// the model has no cache at all, so there is nothing to miss.
		const noCache = { sessionFile: "/tmp/project/nocache.jsonl", provider: "prov-b", model: "model-z" };
		insertMessageStats([
			request({ ...noCache, entryId: "n1", timestamp: T0, input: 10_000 }),
			request({ ...noCache, entryId: "n2", timestamp: T0 + 10 * SECOND, input: 10_500 }),
		]);

		const stats = getCacheMissStats();

		expect(stats.map(s => s.provider)).toEqual(["prov-a", "prov-a"]);
	});

	it("selects pairs by the later request while pairing across the cutoff", async () => {
		await initDb();
		seed();

		// m2 precedes the cutoff but still anchors the m2 -> m3 miss; the
		// subagent pair and the m1 -> m2 pair fall before it.
		const stats = getCacheMissStats(T0 + 16 * SECOND);

		expect(stats).toHaveLength(1);
		expect(stats[0]).toMatchObject({
			agentType: "main",
			pairs: 2,
			badPairs: 1,
			expectedTokens: 17_500,
			missedTokens: 11_000,
		});
	});
});
