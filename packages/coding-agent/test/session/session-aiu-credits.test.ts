import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AssistantMessage, StopReason, Usage } from "@oh-my-pi/pi-ai";
import { CURRENT_SESSION_VERSION } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

function usage(totalTokens: number, aiuNano?: number): Usage {
	return {
		input: totalTokens,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens,
		...(aiuNano === undefined ? {} : { aiu: { nano: aiuNano } }),
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

/** A Copilot Claude reply (`reports-aiu`) unless another provider is named. */
function reply(opts: {
	aiuNano?: number;
	tokens?: number;
	stopReason?: StopReason;
	provider?: string;
}): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "ok" }],
		api: "anthropic-messages",
		provider: opts.provider ?? "github-copilot",
		model: "claude-sonnet-5.5",
		stopReason: opts.stopReason ?? "stop",
		timestamp: 1,
		usage: usage(opts.tokens ?? 10, opts.aiuNano),
	};
}

function credits(manager: SessionManager): { nano: number; unknownCalls: number } {
	const stats = manager.getUsageStatistics();
	return { nano: stats.aiuNano, unknownCalls: stats.aiuUnknownCalls };
}

describe("session AI-credit accounting", () => {
	it("counts credits where calls are recorded and marks a missing billing frame as unknown", () => {
		const manager = SessionManager.inMemory();
		manager.appendMessage({ role: "user", content: "hi", timestamp: 1 });
		manager.appendMessage(reply({ aiuNano: 500_000_000 }));
		// A side request whose frame never arrived: unknown spend, not free.
		manager.appendModelUsage(
			{
				purpose: "recap",
				api: "openai-responses",
				provider: "github-copilot",
				model: "gpt-5.5",
				usage: usage(20),
				stopReason: "stop",
			},
			{ sessionId: manager.getSessionId(), parentId: manager.getLeafId() },
		);
		// A request that failed before any token never reached the frame.
		manager.appendMessage(reply({ tokens: 0, stopReason: "error" }));
		// Providers without the frame are neither counted nor unknown.
		manager.appendMessage(reply({ provider: "anthropic" }));
		// A completed task result restates its child's calls; the child's own transcript counts them.
		manager.appendMessage({
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "task",
			content: [{ type: "text", text: "done" }],
			details: { usage: usage(30, 2_000_000_000) },
			isError: false,
			timestamp: 1,
		});

		expect(credits(manager)).toEqual({ nano: 500_000_000, unknownCalls: 1 });
	});

	it("leaves a reset fork's copied calls to its parent, on fork and after reload", async () => {
		using tempDir = TempDir.createSync("@omp-session-aiu-fork-");
		const cwd = path.join(tempDir.path(), "project");
		const sessionDir = path.join(tempDir.path(), "sessions");
		await fs.mkdir(sessionDir, { recursive: true });
		const sourceFile = path.join(sessionDir, "source.jsonl");
		const timestamp = new Date().toISOString();
		const lines = [
			{ type: "session", version: CURRENT_SESSION_VERSION, id: "aiu-source", timestamp, cwd },
			{
				type: "message",
				id: "u1",
				parentId: null,
				timestamp,
				message: { role: "user", content: "hi", timestamp: 1 },
			},
			{ type: "message", id: "a1", parentId: "u1", timestamp, message: reply({ aiuNano: 3_000_000_000 }) },
			{ type: "message", id: "a2", parentId: "a1", timestamp, message: reply({}) },
		];
		await Bun.write(sourceFile, `${lines.map(line => JSON.stringify(line)).join("\n")}\n`);

		const plain = await SessionManager.forkFrom(sourceFile, cwd, path.join(tempDir.path(), "plain"), undefined, {
			suppressBreadcrumb: true,
		});
		expect(credits(plain)).toEqual({ nano: 3_000_000_000, unknownCalls: 1 });

		const reset = await SessionManager.forkFrom(sourceFile, cwd, path.join(tempDir.path(), "reset"), undefined, {
			suppressBreadcrumb: true,
			resetInheritedCost: true,
		});
		// The copies lost their charge on purpose; they must not read as calls with a missing frame.
		expect(credits(reset)).toEqual({ nano: 0, unknownCalls: 0 });
		reset.appendMessage(reply({ aiuNano: 1_000_000_000 }));
		expect(credits(reset)).toEqual({ nano: 1_000_000_000, unknownCalls: 0 });
		await reset.flush();

		const resetFile = reset.getSessionFile();
		if (!resetFile) throw new Error("expected reset fork file");
		const reopened = await SessionManager.open(resetFile);
		expect(credits(reopened)).toEqual({ nano: 1_000_000_000, unknownCalls: 0 });
		await Promise.all([plain.close(), reset.close(), reopened.close()]);
	});
});
