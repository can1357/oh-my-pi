import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { AgentActivityIndex, activityRowsFromProgress } from "../src/activity";

function messageEntry(id: string, timestamp: number, message: Record<string, unknown>): string {
	return JSON.stringify({ type: "message", id, timestamp, message: { timestamp, ...message } });
}

describe("AgentActivityIndex", () => {
	it("normalizes transcript responses and paired tool calls without duplicating terminal rows", async () => {
		using tempDir = TempDir.createSync("activity-index-");
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
		using tempDir = TempDir.createSync("activity-index-tail-");
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
		using tempDir = TempDir.createSync("activity-index-bound-");
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
});
