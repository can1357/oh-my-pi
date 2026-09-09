import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getToolDashboardStats, syncAllSessions } from "@oh-my-pi/omp-stats/aggregator";
import { getToolStats, getToolStatsByModel } from "@oh-my-pi/omp-stats/db";
import type { ToolUsageStats } from "@oh-my-pi/omp-stats/types";
import { getSessionsDir } from "@oh-my-pi/pi-utils";
import { installStatsTestIsolation } from "./helpers/temp-agent";

installStatsTestIsolation("@pi-stats-tool-stats-");

const FOLDER_SLUG = "--tmp--tool-stats";
const MODEL = "gpt-5.4";
const PROVIDER = "openai";

const TS1 = "2026-06-24T10:00:00.000Z";
const TS2 = "2026-06-24T10:05:00.000Z";

// Turn 1: two toolCall blocks (grep + read) sharing one provider request.
const TURN1_TOTAL_TOKENS = 100;
const TURN1_OUTPUT_TOKENS = 20;
const TURN1_COST = 0.01;
// Turn 2: a single grep toolCall owning the whole request.
const TURN2_TOTAL_TOKENS = 40;
const TURN2_OUTPUT_TOKENS = 8;
const TURN2_COST = 0.004;

const GREP_ARGS_1 = { pattern: "x" };
const READ_ARGS = { path: "/tmp/f" };
const GREP_ARGS_2 = { pattern: "yz" };

const GREP_RESULT_1 = "grep hit: src/index.ts:42";
const READ_ERROR_RESULT = "read failed: ENOENT";
const GREP_RESULT_2 = "ok";

interface ToolCallBlock {
	id: string;
	name: string;
	arguments: Record<string, unknown>;
}

interface AssistantTurnOptions {
	entryId: string;
	parentId?: string | null;
	timestamp: string;
	toolCalls: ToolCallBlock[];
	totalTokens: number;
	outputTokens: number;
	costTotal: number;
}

function buildAssistantEntry(opts: AssistantTurnOptions) {
	return {
		type: "message",
		id: opts.entryId,
		parentId: opts.parentId ?? null,
		timestamp: opts.timestamp,
		message: {
			role: "assistant",
			content: [
				{ type: "text", text: "ok" },
				...opts.toolCalls.map(call => ({
					type: "toolCall",
					id: call.id,
					name: call.name,
					arguments: call.arguments,
				})),
			],
			api: "openai-responses",
			provider: PROVIDER,
			model: MODEL,
			usage: {
				input: 10,
				output: opts.outputTokens,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: opts.totalTokens,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: opts.costTotal },
			},
			stopReason: "toolUse",
			timestamp: Date.parse(opts.timestamp),
			duration: 10,
			ttft: 5,
		},
	};
}

interface ToolResultOptions {
	entryId: string;
	parentId: string;
	timestamp: string;
	toolCallId: string;
	toolName: string;
	text: string;
	isError?: boolean;
}

function buildToolResultEntry(opts: ToolResultOptions) {
	return {
		type: "message",
		id: opts.entryId,
		parentId: opts.parentId,
		timestamp: opts.timestamp,
		message: {
			role: "toolResult",
			toolCallId: opts.toolCallId,
			toolName: opts.toolName,
			content: [{ type: "text", text: opts.text }],
			isError: opts.isError ?? false,
			timestamp: Date.parse(opts.timestamp),
		},
	};
}

async function writeSessionFile(
	fileName: string,
	header: { id: string; parentSession?: string },
	entries: unknown[],
): Promise<string> {
	const sessionDir = path.join(getSessionsDir(), FOLDER_SLUG);
	await fs.mkdir(sessionDir, { recursive: true });
	const sessionFile = path.join(sessionDir, fileName);
	const headerEntry = {
		type: "session",
		version: 3,
		id: header.id,
		timestamp: new Date().toISOString(),
		cwd: "/tmp/project",
		...(header.parentSession ? { parentSession: header.parentSession } : {}),
	};
	const lines = [headerEntry, ...entries].map(entry => JSON.stringify(entry)).join("\n");
	await Bun.write(sessionFile, `${lines}\n`);
	return sessionFile;
}

/**
 * Standard fixture: turn 1 calls grep+read (grep succeeds, read errors),
 * turn 2 calls grep again and succeeds.
 */
function buildStandardEntries(): unknown[] {
	return [
		buildAssistantEntry({
			entryId: "asst-1",
			timestamp: TS1,
			toolCalls: [
				{ id: "call-1", name: "grep", arguments: GREP_ARGS_1 },
				{ id: "call-2", name: "read", arguments: READ_ARGS },
			],
			totalTokens: TURN1_TOTAL_TOKENS,
			outputTokens: TURN1_OUTPUT_TOKENS,
			costTotal: TURN1_COST,
		}),
		buildToolResultEntry({
			entryId: "tr-1",
			parentId: "asst-1",
			timestamp: TS1,
			toolCallId: "call-1",
			toolName: "grep",
			text: GREP_RESULT_1,
		}),
		buildToolResultEntry({
			entryId: "tr-2",
			parentId: "asst-1",
			timestamp: TS1,
			toolCallId: "call-2",
			toolName: "read",
			text: READ_ERROR_RESULT,
			isError: true,
		}),
		buildAssistantEntry({
			entryId: "asst-2",
			parentId: "tr-2",
			timestamp: TS2,
			toolCalls: [{ id: "call-3", name: "grep", arguments: GREP_ARGS_2 }],
			totalTokens: TURN2_TOTAL_TOKENS,
			outputTokens: TURN2_OUTPUT_TOKENS,
			costTotal: TURN2_COST,
		}),
		buildToolResultEntry({
			entryId: "tr-3",
			parentId: "asst-2",
			timestamp: TS2,
			toolCallId: "call-3",
			toolName: "grep",
			text: GREP_RESULT_2,
		}),
	];
}

function toolRow(rows: ToolUsageStats[], tool: string): ToolUsageStats {
	const row = rows.find(r => r.tool === tool);
	if (!row) throw new Error(`missing aggregate row for tool "${tool}"`);
	return row;
}

describe("tool usage stats pipeline", () => {
	it("ingests tool calls and results end-to-end and splits turn usage across calls", async () => {
		await writeSessionFile("session.jsonl", { id: "sess0001" }, buildStandardEntries());
		await syncAllSessions({ workers: 1 });

		const stats = getToolStats();
		expect(stats).toHaveLength(2);

		const grep = toolRow(stats, "grep");
		expect(grep.calls).toBe(2);
		expect(grep.errors).toBe(0);
		expect(grep.resultChars).toBe(GREP_RESULT_1.length + GREP_RESULT_2.length);
		expect(grep.argsChars).toBe(JSON.stringify(GREP_ARGS_1).length + JSON.stringify(GREP_ARGS_2).length);
		// Turn 1's request is split across its two toolCall blocks; turn 2 is
		// grep's alone: 100/2 + 40 = 90, 20/2 + 8 = 18, 0.01/2 + 0.004 = 0.009.
		expect(grep.totalTokensShare).toBeCloseTo(90, 6);
		expect(grep.outputTokensShare).toBeCloseTo(18, 6);
		expect(grep.costShare).toBeCloseTo(0.009, 8);
		expect(grep.lastUsed).toBe(Date.parse(TS2));

		const read = toolRow(stats, "read");
		expect(read.calls).toBe(1);
		expect(read.errors).toBe(1);
		expect(read.resultChars).toBe(READ_ERROR_RESULT.length);
		expect(read.argsChars).toBe(JSON.stringify(READ_ARGS).length);
		expect(read.totalTokensShare).toBeCloseTo(50, 6);
		expect(read.outputTokensShare).toBeCloseTo(10, 6);
		expect(read.costShare).toBeCloseTo(0.005, 8);
		expect(read.lastUsed).toBe(Date.parse(TS1));

		// Per-model breakdown carries the fixture model/provider with the same split.
		const byModel = getToolStatsByModel();
		expect(byModel).toHaveLength(2);
		for (const row of byModel) {
			expect(row.model).toBe(MODEL);
			expect(row.provider).toBe(PROVIDER);
		}
		expect(toolRow(byModel, "grep").calls).toBe(2);
		expect(toolRow(byModel, "grep").totalTokensShare).toBeCloseTo(90, 6);
		expect(toolRow(byModel, "read").calls).toBe(1);
		expect(toolRow(byModel, "read").totalTokensShare).toBeCloseTo(50, 6);

		// Dashboard payload reuses the same aggregates and buckets the calls.
		const dashboard = await getToolDashboardStats("all");
		expect(dashboard.byTool).toEqual(stats);
		expect(dashboard.series.length).toBeGreaterThan(0);
		const seriesCalls = new Map<string, number>();
		const seriesErrors = new Map<string, number>();
		for (const point of dashboard.series) {
			seriesCalls.set(point.tool, (seriesCalls.get(point.tool) ?? 0) + point.calls);
			seriesErrors.set(point.tool, (seriesErrors.get(point.tool) ?? 0) + point.errors);
		}
		expect(seriesCalls.get("grep")).toBe(2);
		expect(seriesCalls.get("read")).toBe(1);
		expect(seriesErrors.get("grep")).toBe(0);
		expect(seriesErrors.get("read")).toBe(1);
	});

	it("links a result that lands in a later sync pass without duplicating the call", async () => {
		const lateResultText = "late failure output";
		const sessionFile = await writeSessionFile("session.jsonl", { id: "sess0002" }, [
			buildAssistantEntry({
				entryId: "asst-1",
				timestamp: TS1,
				toolCalls: [{ id: "call-1", name: "grep", arguments: GREP_ARGS_1 }],
				totalTokens: TURN2_TOTAL_TOKENS,
				outputTokens: TURN2_OUTPUT_TOKENS,
				costTotal: TURN2_COST,
			}),
		]);
		await syncAllSessions({ workers: 1 });

		// First pass: the call is recorded but no result has arrived yet.
		const pending = getToolStats();
		expect(pending).toHaveLength(1);
		expect(pending[0].tool).toBe("grep");
		expect(pending[0].calls).toBe(1);
		expect(pending[0].resultChars).toBe(0);
		expect(pending[0].errors).toBe(0);

		// The toolResult is appended after the first pass consumed the file.
		const lateResult = buildToolResultEntry({
			entryId: "tr-1",
			parentId: "asst-1",
			timestamp: TS2,
			toolCallId: "call-1",
			toolName: "grep",
			text: lateResultText,
			isError: true,
		});
		await fs.appendFile(sessionFile, `${JSON.stringify(lateResult)}\n`);
		// Guarantee the stored mtime is strictly older than the file's, so the
		// incremental sync re-reads it regardless of filesystem granularity.
		const bumped = new Date(Date.now() + 1_000);
		await fs.utimes(sessionFile, bumped, bumped);

		await syncAllSessions({ workers: 1 });

		const linked = getToolStats();
		expect(linked).toHaveLength(1);
		expect(linked[0].tool).toBe("grep");
		expect(linked[0].calls).toBe(1);
		expect(linked[0].resultChars).toBe(lateResultText.length);
		expect(linked[0].errors).toBe(1);
	});

	it("does not double-count tool calls copied into a forked session file", async () => {
		const entries = buildStandardEntries();
		const parentFile = await writeSessionFile("01_parent.jsonl", { id: "parent00" }, entries);
		// `createBranchedSession` deep-copies the parent's entries (same entry
		// ids, timestamps, and tool call ids) into the child file.
		await writeSessionFile("02_fork.jsonl", { id: "fork0000", parentSession: parentFile }, entries);

		await syncAllSessions({ workers: 1 });

		const stats = getToolStats();
		expect(stats).toHaveLength(2);

		const grep = toolRow(stats, "grep");
		expect(grep.calls).toBe(2);
		expect(grep.errors).toBe(0);
		expect(grep.resultChars).toBe(GREP_RESULT_1.length + GREP_RESULT_2.length);
		expect(grep.totalTokensShare).toBeCloseTo(90, 6);

		const read = toolRow(stats, "read");
		expect(read.calls).toBe(1);
		expect(read.errors).toBe(1);
		expect(read.resultChars).toBe(READ_ERROR_RESULT.length);
		expect(read.totalTokensShare).toBeCloseTo(50, 6);
	});

	it("keeps tool aggregates stable across repeated syncs of unchanged data", async () => {
		const sessionFile = await writeSessionFile("session.jsonl", { id: "sess0003" }, buildStandardEntries());
		await syncAllSessions({ workers: 1 });

		const first = getToolStats();
		expect(toolRow(first, "grep").calls).toBe(2);
		expect(toolRow(first, "read").calls).toBe(1);

		// Plain re-sync: the offset table short-circuits the unchanged file.
		await syncAllSessions({ workers: 1 });
		expect(getToolStats()).toEqual(first);

		// Bumped mtime with identical content: the file is re-examined from its
		// stored offset and must not re-ingest anything.
		const bumped = new Date(Date.now() + 1_000);
		await fs.utimes(sessionFile, bumped, bumped);
		await syncAllSessions({ workers: 1 });
		expect(getToolStats()).toEqual(first);
	});
});
