import { describe, expect, it, spyOn } from "bun:test";
import * as path from "node:path";
import { getSessionsDir } from "@oh-my-pi/pi-utils";
import { getContextOverview } from "../src/context";
import { initDb, insertMessageStats } from "../src/db";
import { handleApi } from "../src/server";
import type { ContextOverview, TimeRange } from "../src/shared-types";
import type { MessageStatsInput } from "../src/types";
import { installStatsTestIsolation } from "./helpers/temp-agent";

installStatsTestIsolation("@pi-stats-context-overview-");

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

function message(
	file: string,
	entryId: string,
	timestamp: number,
	input = 100,
	model = "model-a",
	provider = "test-provider",
): MessageStatsInput {
	return {
		sessionFile: file,
		entryId,
		folder: "/work/project",
		model,
		provider,
		api: "openai-responses",
		timestamp,
		duration: 1000,
		ttft: 100,
		stopReason: "stop",
		errorMessage: null,
		agentType: "main",
		usage: {
			input,
			output: 10,
			cacheRead: 20,
			cacheWrite: 30,
			totalTokens: input + 60,
		},
	};
}

function sessionFile(name: string): string {
	return path.join(getSessionsDir(), "--work--project", `${name}.jsonl`);
}

describe("context overview", () => {
	it("excludes transcripts whose normalized path escapes the sessions root", async () => {
		await initDb();
		const now = Date.now();
		const inside = sessionFile("inside");
		const traversal = `${getSessionsDir()}${path.sep}project${path.sep}..${path.sep}..${path.sep}outside.jsonl`;
		const dotPrefixed = `${getSessionsDir()}${path.sep}.${path.sep}outside.jsonl`;
		insertMessageStats([
			message(inside, "inside", now - HOUR_MS, 100),
			message(traversal, "escape", now - HOUR_MS, 10000),
			message(dotPrefixed, "dot", now - HOUR_MS, 20000),
		]);

		const overview = await getContextOverview("24h");
		expect(overview.kpi.sessions).toBe(1);
		expect(overview.kpi.requests).toBe(1);
		expect(overview.kpi.totalTokens).toBe(160);
		expect(overview.sessions.map(row => row.file)).toEqual([inside]);
	});

	it("normalizes dot segments in-root without rejecting dot-named projects", async () => {
		await initDb();
		const now = Date.now();
		const prefix = `${getSessionsDir()}${path.sep}`;
		const combined = `${prefix}project${path.sep}a${path.sep}..${path.sep}b.jsonl`;
		const dotted = `${prefix}project${path.sep}.${path.sep}c.jsonl`;
		const literal = `${prefix}...${path.sep}literal.jsonl`;
		const hidden = `${prefix}.hidden${path.sep}h.jsonl`;
		insertMessageStats([
			message(combined, "combined", now - HOUR_MS, 100),
			message(dotted, "dotted", now - HOUR_MS, 200),
			message(literal, "literal", now - HOUR_MS, 300),
			message(hidden, "hidden", now - HOUR_MS, 400),
		]);

		const overview = await getContextOverview("24h");
		expect(overview.kpi.requests).toBe(4);
		expect(overview.sessions.map(row => row.file).sort()).toEqual(
			[
				path.join(prefix, "...", "literal.jsonl"),
				path.join(prefix, ".hidden", "h.jsonl"),
				path.join(prefix, "project", "b.jsonl"),
				path.join(prefix, "project", "c.jsonl"),
			].sort(),
		);
	});

	it("uses range activity and folds child requests into their root", async () => {
		await initDb();
		const now = Date.now();
		const root = sessionFile("root");
		const second = sessionFile("second");
		const child = path.join(getSessionsDir(), "--work--project", "root", "task", "child.jsonl");
		insertMessageStats([
			message(root, "old", now - 2 * DAY_MS, 10000, "old-model"),
			message(root, "recent", now - 2 * HOUR_MS, 100),
			message(child, "child", now - HOUR_MS, 200, "model-b"),
			message(second, "second", now - 3 * HOUR_MS, 300),
		]);

		const overview = await getContextOverview("24h");
		expect(overview.range).toBe("24h");
		expect(overview.cutoff).toBeGreaterThanOrEqual(now - DAY_MS);
		expect(overview.heatmapBucketMs).toBe(HOUR_MS);
		expect(overview.kpi).toEqual({
			sessions: 2,
			requests: 3,
			avgPromptTokens: 250,
			peakPromptTokens: 350,
			totalTokens: 780,
			promptTokens: 750,
			inputTokens: 600,
			outputTokens: 30,
			cacheReadTokens: 60,
			cacheWriteTokens: 90,
			cacheRate: 60 / 660,
			costTotal: 0,
			unpricedRequests: 0,
		});
		expect(overview.sessions).toEqual([
			{
				file: root,
				folder: "/work/project",
				title: null,
				models: ["model-a", "model-b"],
				startedAt: now - 2 * HOUR_MS,
				endedAt: now - HOUR_MS,
				requests: 2,
				totalTokens: 420,
				promptTokens: 400,
				peakPromptTokens: 250,
				avgPromptTokens: 200,
				inputTokens: 300,
				outputTokens: 20,
				cacheReadTokens: 40,
				cacheWriteTokens: 60,
				costTotal: 0,
				unpricedRequests: 0,
				sparkline: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 150, 250],
			},
			{
				file: second,
				folder: "/work/project",
				title: null,
				models: ["model-a"],
				startedAt: now - 3 * HOUR_MS,
				endedAt: now - 3 * HOUR_MS,
				requests: 1,
				totalTokens: 360,
				promptTokens: 350,
				peakPromptTokens: 350,
				avgPromptTokens: 350,
				inputTokens: 300,
				outputTokens: 10,
				cacheReadTokens: 20,
				cacheWriteTokens: 30,
				costTotal: 0,
				unpricedRequests: 0,
				sparkline: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 350, 0],
			},
		]);
		expect(overview.heatmap).toEqual([
			{
				bucket: Math.floor((now - 3 * HOUR_MS) / HOUR_MS) * HOUR_MS,
				requests: 1,
				promptTokens: 350,
				outputTokens: 10,
				totalTokens: 360,
				costTotal: 0,
				unpricedRequests: 0,
			},
			{
				bucket: Math.floor((now - 2 * HOUR_MS) / HOUR_MS) * HOUR_MS,
				requests: 1,
				promptTokens: 150,
				outputTokens: 10,
				totalTokens: 160,
				costTotal: 0,
				unpricedRequests: 0,
			},
			{
				bucket: Math.floor((now - HOUR_MS) / HOUR_MS) * HOUR_MS,
				requests: 1,
				promptTokens: 250,
				outputTokens: 10,
				totalTokens: 260,
				costTotal: 0,
				unpricedRequests: 0,
			},
		]);
		expect(overview.models).toEqual([
			{ model: "model-a", requests: 2, promptTokens: 500, totalTokens: 520, costTotal: 0, unpricedRequests: 0 },
			{ model: "model-b", requests: 1, promptTokens: 250, totalTokens: 260, costTotal: 0, unpricedRequests: 0 },
		]);
		expect(overview.omittedSessions).toBe(0);
		expect(overview.omittedRequests).toBe(0);
		expect(overview.omittedPromptTokens).toBe(0);
	});

	it("caps roots by range activity and reports all omitted request and prompt totals", async () => {
		await initDb();
		const now = Date.now();
		insertMessageStats([
			...Array.from({ length: 202 }, (_, index) =>
				message(sessionFile(`root-${index}`), `request-${index}`, now - (index + 1) * 60_000, index + 1),
			),
			message(
				path.join(getSessionsDir(), "--work--project", "root-201", "child.jsonl.gz"),
				"omitted-child",
				now - 203 * 60_000,
				400,
			),
		]);
		const overview = await getContextOverview("24h");
		expect(overview.sessions).toHaveLength(200);
		expect(overview.sessions[0].file).toBe(sessionFile("root-0"));
		expect(overview.sessions.at(-1)?.file).toBe(sessionFile("root-199"));
		expect(overview.omittedSessions).toBe(2);
		expect(overview.omittedRequests).toBe(3);
		expect(overview.omittedPromptTokens).toBe(953);
		expect(overview.kpi).toEqual({
			sessions: 202,
			requests: 203,
			avgPromptTokens: 31053 / 203,
			peakPromptTokens: 450,
			totalTokens: 33083,
			promptTokens: 31053,
			inputTokens: 20903,
			outputTokens: 2030,
			cacheReadTokens: 4060,
			cacheWriteTokens: 6090,
			cacheRate: 4060 / (20903 + 4060),
			costTotal: 0,
			unpricedRequests: 0,
		});
		expectConservation(overview);
	});

	it("conserves prompt tokens in the sparkline when the cutoff starts mid-bucket", async () => {
		await initDb();
		const now = Date.UTC(2026, 0, 1, 12, 30, 0);
		const clock = spyOn(Date, "now").mockReturnValue(now);
		try {
			insertMessageStats([message(sessionFile("unaligned"), "unaligned", now - DAY_MS + 15 * 60_000, 100)]);
			const overview = await getContextOverview("24h");
			expect(overview.kpi.promptTokens).toBe(150);
			expect(overview.sessions[0]?.sparkline).toEqual([150, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
			expect(overview.sessions[0]?.sparkline.reduce((sum, value) => sum + value, 0)).toBe(150);
		} finally {
			clock.mockRestore();
		}
	});

	it("carries unpriced requests into KPI, heatmap and session rows", async () => {
		await initDb();
		const now = Date.now();
		insertMessageStats([message(sessionFile("unpriced"), "unpriced", now - HOUR_MS, 100, "model-a", "xai-oauth")]);
		const overview = await getContextOverview("24h");
		expect(overview.kpi.unpricedRequests).toBe(1);
		expect(overview.heatmap[0]?.unpricedRequests).toBe(1);
		expect(overview.sessions[0]?.unpricedRequests).toBe(1);
		expect(overview.sessions[0]?.costTotal).toBe(0);
	});

	it("keeps model totals on the same eligible roots as the KPI", async () => {
		await initDb();
		const now = Date.now();
		const inside = sessionFile("model-eligible");
		const traversal = `${getSessionsDir()}${path.sep}project${path.sep}..${path.sep}..${path.sep}outside.jsonl`;
		insertMessageStats([
			message(inside, "inside-model", now - HOUR_MS, 100, "eligible-model"),
			message(traversal, "escape-model", now - HOUR_MS, 10000, "escape-model"),
		]);
		const overview = await getContextOverview("24h");
		expect(overview.kpi.requests).toBe(1);
		expect(overview.models).toEqual([
			{
				model: "eligible-model",
				requests: 1,
				promptTokens: 150,
				totalTokens: 160,
				costTotal: 0,
				unpricedRequests: 0,
			},
		]);
	});

	it("returns zero KPIs and empty arrays when no requests are in range", async () => {
		await initDb();
		insertMessageStats([message(sessionFile("old"), "old", Date.now() - 2 * DAY_MS)]);
		const overview = await getContextOverview("24h");
		expect(overview.kpi).toEqual({
			sessions: 0,
			requests: 0,
			avgPromptTokens: 0,
			peakPromptTokens: 0,
			totalTokens: 0,
			promptTokens: 0,
			inputTokens: 0,
			outputTokens: 0,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			cacheRate: 0,
			costTotal: 0,
			unpricedRequests: 0,
		});
		expect(overview.sessions).toEqual([]);
		expect(overview.heatmap).toEqual([]);
		expect(overview.models).toEqual([]);
		expect(overview.omittedSessions).toBe(0);
		expect(overview.omittedRequests).toBe(0);
		expect(overview.omittedPromptTokens).toBe(0);
	});

	for (const [range, spanDays] of [
		["1h", 1 / 24],
		["24h", 1],
		["7d", 7],
		["30d", 30],
		["90d", 90],
	] as const) {
		it(`uses one exact ${range} cutoff with the specified heatmap buckets`, async () => {
			await initDb();
			const now = Date.now();
			const cutoff = now - spanDays * DAY_MS;
			insertMessageStats([
				message(sessionFile("boundary"), "excluded", cutoff - 1, 10000),
				message(sessionFile("boundary"), "included", cutoff, 100),
				message(sessionFile("boundary"), "latest", now - 1, 200),
			]);
			const clock = spyOn(Date, "now").mockReturnValue(now);
			let overview: ContextOverview;
			try {
				overview = await getContextOverview(range);
			} finally {
				clock.mockRestore();
			}
			const bucketMs = range === "30d" || range === "90d" ? DAY_MS : HOUR_MS;
			expect(overview.cutoff).toBe(cutoff);
			expect(overview.heatmapBucketMs).toBe(bucketMs);
			expect(overview.kpi.requests).toBe(2);
			expect(overview.kpi.peakPromptTokens).toBe(250);
			expect(overview.sessions[0]).toMatchObject({ startedAt: cutoff, endedAt: now - 1, promptTokens: 400 });
			expect(overview.heatmap[0].bucket).toBe(Math.floor(cutoff / bucketMs) * bucketMs);
			expectConservation(overview);
		});
	}

	it("reuses root title and folder metadata without changing range counters", async () => {
		await initDb();
		const root = sessionFile("metadata");
		await Bun.write(
			root,
			`${JSON.stringify({ type: "title", title: "Root title" })}\n${JSON.stringify({ type: "session", cwd: "/actual/project" })}\n`,
		);
		insertMessageStats([message(root, "metadata-request", Date.now() - 1000)]);
		const overview = await getContextOverview("24h");
		expect(overview.sessions[0]).toMatchObject({ title: "Root title", folder: "/actual/project", requests: 1 });
	});

	it("serves every supported range and defaults missing range to 24h", async () => {
		await initDb();
		for (const range of ["1h", "24h", "7d", "30d", "90d"] satisfies TimeRange[]) {
			const response = await handleApi(new Request(`http://stats.test/api/context/overview?range=${range}`));
			expect(response.status).toBe(200);
			expect(response.headers.get("etag")).toBeNull();
			expect(await response.json()).toMatchObject({ range, sessions: [], heatmap: [] });
		}
		const response = await handleApi(new Request("http://stats.test/api/context/overview"));
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ range: "24h" });
	});

	it("rejects unknown ranges instead of silently using the default", async () => {
		for (const range of ["unknown", "all", "", "24H", " 24h "]) {
			const response = await handleApi(
				new Request(`http://stats.test/api/context/overview?range=${encodeURIComponent(range)}`),
			);
			expect(response.status).toBe(400);
			expect(await response.json()).toEqual({ error: "invalid range" });
		}
	});
});

function expectConservation(overview: ContextOverview): void {
	expect(overview.heatmap.reduce((sum, row) => sum + row.requests, 0)).toBe(overview.kpi.requests);
	expect(overview.sessions.reduce((sum, row) => sum + row.requests, 0) + overview.omittedRequests).toBe(
		overview.kpi.requests,
	);
	expect(overview.heatmap.reduce((sum, row) => sum + row.promptTokens, 0)).toBe(
		overview.sessions.reduce((sum, row) => sum + row.promptTokens, 0) + overview.omittedPromptTokens,
	);
}
