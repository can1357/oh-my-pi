import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type AgentToolResult, Tokenizer } from "@oh-my-pi/pi-agent-core";
import {
	pruneSupersededToolResults,
	readToolSupersedeKey,
	type SessionEntry,
} from "@oh-my-pi/pi-agent-core/compaction";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import { isCompleteReadResult, shownReadLines } from "@oh-my-pi/pi-coding-agent/tools/read-supersede";
import type { ReadToolDetails } from "@oh-my-pi/pi-tui/tools/read";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

// Real `ReadTool` results through the supersede pass with `isCompleteReadResult`,
// so each completeness signal it relies on is exercised end to end.

// 40 functions with 6-line bodies: far above the summary thresholds pinned below.
const codeFile = Array.from({ length: 40 }, (_, i) => {
	const body = Array.from({ length: 6 }, (_, j) => `\tconst v${j} = value + ${i * 10 + j};`).join("\n");
	return `export function step${i}(value: number): number {\n${body}\n\treturn v5 * 2;\n}`;
}).join("\n\n");

let cwd: string;
let reader: ReadTool;

beforeAll(async () => {
	cwd = await fs.mkdtemp(path.join(os.tmpdir(), "read-supersede-prune-"));
	await Bun.write(path.join(cwd, "code.ts"), `${codeFile}\n`);
	await Bun.write(path.join(cwd, "notes.txt"), Array.from({ length: 20 }, (_, i) => `note ${i + 1}`).join("\n"));
	await Bun.write(path.join(cwd, "long.txt"), Array.from({ length: 1_000 }, (_, i) => `row ${i + 1}`).join("\n"));
	await Bun.write(path.join(cwd, "wide.txt"), ["short", "x".repeat(5_000), "short"].join("\n"));
	await Bun.write(
		path.join(cwd, "huge.log"),
		Array.from({ length: 200_000 }, (_, i) => `log line ${i + 1} ${"z".repeat(20)}`).join("\n"),
	);
	const session: ToolSession = {
		cwd,
		hasUI: false,
		getSessionFile: () => path.join(cwd, "session.jsonl"),
		getSessionSpawns: () => "*",
		settings: Settings.isolated({
			"lsp.enabled": false,
			"read.summarize.enabled": true,
			"read.summarize.minBodyLines": 4,
			"read.summarize.minTotalLines": 100,
			"read.summarize.unfoldUntil": 0,
			"read.summarize.unfoldLimit": 0,
		}),
	};
	reader = new ReadTool(session);
});

afterAll(async () => {
	await removeWithRetries(cwd);
});

function readEntries(id: string, readPath: string, result: AgentToolResult<ReadToolDetails>): SessionEntry[] {
	const timestamp = Date.now();
	return [
		{
			type: "message",
			id: `${id}-call`,
			parentId: null,
			timestamp: new Date(timestamp).toISOString(),
			message: {
				role: "assistant",
				content: [{ type: "toolCall", id, name: "read", arguments: { path: readPath } }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "test",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "toolUse",
				timestamp,
			},
		},
		{
			type: "message",
			id: `${id}-result`,
			parentId: null,
			timestamp: new Date(timestamp).toISOString(),
			message: {
				role: "toolResult",
				toolCallId: id,
				toolName: "read",
				content: result.content,
				details: result.details,
				isError: false,
				timestamp,
			},
		},
	];
}

describe("real read results through the supersede pass", () => {
	test.each([
		{
			name: "a code summary keeps an earlier range",
			older: "code.ts:10-40",
			newer: "code.ts",
			pruned: 0,
			summary: true,
		},
		{ name: "a complete bare read replaces an earlier range", older: "notes.txt:2-5", newer: "notes.txt", pruned: 1 },
		{
			name: "a line-limited bare page keeps an earlier range",
			older: "long.txt:900-950",
			newer: "long.txt",
			pruned: 0,
		},
		{
			name: "a column-limited bare read keeps an earlier range",
			older: "wide.txt:1-3",
			newer: "wide.txt",
			pruned: 0,
		},
		{
			name: "an unscanned bare page keeps an earlier range",
			older: "huge.log:150000-150010",
			newer: "huge.log",
			pruned: 0,
		},
		{
			name: "a wider range showing an earlier range again replaces it",
			older: "long.txt:100-120",
			newer: "long.txt:90-200",
			pruned: 1,
		},
		{
			name: "a range that only overlaps an earlier range keeps it",
			older: "long.txt:100-120",
			newer: "long.txt:110-200",
			pruned: 0,
		},
		{
			name: "a line changed between two reads keeps the earlier range",
			older: "notes.txt:2-5",
			newer: "notes.txt:1-10",
			pruned: 0,
			edit: true,
		},
	])("$name", async ({ older, newer, pruned, summary, edit }) => {
		const olderResult = await reader.execute("older", { path: older });
		if (edit)
			await Bun.write(
				path.join(cwd, "notes.txt"),
				Array.from({ length: 20 }, (_, i) => `note ${i + 1}${i === 2 ? " edited" : ""}`).join("\n"),
			);
		const newerResult = await reader.execute("newer", { path: newer });
		if (edit)
			await Bun.write(path.join(cwd, "notes.txt"), Array.from({ length: 20 }, (_, i) => `note ${i + 1}`).join("\n"));
		if (summary) expect(newerResult.details?.summary).toBeDefined();
		const entries = [...readEntries("older", older, olderResult), ...readEntries("newer", newer, newerResult)];

		const result = pruneSupersededToolResults(entries, new Tokenizer(), {
			supersedeKey: readToolSupersedeKey,
			supersedeComplete: isCompleteReadResult,
			supersedeShown: shownReadLines,
			protectedTools: [],
			now: Date.now(),
		});

		expect(result.prunedCount).toBe(pruned);
	});
});
