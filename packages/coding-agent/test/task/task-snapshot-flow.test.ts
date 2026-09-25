/*
 * Exercises a saved reviewer branch across two review cycles.
 * Uses real session files and forks to detect mutable history or shared child state.
 */
import { afterEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { loadTaskSnapshot, publishTaskSnapshot } from "@oh-my-pi/pi-coding-agent/task/snapshots";
import { TaskTool } from "@oh-my-pi/pi-coding-agent/task";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { TempDir } from "@oh-my-pi/pi-utils";

// Reads the user turns that a resumed child will see in its active branch.
function userTurns(session: SessionManager): string[] {
	return session
		.getBranch()
		.flatMap(entry =>
			entry.type === "message" && entry.message.role === "user" && typeof entry.message.content === "string"
				? [entry.message.content]
				: [],
		);
}

// Closes all session writers before the temporary project is removed.
describe("task snapshot review cycles", () => {
	const directory = TempDir.createSync("@omp-task-snapshot-flow-");
	const sessions: SessionManager[] = [];

	afterEach(async () => {
		for (const session of sessions.splice(0)) await session.close();
		directory.removeSync();
	});

	// A later review starts from the original warm-up, not the prior review or a source follow-up.
	it("forks independent reviewers from one completed warm-up across review cycles", async () => {
		const cwd = directory.path();
		const parent = SessionManager.create(cwd, path.join(cwd, "sessions"));
		const warmup = SessionManager.create(cwd, path.join(cwd, "sessions"));
		sessions.push(parent, warmup);
		const parentSessionFile = parent.getSessionFile();
		const sourceSessionFile = warmup.getSessionFile();
		if (!parentSessionFile || !sourceSessionFile) throw new Error("Missing session file");
		await parent.ensureOnDisk();

		warmup.appendSessionInit({
			systemPrompt: "Review the base",
			task: "Study BASE",
			tools: ["read", "yield"],
			agent: "reviewer",
			resolvedModel: "test/model",
		});
		warmup.appendMessage({ role: "user", content: "BASE: map review invariants", timestamp: Date.now() });
		const callId = "warmup-yield";
		warmup.appendMessage({
			role: "assistant",
			api: "anthropic-messages",
			provider: "anthropic",
			model: "test-model",
			content: [{ type: "toolCall", id: callId, name: "yield", arguments: { data: "Map complete" } }],
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: Date.now(),
		});
		warmup.appendMessage({
			role: "toolResult",
			toolCallId: callId,
			toolName: "yield",
			content: [{ type: "text", text: "Accepted" }],
			details: { status: "success", type: "result", data: "Map complete" },
			isError: false,
			timestamp: Date.now(),
		});
		await warmup.flush();

		const snapshot = await publishTaskSnapshot({
			parentSessionFile,
			sourceSessionFile,
			label: "review-base",
			agentName: "reviewer",
			agentId: "Warmup",
			agentPrompt: "Review the base",
		});
		// A different agent type cannot inherit the reviewer's saved instructions.
		const taskTool = await TaskTool.create({
			cwd,
			hasUI: false,
			settings: Settings.isolated({ "async.enabled": false }),
			getSessionFile: () => parentSessionFile,
			getSessionSpawns: () => "*",
		} as ToolSession);
		const incompatible = await taskTool.execute("wrong-agent", {
			context: "Review the complete change.",
			tasks: [{ agent: "task", task: "Use the saved reviewer history.", fromSnapshot: "review-base" }],
		});
		expect(incompatible.content.find(part => part.type === "text")?.text).toContain("incompatible agent definition");

		// A published label cannot be replaced by another snapshot.
		await expect(
			publishTaskSnapshot({
				parentSessionFile,
				sourceSessionFile,
				label: "review-base",
				agentName: "reviewer",
				agentId: "Warmup",
			}),
		).rejects.toThrow("already exists");
		warmup.appendMessage({ role: "user", content: "LATER: source follow-up", timestamp: Date.now() });
		await warmup.flush();
		// A follow-up without a new terminal yield must not become a checkpoint.
		await expect(
			publishTaskSnapshot({
				parentSessionFile,
				sourceSessionFile,
				label: "unfinished-followup",
				agentName: "reviewer",
				agentId: "Warmup",
			}),
		).rejects.toThrow("terminal yield");

		const first = await SessionManager.forkFrom(snapshot.filePath, cwd, undefined, undefined, {
			sessionFile: path.join(cwd, "first.jsonl"),
			resetInheritedCost: true,
		});
		const second = await SessionManager.forkFrom(snapshot.filePath, cwd, undefined, undefined, {
			sessionFile: path.join(cwd, "second.jsonl"),
			resetInheritedCost: true,
		});
		sessions.push(first, second);
		first.appendMessage({ role: "user", content: "CYCLE 1: correctness finding", timestamp: Date.now() });
		second.appendMessage({ role: "user", content: "CYCLE 1: security finding", timestamp: Date.now() });

		const persisted = await loadTaskSnapshot({ parentSessionFile, reference: snapshot.id });
		const next = await SessionManager.forkFrom(persisted.filePath, cwd, undefined, undefined, {
			sessionFile: path.join(cwd, "next.jsonl"),
			resetInheritedCost: true,
		});
		sessions.push(next);
		next.appendMessage({ role: "user", content: "CYCLE 2: full PR review", timestamp: Date.now() });

		expect(new Set([first.getSessionId(), second.getSessionId(), next.getSessionId()]).size).toBe(3);
		expect(userTurns(first)).toEqual(["BASE: map review invariants", "CYCLE 1: correctness finding"]);
		expect(userTurns(second)).toEqual(["BASE: map review invariants", "CYCLE 1: security finding"]);
		expect(userTurns(next)).toEqual(["BASE: map review invariants", "CYCLE 2: full PR review"]);
		expect(userTurns(next)).not.toContain("LATER: source follow-up");
		// A damaged saved branch fails closed instead of becoming an empty child.
		await Bun.write(snapshot.filePath, "damaged");
		await expect(loadTaskSnapshot({ parentSessionFile, reference: snapshot.id })).rejects.toThrow("corrupt");
		// Malformed metadata must report corruption instead of throwing a property access error.
		await Bun.write(path.join(path.dirname(snapshot.filePath), "manifest.json"), "null");
		await expect(loadTaskSnapshot({ parentSessionFile, reference: snapshot.label })).rejects.toThrow("corrupt");
	});
});
