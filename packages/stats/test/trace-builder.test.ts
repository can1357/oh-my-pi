/**
 * Contracts for the session trace builder: span timing joins (markers, tool
 * results, exits), turn segmentation, subagent/background linkage, active
 * branch filtering, summary aggregation, session-list folding, and the
 * client-path containment boundary.
 */

import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { syncAllSessions } from "@oh-my-pi/omp-stats/aggregator";
import { buildSessionTrace, getTraceEntry, listSessionSummaries, TracePathError } from "@oh-my-pi/omp-stats/trace";
import { getSessionsDir } from "@oh-my-pi/pi-utils";
import { installStatsTestIsolation } from "./helpers/temp-agent";

installStatsTestIsolation("@pi-stats-trace-");

const T = 1_700_000_000_000;
const PROJECT = "--tmp--proj--";
const ROOT_BASE = "1700000000000_test.jsonl";

const iso = (ms: number) => new Date(ms).toISOString();

const usage = (totalTokens: number, cost: number) => ({
	input: 1,
	output: 1,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
});

/** Root transcript: two turns, tool joins, task fan-out, background job, markers, abandoned branch, pending exit. */
const ROOT_ENTRIES: unknown[] = [
	{ type: "title", v: 1, title: "Fixture Session" },
	{ type: "session", version: 3, id: "sess", timestamp: iso(T), cwd: "/tmp/proj" },
	{
		type: "message",
		id: "u1",
		parentId: null,
		timestamp: iso(T + 1000),
		message: { role: "user", content: [{ type: "text", text: "do the thing" }], timestamp: T + 1000 },
	},
	{
		type: "message",
		id: "a1",
		parentId: "u1",
		timestamp: iso(T + 11_000),
		message: {
			role: "assistant",
			model: "m-1",
			provider: "p",
			api: "openai-completions",
			timestamp: T + 2000,
			duration: 9000,
			completedAt: T + 11_000,
			ttft: 500,
			usage: usage(100, 0.01),
			stopReason: "toolUse",
			content: [
				{ type: "text", text: "working" },
				{ type: "toolCall", id: "call1", name: "bash", arguments: { command: "ls" } },
			],
		},
	},
	{
		type: "custom",
		id: "m1",
		parentId: "a1",
		timestamp: iso(T + 11_050),
		customType: "tool_execution_start",
		data: { toolCallId: "call1", toolName: "bash", args: { command: "ls" }, startedAt: iso(T + 11_100) },
	},
	{
		type: "message",
		id: "r1",
		parentId: "m1",
		timestamp: iso(T + 15_000),
		message: {
			role: "toolResult",
			toolCallId: "call1",
			toolName: "bash",
			timestamp: T + 15_000,
			isError: false,
			content: [{ type: "text", text: "ok" }],
		},
	},
	{
		type: "message",
		id: "a2",
		parentId: "r1",
		timestamp: iso(T + 16_000),
		message: {
			role: "assistant",
			model: "m-1",
			provider: "p",
			api: "openai-completions",
			timestamp: T + 15_500,
			duration: 500,
			completedAt: T + 16_000,
			usage: usage(50, 0.005),
			stopReason: "toolUse",
			content: [{ type: "toolCall", id: "call2", name: "task", arguments: { tasks: [] } }],
		},
	},
	{
		type: "message",
		id: "r2",
		parentId: "a2",
		timestamp: iso(T + 40_000),
		message: {
			role: "toolResult",
			toolCallId: "call2",
			toolName: "task",
			timestamp: T + 40_000,
			isError: false,
			content: [{ type: "text", text: "done" }],
			details: {
				results: [
					{ index: 0, id: "Scout1", agent: "scout", task: "scan the code", durationMs: 20_000, exitCode: 0 },
					{ index: 1, id: "Ghost9", agent: "scout", task: "missing child", durationMs: 5000, exitCode: 0 },
				],
			},
		},
	},
	{
		type: "message",
		id: "a3",
		parentId: "r2",
		timestamp: iso(T + 41_000),
		message: {
			role: "assistant",
			model: "m-1",
			provider: "p",
			api: "openai-completions",
			timestamp: T + 40_500,
			duration: 500,
			completedAt: T + 41_000,
			usage: usage(20, 0.002),
			stopReason: "toolUse",
			content: [{ type: "toolCall", id: "call3", name: "bash", arguments: { command: "sleep 5" } }],
		},
	},
	{
		type: "message",
		id: "r3",
		parentId: "a3",
		timestamp: iso(T + 41_500),
		message: {
			role: "toolResult",
			toolCallId: "call3",
			toolName: "bash",
			timestamp: T + 41_500,
			isError: false,
			content: [{ type: "text", text: "backgrounded" }],
			details: { async: { state: "running", jobId: "job1", type: "bash" } },
		},
	},
	{
		type: "message",
		id: "ar1",
		parentId: "r3",
		timestamp: iso(T + 50_000),
		message: {
			role: "custom",
			customType: "async-result",
			timestamp: T + 50_000,
			content: "job done",
			details: { jobs: [{ jobId: "job1", type: "bash", durationMs: 8500 }] },
		},
	},
	{
		type: "message",
		id: "u2s",
		parentId: "ar1",
		timestamp: iso(T + 50_500),
		message: { role: "user", synthetic: true, content: [{ type: "text", text: "sys" }], timestamp: T + 50_500 },
	},
	{
		type: "compaction",
		id: "c1",
		parentId: "u2s",
		timestamp: iso(T + 51_000),
		summary: "compacted",
		tokensBefore: 142_000,
		tokensAfter: 38_000,
	},
	{ type: "model_change", id: "mc1", parentId: "c1", timestamp: iso(T + 52_000), model: "m-2" },
	{
		type: "message",
		id: "u2",
		parentId: "mc1",
		timestamp: iso(T + 60_000),
		message: { role: "user", content: [{ type: "text", text: "second turn" }], timestamp: T + 60_000 },
	},
	// Abandoned sibling branch: same parent as a4, not an ancestor of the last entry.
	{
		type: "message",
		id: "ax",
		parentId: "u2",
		timestamp: iso(T + 60_500),
		message: {
			role: "assistant",
			model: "m-abandoned",
			provider: "p",
			api: "openai-completions",
			timestamp: T + 60_100,
			duration: 400,
			completedAt: T + 60_500,
			usage: usage(999, 9),
			stopReason: "stop",
			content: [{ type: "text", text: "dead end" }],
		},
	},
	// Legacy assistant: no timestamp/duration/completedAt → envelope-derived zero-width span.
	{
		type: "message",
		id: "a4",
		parentId: "u2",
		timestamp: iso(T + 61_000),
		message: {
			role: "assistant",
			model: "m-2",
			provider: "p",
			api: "openai-completions",
			usage: usage(10, 0.001),
			stopReason: "stop",
			content: [{ type: "text", text: "legacy" }],
		},
	},
	{
		type: "message",
		id: "a5",
		parentId: "a4",
		timestamp: iso(T + 62_000),
		message: {
			role: "assistant",
			model: "m-2",
			provider: "p",
			api: "openai-completions",
			timestamp: T + 61_500,
			duration: 500,
			completedAt: T + 62_000,
			usage: usage(30, 0.003),
			stopReason: "toolUse",
			content: [{ type: "toolCall", id: "call4", name: "edit", arguments: { input: "x" } }],
		},
	},
	{
		type: "custom",
		id: "e1",
		parentId: "a5",
		timestamp: iso(T + 65_000),
		customType: "session_exit",
		data: {
			reason: "quit",
			kind: "normal",
			recordedAt: iso(T + 64_000),
			pendingToolCalls: [{ toolCallId: "call4", toolName: "edit" }],
		},
	},
];

const CHILD_ENTRIES: unknown[] = [
	{ type: "session", version: 3, id: "csess", timestamp: iso(T + 17_000), cwd: "/tmp/proj" },
	{
		type: "session_init",
		id: "si1",
		parentId: null,
		timestamp: iso(T + 17_000),
		agent: "scout",
		task: "scan the code",
		resolvedModel: "p/m-scout",
	},
	{
		type: "message",
		id: "cu1",
		parentId: "si1",
		timestamp: iso(T + 17_100),
		message: { role: "user", content: [{ type: "text", text: "scan the code" }], timestamp: T + 17_100 },
	},
	{
		type: "message",
		id: "ca1",
		parentId: "cu1",
		timestamp: iso(T + 30_000),
		message: {
			role: "assistant",
			model: "m-scout",
			provider: "p",
			api: "openai-completions",
			timestamp: T + 18_000,
			duration: 12_000,
			completedAt: T + 30_000,
			usage: usage(500, 0.05),
			stopReason: "stop",
			content: [{ type: "text", text: "done" }],
		},
	},
];

/** Orphan child: exists on disk but no task result references it (async task run). */
const ORPHAN_ENTRIES: unknown[] = [
	{ type: "session", version: 3, id: "osess", timestamp: iso(T + 20_000), cwd: "/tmp/proj" },
	{
		type: "session_init",
		id: "osi1",
		parentId: null,
		timestamp: iso(T + 20_000),
		agent: "sonic",
		task: "orphan work",
		resolvedModel: "p/m-orphan",
	},
	{
		type: "message",
		id: "oa1",
		parentId: "osi1",
		timestamp: iso(T + 25_000),
		message: {
			role: "assistant",
			model: "m-orphan",
			provider: "p",
			api: "openai-completions",
			timestamp: T + 20_500,
			duration: 4500,
			completedAt: T + 25_000,
			usage: usage(40, 0.004),
			stopReason: "stop",
			content: [{ type: "text", text: "orphan done" }],
		},
	},
];

async function writeFixture(): Promise<string> {
	const projectDir = path.join(getSessionsDir(), PROJECT);
	const rootFile = path.join(projectDir, ROOT_BASE);
	const childDir = path.join(projectDir, "1700000000000_test");
	await fs.mkdir(childDir, { recursive: true });
	await Bun.write(rootFile, ROOT_ENTRIES.map(entry => JSON.stringify(entry)).join("\n"));
	await Bun.write(path.join(childDir, "Scout1.jsonl"), CHILD_ENTRIES.map(entry => JSON.stringify(entry)).join("\n"));
	await Bun.write(path.join(childDir, "Orphan7.jsonl"), ORPHAN_ENTRIES.map(entry => JSON.stringify(entry)).join("\n"));
	return rootFile;
}

describe("buildSessionTrace", () => {
	it("assembles model, tool, turn, subagent, and background spans with correct timing joins", async () => {
		const rootFile = await writeFixture();
		const trace = await buildSessionTrace(rootFile);

		expect(trace.title).toBe("Fixture Session");
		expect(trace.cwd).toBe("/tmp/proj");
		expect(trace.tracks[0].id).toBe("main");
		const main = trace.tracks[0];

		// Model span: request-start → completedAt, carrying ttft/tokens/cost.
		const modelA1 = main.spans.find(span => span.entryId === "a1" && span.kind === "model");
		expect(modelA1).toMatchObject({ start: T + 2000, end: T + 11_000, ttft: 500, tokens: 100, cost: 0.01 });

		// Legacy assistant degrades to an envelope-derived zero-width span.
		const legacy = main.spans.find(span => span.entryId === "a4" && span.kind === "model");
		expect(legacy).toMatchObject({ start: T + 61_000, end: T + 61_000 });

		// Tool span joined via tool_execution_start marker; end from the toolResult.
		const bash1 = main.spans.find(span => span.toolCallId === "call1");
		expect(bash1).toMatchObject({ kind: "tool", start: T + 11_100, end: T + 15_000, label: "bash", detail: "ls" });
		expect(bash1?.unterminated).toBeUndefined();

		// No marker + no result but listed in session_exit → model-end start, recordedAt end, unterminated.
		const pendingEdit = main.spans.find(span => span.toolCallId === "call4");
		expect(pendingEdit).toMatchObject({ start: T + 62_000, end: T + 64_000, unterminated: true });

		// Background job opens at the async-running result, closes at the async-result delivery.
		const bg = main.spans.find(span => span.kind === "background");
		expect(bg).toMatchObject({ start: T + 41_500, end: T + 50_000 });

		// Two non-synthetic user turns; the synthetic message opens none.
		const turns = main.spans.filter(span => span.kind === "turn");
		expect(turns.length).toBe(2);
		expect(turns[0].start).toBe(T + 1000);
		expect(turns[1].start).toBe(T + 60_000);

		// Subagent linkage: existing child → child activity bounds + track; missing child → durationMs fallback.
		const scout = main.spans.find(span => span.kind === "subagent" && span.childTrackId === "Scout1");
		expect(scout).toMatchObject({ start: T + 17_100, end: T + 30_000, label: "scout" });
		const ghost = main.spans.find(span => span.kind === "subagent" && span.label === "scout" && !span.childTrackId);
		expect(ghost).toMatchObject({ start: T + 35_000, end: T + 40_000 });
		const childTrack = trace.tracks.find(track => track.id === "Scout1");
		expect(childTrack?.parentId).toBe("main");
		expect(childTrack?.agent).toBe("scout");
		expect(childTrack?.model).toBe("p/m-scout");
		expect(childTrack?.spans.some(span => span.kind === "model" && span.tokens === 500)).toBe(true);
		// Child with no structured task result (async task run) still gets a
		// parent Agents-lane span from its own activity bounds.
		const orphan = main.spans.find(span => span.childTrackId === "Orphan7");
		expect(orphan).toMatchObject({ kind: "subagent", start: T + 20_500, end: T + 25_000, model: "p/m-orphan" });

		// Markers.
		const compaction = main.markers.find(marker => marker.kind === "compaction");
		expect(compaction).toMatchObject({ time: T + 51_000, label: "compaction 142k→38k" });
		expect(main.markers.find(marker => marker.kind === "model_change")?.label).toBe("m-2");
		expect(main.markers.find(marker => marker.kind === "session_exit")?.time).toBe(T + 64_000);

		// Abandoned branch excluded entirely.
		expect(main.spans.some(span => span.model === "m-abandoned")).toBe(false);
	});

	it("aggregates summary counts, tool stats, and idle time across tracks", async () => {
		const rootFile = await writeFixture();
		const { summary } = await buildSessionTrace(rootFile);

		expect(summary.turns).toBe(2);
		expect(summary.requests).toBe(7); // 5 main (abandoned excluded) + 2 children
		expect(summary.toolCalls).toBe(4); // call1..call4
		expect(summary.subagents).toBe(2);
		expect(summary.totalTokens).toBe(750);
		expect(summary.costTotal).toBeCloseTo(0.075, 10);

		// task: call2 (24s); bash: call1 (3.9s) + call3 (0.5s); edit: call4 (2s). Sorted by total desc.
		expect(summary.toolStats[0]).toMatchObject({ tool: "task", calls: 1, totalMs: 24_000 });
		expect(summary.toolStats[1]).toMatchObject({ tool: "bash", calls: 2, errors: 0, totalMs: 4400, maxMs: 3900 });
		expect(summary.toolStats[2]).toMatchObject({ tool: "edit", calls: 1, totalMs: 2000 });

		// Wall = first turn start → pending-tool end; idle = the 10s wait before turn 2.
		expect(summary.wallMs).toBe(63_000);
		expect(summary.idleMs).toBe(10_000);
	});

	it("rejects paths outside the sessions root", async () => {
		await writeFixture();
		expect(buildSessionTrace("/etc/passwd.jsonl")).rejects.toThrow(TracePathError);
		expect(buildSessionTrace(path.join(getSessionsDir(), "..", "escape.jsonl"))).rejects.toThrow(TracePathError);
	});
});

describe("getTraceEntry", () => {
	it("returns the full journal entry by id and null for unknown ids", async () => {
		const rootFile = await writeFixture();
		const entry = await getTraceEntry(rootFile, "a1");
		expect(entry).toMatchObject({ type: "message", id: "a1" });
		expect(await getTraceEntry(rootFile, "nope")).toBeNull();
	});
});

describe("listSessionSummaries", () => {
	it("lists unsynced on-disk sessions with titles before any sync", async () => {
		const rootFile = await writeFixture();
		const rows = await listSessionSummaries();
		const row = rows.find(r => r.file === rootFile);
		expect(row).toBeDefined();
		expect(row?.title).toBe("Fixture Session");
		expect(row?.requests).toBe(0);
	});

	it("folds synced child transcripts into the root row and filters by q", async () => {
		const rootFile = await writeFixture();
		await syncAllSessions();

		const rows = await listSessionSummaries();
		const row = rows.find(r => r.file === rootFile);
		expect(row).toBeDefined();
		expect(row?.subagents).toBe(2);
		expect(row?.requests).toBe(8); // 6 main assistant rows (incl. abandoned; sync is branch-agnostic) + 2 children
		expect(row?.models).toContain("m-scout");
		expect(row?.models).toContain("m-1");
		expect(row?.title).toBe("Fixture Session");

		const filtered = await listSessionSummaries(100, "fixture");
		expect(filtered.some(r => r.file === rootFile)).toBe(true);
		expect(await listSessionSummaries(100, "zzz-no-match")).toEqual([]);
	});
});
