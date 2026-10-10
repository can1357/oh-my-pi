import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
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
import { EditTool } from "@oh-my-pi/pi-coding-agent/edit";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import { isCompleteReadResult, readResultReusesRows } from "@oh-my-pi/pi-coding-agent/tools/read-supersede";
import type { ReadToolDetails } from "@oh-my-pi/pi-tui/tools/read";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

const rows = (edits: Record<number, string> = {}): string =>
	Array.from({ length: 40 }, (_, i) => edits[i + 1] ?? `row ${i + 1}`).join("\n");

let cwd: string;
let reader: ReadTool;
let editor: EditTool;
// The messages the session reports as live context; tests append a read result to "send" it to the model.
let live: unknown[];

beforeAll(async () => {
	cwd = await fs.mkdtemp(path.join(os.tmpdir(), "read-elide-rows-"));
	const session = {
		cwd,
		hasUI: false,
		getSessionFile: () => path.join(cwd, "session.jsonl"),
		getSessionSpawns: () => "*",
		settings: Settings.isolated({ "lsp.enabled": false }),
		sessionManager: { buildSessionContext: () => ({ messages: live }) },
	} as unknown as ToolSession;
	reader = new ReadTool(session);
	editor = new EditTool(session, "hashline");
});

beforeEach(async () => {
	live = [];
	await Bun.write(path.join(cwd, "rows.txt"), `${rows()}\n`);
});

afterAll(async () => {
	await removeWithRetries(cwd);
});

function text(result: AgentToolResult<ReadToolDetails>): string {
	return result.content.flatMap(block => (block.type === "text" ? [block.text] : [])).join("\n");
}

function send(id: string, result: AgentToolResult<ReadToolDetails>): void {
	live.push({
		role: "toolResult",
		toolCallId: id,
		toolName: "read",
		content: result.content,
		details: result.details,
		isError: false,
	});
}

describe("read rows already in context", () => {
	test("replaces rows an earlier read still in context returned with one marker", async () => {
		const first = await reader.execute("first", { path: "rows.txt" });
		expect(text(first)).toContain("7:row 7");
		send("first", first);

		const second = await reader.execute("second", { path: "rows.txt:5-30" });
		const body = text(second);
		// The read pads the requested 5-30 with block context, so the marker spans a little more.
		expect(body).toMatch(/\[\d+-\d+ unchanged since earlier read\]/);
		expect(body).not.toContain("row 6");
		expect(second.details?.reusedRows).toBeGreaterThanOrEqual(26);
	});

	test("an edit anchored on an elided row still lands, since the model saw that row earlier", async () => {
		send("first", await reader.execute("first", { path: "rows.txt" }));
		const second = await reader.execute("second", { path: "rows.txt" });
		expect(text(second)).toContain("[1-40 unchanged since earlier read]");

		const header = text(second).split("\n")[0];
		const result = await editor.execute("edit", { input: `${header}\nPUT 20.=20:\n+row twenty\n` });

		expect(result.content.map(block => (block.type === "text" ? block.text : "")).join("\n")).not.toContain(
			"never displayed",
		);
		expect(await Bun.file(path.join(cwd, "rows.txt")).text()).toContain("\nrow twenty\n");
	});

	test("keeps changed rows and elides only the identical runs around them", async () => {
		send("first", await reader.execute("first", { path: "rows.txt" }));
		await Bun.write(path.join(cwd, "rows.txt"), `${rows({ 10: "row ten", 11: "row eleven" })}\n`);

		const body = text(await reader.execute("second", { path: "rows.txt" }));
		expect(body).toContain("[1-9 unchanged since earlier read]");
		expect(body).toContain("10:row ten");
		expect(body).toContain("11:row eleven");
		expect(body).toContain("[12-40 unchanged since earlier read]");
	});

	test("returns every row once the earlier read left the context", async () => {
		send("first", await reader.execute("first", { path: "rows.txt" }));
		live = [];

		const second = await reader.execute("second", { path: "rows.txt" });
		expect(text(second)).toContain("7:row 7");
		expect(second.details?.reusedRows).toBeUndefined();
	});

	test("a read resting on an earlier read does not supersede it when pruning", async () => {
		const entries = (id: string, result: AgentToolResult<ReadToolDetails>): SessionEntry[] => {
			const timestamp = Date.now();
			return [
				{
					type: "message",
					id: `${id}-call`,
					parentId: null,
					timestamp: new Date(timestamp).toISOString(),
					message: {
						role: "assistant",
						content: [{ type: "toolCall", id, name: "read", arguments: { path: "rows.txt" } }],
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
		};
		const prune = (sessionEntries: SessionEntry[]) =>
			pruneSupersededToolResults(sessionEntries, new Tokenizer(), {
				supersedeKey: readToolSupersedeKey,
				supersedeComplete: isCompleteReadResult,
				supersedeDependent: readResultReusesRows,
				protectedTools: [],
				now: Date.now(),
			}).prunedCount;

		const first = await reader.execute("first", { path: "rows.txt" });
		send("first", first);
		const elided = await reader.execute("second", { path: "rows.txt" });
		expect(elided.details?.reusedRows).toBe(40);
		expect(prune([...entries("first", first), ...entries("second", elided)])).toBe(0);

		// Control: the same pair with a full second read is a plain supersede.
		live = [];
		const full = await reader.execute("third", { path: "rows.txt" });
		expect(prune([...entries("first", first), ...entries("third", full)])).toBe(1);
	});
});
