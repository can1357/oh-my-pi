/**
 * Contract: agent rows (inline task block and subagent HUD) share one stats
 * formatter. Prompt/output volume, cache hit rate, and output rate appear once
 * the usage breakdown exists; the ETA is derived only from finished peers of
 * the same agent type — no peer, no estimate — and flips to `<dur> over` once
 * the agent outlives the peer median.
 */
import type { RenderResultOptions } from "@oh-my-pi/pi-agent-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { getThemeByName, type Theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import {
	agentStatParts,
	estimateAgentEtaMs,
	formatCacheHitRate,
	formatEta,
	formatOutputRate,
	shortModelLabel,
} from "@oh-my-pi/pi-coding-agent/task/render";
import { taskToolRenderer } from "@oh-my-pi/pi-coding-agent/task/renderer";
import type { AgentProgress, SingleResult, TaskToolDetails } from "@oh-my-pi/pi-coding-agent/task/types";

function progress(overrides: Partial<AgentProgress> & { id: string }): AgentProgress {
	return {
		index: 0,
		agent: "scout",
		agentSource: "bundled",
		status: "running",
		task: "inspect",
		recentTools: [],
		recentOutput: [],
		toolCount: 0,
		requests: 0,
		tokens: 0,
		cost: 0,
		durationMs: 0,
		...overrides,
	};
}

function renderRows(rows: AgentProgress[]): string {
	const details: TaskToolDetails = { projectAgentsDir: null, results: [], totalDurationMs: 0, progress: rows };
	const options: RenderResultOptions = { expanded: false, isPartial: true, spinnerFrame: 0 };
	return Bun.stripANSI(
		taskToolRenderer
			.renderResult({ content: [{ type: "text", text: "" }], details }, options, theme)
			.render(160)
			.join("\n"),
	);
}

function renderResults(results: SingleResult[]): string {
	const details: TaskToolDetails = { projectAgentsDir: null, results, totalDurationMs: 0 };
	const options: RenderResultOptions = { expanded: false, isPartial: false, spinnerFrame: 0 };
	return Bun.stripANSI(
		taskToolRenderer
			.renderResult({ content: [{ type: "text", text: "" }], details }, options, theme)
			.render(160)
			.join("\n"),
	);
}

let theme: Theme;

describe("agent stat formatters", () => {
	beforeEach(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
		theme = (await getThemeByName("dark"))!;
	});
	afterEach(() => {
		vi.restoreAllMocks();
		resetSettingsForTest();
	});

	it("formats output rate only once measurable", () => {
		expect(formatOutputRate(undefined, undefined)).toBeUndefined();
		expect(formatOutputRate(100, 0)).toBeUndefined();
		expect(formatOutputRate(0, 5_000)).toBeUndefined();
		expect(formatOutputRate(4_200, 100_000)).toBe("42 tok/s");
		expect(formatOutputRate(75, 10_000)).toBe("7.5 tok/s");
	});

	it("formats cache hit rate over the full prompt volume", () => {
		expect(formatCacheHitRate({})).toBeUndefined();
		expect(formatCacheHitRate({ inputTokens: 100, cacheReadTokens: 900, cacheWriteTokens: 0 })).toBe("cache 90%");
		expect(formatCacheHitRate({ inputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 50 })).toBe("cache 0%");
	});

	it("derives the eta from finished peers of the same agent type only", () => {
		const me = progress({ id: "Me", agent: "scout", durationMs: 30_000 });
		const peers = [
			me,
			progress({ id: "A", agent: "scout", status: "completed", durationMs: 60_000 }),
			progress({ id: "B", agent: "scout", status: "completed", durationMs: 100_000 }),
			progress({ id: "C", agent: "scout", status: "completed", durationMs: 80_000 }),
			// Wrong type, still running, and failed peers are not evidence.
			progress({ id: "D", agent: "task", status: "completed", durationMs: 1 }),
			progress({ id: "E", agent: "scout", status: "running", durationMs: 500_000 }),
			progress({ id: "F", agent: "scout", status: "failed", durationMs: 5 }),
		];
		expect(estimateAgentEtaMs(me, peers)).toBe(50_000);
		expect(estimateAgentEtaMs(me, [me])).toBeUndefined();
		expect(estimateAgentEtaMs({ ...me, durationMs: 90_000 }, peers)).toBe(-10_000);
	});

	it("falls back to cross-session history only when no peer of the type has finished", () => {
		const me = progress({ id: "Me", agent: "scout", durationMs: 30_000 });
		const peer = progress({ id: "A", agent: "scout", status: "completed", durationMs: 60_000 });
		expect(estimateAgentEtaMs(me, [me], 30_000, [200_000, 100_000, 150_000])).toBe(120_000);
		expect(estimateAgentEtaMs(me, [me, peer], 30_000, [200_000, 100_000, 150_000])).toBe(30_000);
		expect(estimateAgentEtaMs(me, [me], 30_000, [0, -5])).toBeUndefined();
	});

	it("formats the eta as a countdown or an overrun, never fabricating one", () => {
		expect(formatEta(undefined)).toBeUndefined();
		expect(formatEta(50_000)).toBe("eta ~50.0s");
		expect(formatEta(200)).toBe("eta ~1.0s");
		expect(formatEta(-90_000)).toBe("1m30s over");
	});

	it("strips the provider from a model selector", () => {
		expect(shortModelLabel("anthropic/claude-fable-5-1:high")).toBe("claude-fable-5-1:high");
		expect(shortModelLabel("local-model")).toBe("local-model");
	});

	it("emits volume, cache, rate, and eta fragments in display order", () => {
		const parts = agentStatParts(
			{
				requests: 3,
				inputTokens: 100,
				outputTokens: 4_200,
				cacheReadTokens: 900,
				cacheWriteTokens: 0,
				generationMs: 100_000,
				cost: 0.5,
				etaMs: 30_000,
			},
			theme,
		).map(part => Bun.stripANSI(part));
		expect(parts).toEqual(["3 req", "↑1K ↓4.2K", "cache 90%", "42 tok/s", "$0.50", "eta ~30.0s"]);
		expect(agentStatParts({ cost: 0 }, theme)).toEqual([]);
	});

	it("shows live usage and a peer-derived eta on running inline rows", () => {
		const rows = [
			progress({ id: "Done", status: "completed", durationMs: 60_000, requests: 4 }),
			progress({
				id: "Live",
				description: "reading configs",
				durationMs: 20_000,
				requests: 2,
				inputTokens: 200,
				outputTokens: 500,
				cacheReadTokens: 1_800,
				cacheWriteTokens: 0,
				generationMs: 10_000,
			}),
		];
		const out = renderRows(rows);
		const liveRow = out.split("\n").find(line => line.includes("Live"));
		expect(liveRow).toContain("↑2K ↓500");
		expect(liveRow).toContain("cache 90%");
		expect(liveRow).toContain("50 tok/s");
		expect(liveRow).toContain("eta ~40.0s");
		// A lone running agent has no finished peer: no eta is invented.
		const alone = renderRows([rows[1]])
			.split("\n")
			.find(line => line.includes("Live"));
		expect(alone).not.toContain("eta");
	});

	it("retains usage and effective output rate on completed rows", () => {
		const result: SingleResult = {
			index: 0,
			id: "Done",
			agent: "scout",
			agentSource: "bundled",
			task: "inspect",
			exitCode: 0,
			output: "done",
			stderr: "",
			truncated: false,
			durationMs: 20_000,
			generationMs: 10_000,
			tokens: 700,
			requests: 2,
			usage: {
				input: 200,
				output: 500,
				cacheRead: 1_800,
				cacheWrite: 0,
				totalTokens: 2_500,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		};
		const row = renderResults([result])
			.split("\n")
			.find(line => line.includes("Done"));
		expect(row).toContain("↑2K ↓500");
		expect(row).toContain("cache 90%");
		expect(row).toContain("50 tok/s");
		expect(row).toContain("20.0s");
	});
});
