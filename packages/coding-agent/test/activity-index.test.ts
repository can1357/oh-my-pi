import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { AgentActivityIndex, type AgentActivityRow, activityRowsFromProgress } from "../src/activity";

function messageEntry(id: string, timestamp: number, message: Record<string, unknown>): string {
	return JSON.stringify({ type: "message", id, timestamp, message: { timestamp, ...message } });
}

/** An `entry_patch` record that sets the content of the turn `entryId` to one text block. */
function textPatchRecord(id: string, entryId: string, text: string): string {
	return JSON.stringify({
		type: "custom",
		customType: "entry_patch",
		id,
		data: { patches: [{ entryId, message: { content: [{ type: "text", text }] } }] },
	});
}

describe("AgentActivityIndex", () => {
	it("normalizes transcript responses and paired tool calls without duplicating terminal rows", async () => {
		using tempDir = TempDir.createSync("@activity-index-");
		const sessionFile = path.join(tempDir.path(), "worker.jsonl");
		await Bun.write(
			sessionFile,
			`${[
				messageEntry("response-1", 1_000, {
					role: "assistant",
					content: [{ type: "text", text: "Reviewed the parser\nand found one issue." }],
				}),
				messageEntry("tool-call", 2_000, {
					role: "assistant",
					content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "src/a.ts" } }],
				}),
				messageEntry("tool-result", 3_000, {
					role: "toolResult",
					toolCallId: "call-1",
					toolName: "read",
					content: [{ type: "text", text: "file contents" }],
				}),
			].join("\n")}\n`,
		);
		const activity = new AgentActivityIndex();
		await activity.sync("Worker", sessionFile);

		const rows = activity.query();
		expect(rows).toHaveLength(2);
		expect(rows[0]).toMatchObject({
			agentId: "Worker",
			kind: "response",
			entryId: "response-1",
			summary: "Reviewed the parser and found one issue.",
		});
		expect(rows[1]).toMatchObject({
			agentId: "Worker",
			kind: "tool",
			toolName: "read",
			status: "success",
			entryId: "tool-call",
		});
		expect(activity.query({ kinds: new Set(["tool"]) })).toHaveLength(1);
		expect(activity.query({ search: "SRC/A.TS" })).toHaveLength(1);
	});

	it("tails appended JSONL incrementally and scopes rows by agent subtree", async () => {
		using tempDir = TempDir.createSync("@activity-index-tail-");
		const parentFile = path.join(tempDir.path(), "parent.jsonl");
		const childFile = path.join(tempDir.path(), "child.jsonl");
		await Bun.write(parentFile, `${messageEntry("p1", 1_000, { role: "assistant", content: "Parent result" })}\n`);
		await Bun.write(childFile, `${messageEntry("c1", 2_000, { role: "assistant", content: "Child result" })}\n`);
		const activity = new AgentActivityIndex();
		await Promise.all([activity.sync("Parent", parentFile), activity.sync("Child", childFile)]);
		expect(activity.query({ agentIds: new Set(["Parent"]) }).map(row => row.agentId)).toEqual(["Parent"]);

		await fs.appendFile(
			childFile,
			`${messageEntry("c2", 3_000, { role: "assistant", content: "New child result" })}\n`,
		);
		await Promise.all([activity.sync("Parent", parentFile), activity.sync("Child", childFile)]);
		expect(activity.query({ agentIds: new Set(["Parent", "Child"]) }).map(row => row.entryId)).toEqual([
			"p1",
			"c1",
			"c2",
		]);
	});

	it("normalizes live progress into lifecycle, tool, and response rows", () => {
		const rows = activityRowsFromProgress(
			{
				id: "Worker",
				task: "Audit auth",
				status: "running",
				lastUpdate: 4_000,
				currentTool: "read",
				currentToolArgs: "src/auth.ts",
				currentToolStartMs: 3_900,
				recentOutput: ["Found unsafe redirect"],
				recentTools: [{ tool: "grep", args: "redirect", endMs: 3_800 }],
			} as never,
			4_000,
		);
		expect(rows.map(row => row.kind)).toEqual(["tool", "tool", "lifecycle", "response"]);
		expect(rows.at(-1)?.summary).toBe("Found unsafe redirect");
	});

	it("bounds retained rows and drops terminal tool mappings after eviction", async () => {
		using tempDir = TempDir.createSync("@activity-index-bound-");
		const sessionFile = path.join(tempDir.path(), "worker.jsonl");
		const lines: string[] = [];
		for (let index = 0; index < 300; index++) {
			const callId = `call-${index}`;
			lines.push(
				messageEntry(`tool-call-${index}`, index * 2 + 1_000, {
					role: "assistant",
					content: [{ type: "toolCall", id: callId, name: "read", arguments: { path: `src/${index}.ts` } }],
				}),
			);
			lines.push(
				messageEntry(`tool-result-${index}`, index * 2 + 1_001, {
					role: "toolResult",
					toolCallId: callId,
					toolName: "read",
					content: [{ type: "text", text: "ok" }],
				}),
			);
		}
		await Bun.write(sessionFile, `${lines.join("\n")}\n`);
		const activity = new AgentActivityIndex();
		await activity.sync("Worker", sessionFile);
		const rows = activity.query({ agentIds: new Set(["Worker"]), limit: 2_000 });
		expect(rows.length).toBe(256);
		expect(rows[0]?.toolCallId).toBe("call-44");
		expect(rows.at(-1)?.toolCallId).toBe("call-299");
		expect(activity.retainedToolMappings("Worker")).toBe(0);
	});

	it("tails remote transcripts from a bounded offset and refetches after rotation", async () => {
		let transcript = `${"x".repeat(300_000)}\n${messageEntry("recent", 2_000, {
			role: "assistant",
			content: "Recent remote result",
		})}\n`;
		const offsets: number[] = [];
		const activity = new AgentActivityIndex({
			remote: {
				readTranscript: async (_agentId, fromByte) => {
					offsets.push(fromByte);
					const bytes = Buffer.from(transcript);
					if (fromByte >= bytes.byteLength) return { text: "", newSize: bytes.byteLength };
					return { text: bytes.subarray(fromByte).toString("utf-8"), newSize: bytes.byteLength };
				},
			},
		});

		await activity.sync("Guest");
		expect(offsets[0]).toBe(Number.MAX_SAFE_INTEGER);
		expect(offsets[1]).toBe(Buffer.byteLength(transcript) - 256 * 1024);
		expect(activity.query().map(row => row.summary)).toEqual(["Recent remote result"]);

		transcript = `${messageEntry("rotated", 3_000, { role: "assistant", content: "After rotation" })}\n`;
		await activity.sync("Guest");
		expect(activity.query().map(row => row.summary)).toEqual(["After rotation"]);
	});

	it("swallows rejecting remote transcript reads without throwing", async () => {
		const activity = new AgentActivityIndex({
			remote: {
				readTranscript: async () => {
					throw new Error("host unavailable");
				},
			},
		});
		await expect(activity.sync("Guest")).resolves.toBeUndefined();
		expect(activity.query()).toEqual([]);
	});

	it("drops a truncated remote transcript's rows even when the new tail has none", async () => {
		let transcript = `${messageEntry("old", 1_000, { role: "assistant", content: "Old remote result" })}\n`;
		const activity = new AgentActivityIndex({
			remote: {
				readTranscript: async (_agentId, fromByte) => {
					const bytes = Buffer.from(transcript);
					return {
						text: bytes.subarray(Math.min(fromByte, bytes.byteLength)).toString("utf-8"),
						newSize: bytes.byteLength,
					};
				},
			},
		});
		await activity.sync("Guest");
		expect(activity.query().map(row => row.summary)).toEqual(["Old remote result"]);
		expect(activity.recent("Guest").map(row => row.summary)).toEqual(["Old remote result"]);

		transcript = "";
		await activity.sync("Guest");
		expect(activity.query()).toEqual([]);
		expect(activity.recent("Guest")).toEqual([]);
	});

	it("keeps a long response whose text follows a long run of leading whitespace", async () => {
		using tempDir = TempDir.createSync("@activity-index-whitespace-");
		const sessionFile = path.join(tempDir.path(), "worker.jsonl");
		await Bun.write(
			sessionFile,
			`${messageEntry("r1", 1_000, { role: "assistant", content: `${" \n".repeat(5_000)}Visible answer` })}\n`,
		);
		const activity = new AgentActivityIndex();
		await activity.sync("Worker", sessionFile);
		expect(activity.query().map(row => row.summary)).toEqual(["Visible answer"]);
	});

	it("retains the newest rows when one sync ingests a large backlog", async () => {
		using tempDir = TempDir.createSync("@activity-index-backlog-");
		const sessionFile = path.join(tempDir.path(), "worker.jsonl");
		const lines = Array.from({ length: 1_000 }, (_, index) =>
			messageEntry(`r${index}`, 1_000 + index, { role: "assistant", content: `answer ${index}` }),
		);
		await Bun.write(sessionFile, `${lines.join("\n")}\n`);
		const activity = new AgentActivityIndex();
		await activity.sync("Worker", sessionFile);
		const rows = activity.query({ agentIds: new Set(["Worker"]), limit: 2_000 });
		expect(rows).toHaveLength(256);
		expect(rows[0]?.summary).toBe("answer 744");
		expect(rows.at(-1)?.summary).toBe("answer 999");
	});

	// A record can give a turn read earlier a row, so the index keeps what showing a turn's rows takes.
	// Turns that show no row (thinking only, or empty) add no row to the bound on rows: without a bound
	// of their own, an agent's index grows with every such turn its transcript holds.
	it("keeps a bounded number of turns that show no row, and applies a record to a recent one", async () => {
		using tempDir = TempDir.createSync("@activity-index-rowless-");
		const sessionFile = path.join(tempDir.path(), "worker.jsonl");
		const visible = [
			messageEntry("answer", 1_000, { role: "assistant", content: [{ type: "text", text: "First answer" }] }),
			messageEntry("call", 1_001, {
				role: "assistant",
				content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "src/a.ts" } }],
			}),
			messageEntry("result", 1_002, {
				role: "toolResult",
				toolCallId: "call-1",
				toolName: "read",
				content: [{ type: "text", text: "ok" }],
			}),
		];
		await Bun.write(sessionFile, `${visible.join("\n")}\n`);
		const activity = new AgentActivityIndex();
		await activity.sync("Worker", sessionFile);
		type ShownRow = Pick<AgentActivityRow, "kind" | "summary" | "status">;
		const rows = (): ShownRow[] =>
			activity.query().map(row => ({ kind: row.kind, summary: row.summary, status: row.status }));
		const shown: ShownRow[] = [
			{ kind: "response", summary: "First answer", status: "success" },
			{ kind: "tool", summary: "src/a.ts", status: "success" },
		];
		expect(rows()).toEqual(shown);

		// Ten reads, each of 256 turns that show no row: thinking only, or empty.
		for (let read = 0; read < 10; read++) {
			const lines = Array.from({ length: 256 }, (_, n) => {
				const turn = read * 256 + n;
				const content = turn % 2 === 0 ? [{ type: "thinking", thinking: `step ${turn}` }] : [];
				return messageEntry(`quiet-${turn}`, 2_000 + turn, { role: "assistant", content });
			});
			await fs.appendFile(sessionFile, `${lines.join("\n")}\n`);
			await activity.sync("Worker", sessionFile);
			// The two turns that show a row, and at most 256 that show none.
			expect(activity.retainedTurns("Worker")).toBeLessThanOrEqual(2 + 256);
		}
		expect(rows()).toEqual(shown);

		await fs.appendFile(sessionFile, `${textPatchRecord("p1", "quiet-2559", "Late answer")}\n`);
		await activity.sync("Worker", sessionFile);
		expect(rows()).toEqual([...shown, { kind: "response", summary: "Late answer", status: "success" }]);

		// The turns that show a row are kept however many quiet turns followed them.
		await fs.appendFile(sessionFile, `${textPatchRecord("p2", "answer", "ELIDEDMARK answer")}\n`);
		await activity.sync("Worker", sessionFile);
		expect(rows()).toEqual([
			{ kind: "response", summary: "ELIDEDMARK answer", status: "success" },
			...shown.slice(1),
			{ kind: "response", summary: "Late answer", status: "success" },
		]);
	});

	// A record can come before the turn it names, so the index holds what it set until the turn is read.
	// Most such turns never arrive (the record names a tool result, or a turn before the read began):
	// without a bound of their own, an agent's index grows with every such record.
	it("keeps a bounded number of records for turns not read yet, and applies a recent one once its turn is read", async () => {
		using tempDir = TempDir.createSync("@activity-index-early-");
		const sessionFile = path.join(tempDir.path(), "worker.jsonl");
		const answer = messageEntry("answer", 1_000, { role: "assistant", content: "First answer" });
		await Bun.write(sessionFile, `${answer}\n`);
		const activity = new AgentActivityIndex();
		await activity.sync("Worker", sessionFile);

		// Ten reads, each of 256 records for turns that never arrive.
		for (let read = 0; read < 10; read++) {
			const lines = Array.from({ length: 256 }, (_, n) => {
				const record = read * 256 + n;
				return textPatchRecord(`p${record}`, `elsewhere-${record}`, `placeholder ${record}`);
			});
			await fs.appendFile(sessionFile, `${lines.join("\n")}\n`);
			await activity.sync("Worker", sessionFile);
			expect(activity.retainedContentBeforeTurn("Worker")).toBeLessThanOrEqual(256);
		}

		await fs.appendFile(sessionFile, `${textPatchRecord("p-late", "late", "ELIDEDMARK answer")}\n`);
		await activity.sync("Worker", sessionFile);
		const late = messageEntry("late", 3_000, { role: "assistant", content: "HEAVYMARK answer" });
		await fs.appendFile(sessionFile, `${late}\n`);
		await activity.sync("Worker", sessionFile);
		expect(activity.query().map(row => row.summary)).toEqual(["First answer", "ELIDEDMARK answer"]);
	});

	// A first read can show no row (a prompt, no response yet); the next read starts at a line boundary, and its
	// first line is the response the panel must show.
	it("shows the first response a later sync reads when the transcript had no rows yet", async () => {
		using tempDir = TempDir.createSync("@activity-index-no-rows-");
		const sessionFile = path.join(tempDir.path(), "worker.jsonl");
		await Bun.write(sessionFile, `${messageEntry("u1", 1_000, { role: "user", content: "Do the task" })}\n`);
		const activity = new AgentActivityIndex();
		await activity.sync("Worker", sessionFile);
		expect(activity.query()).toEqual([]);
		await fs.appendFile(sessionFile, `${messageEntry("a1", 2_000, { role: "assistant", content: "Task done" })}\n`);
		await activity.sync("Worker", sessionFile);
		expect(activity.query().map(row => row.summary)).toEqual(["Task done"]);
	});
});
