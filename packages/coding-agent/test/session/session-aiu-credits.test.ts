import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, StopReason, Usage } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { CURRENT_SESSION_VERSION } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";

/** Usage carrying a billing frame (`aiuNano`), a recorded miss (`missing`), or neither (a legacy transcript). */
function usage(totalTokens: number, aiuNano?: number, missing?: boolean): Usage {
	return {
		input: totalTokens,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens,
		...(aiuNano === undefined ? {} : { aiu: { nano: aiuNano } }),
		...(missing ? { aiuMissing: true } : {}),
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

/** A Copilot Claude reply unless another provider is named. */
function reply(opts: {
	aiuNano?: number;
	missing?: boolean;
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
		usage: usage(opts.tokens ?? 10, opts.aiuNano, opts.missing),
	};
}

function credits(manager: SessionManager): { nano: number; unknownCalls: number } {
	const stats = manager.getUsageStatistics();
	return { nano: stats.aiuNano, unknownCalls: stats.aiuUnknownCalls };
}

async function writeTranscript(file: string, lines: unknown[]): Promise<void> {
	await fs.mkdir(path.dirname(file), { recursive: true });
	await Bun.write(file, `${lines.map(line => JSON.stringify(line)).join("\n")}\n`);
}

const timestamp = new Date().toISOString();

function header(id: string, cwd: string): Record<string, unknown> {
	return { type: "session", version: CURRENT_SESSION_VERSION, id, timestamp, cwd };
}

function userEntry(id: string): Record<string, unknown> {
	return { type: "message", id, parentId: null, timestamp, message: { role: "user", content: "hi", timestamp: 1 } };
}

function replyEntry(id: string, parentId: string, message: AssistantMessage): Record<string, unknown> {
	return { type: "message", id, parentId, timestamp, message };
}

describe("session AI-credit accounting", () => {
	it("counts credits where calls are recorded and a recorded missing frame as unknown", () => {
		const manager = SessionManager.inMemory();
		manager.appendMessage({ role: "user", content: "hi", timestamp: 1 });
		manager.appendMessage(reply({ aiuNano: 500_000_000 }));
		// A side request the transport recorded as frameless: unknown spend, not free.
		manager.appendModelUsage(
			{
				purpose: "recap",
				api: "openai-responses",
				provider: "github-copilot",
				model: "gpt-5.5",
				usage: usage(20, undefined, true),
				stopReason: "stop",
			},
			{ sessionId: manager.getSessionId(), parentId: manager.getLeafId() },
		);
		// A request that failed before any token never reached the frame, so carries no marker.
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
		const sourceFile = path.join(tempDir.path(), "sessions", "source.jsonl");
		await writeTranscript(sourceFile, [
			header("aiu-source", cwd),
			userEntry("u1"),
			replyEntry("a1", "u1", reply({ aiuNano: 3_000_000_000 })),
			replyEntry("a2", "a1", reply({ missing: true })),
		]);

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

describe("resumed session AI credits", () => {
	const sessions: AgentSession[] = [];
	afterEach(async () => {
		await Promise.all(sessions.splice(0).map(session => session.dispose()));
	});

	async function resume(file: string): Promise<AgentSession> {
		const model = getBundledModel("github-copilot", "claude-sonnet-4.5");
		if (!model) throw new Error("Expected a bundled Copilot Claude model");
		const session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: await SessionManager.open(file),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: new ModelRegistry(createInMemoryAuthStorage()),
		});
		sessions.push(session);
		return session;
	}

	it("shows no credits for a transcript recorded before the billing frame was read", async () => {
		using tempDir = TempDir.createSync("@omp-session-aiu-legacy-");
		const file = path.join(tempDir.path(), "sessions", "legacy.jsonl");
		await writeTranscript(file, [
			header("aiu-legacy", tempDir.path()),
			userEntry("u1"),
			replyEntry("a1", "u1", reply({})),
			replyEntry("a2", "a1", reply({})),
		]);

		const session = await resume(file);
		await session.hydratePersistedSubagents();
		// Neither `0.000+ cr` nor two frameless calls: older builds never read the frame.
		expect(session.getSessionStats().aiu).toBeUndefined();
	});

	it("counts a persisted subagent's credits after a restart", async () => {
		using tempDir = TempDir.createSync("@omp-session-aiu-tree-");
		const file = path.join(tempDir.path(), "sessions", "root.jsonl");
		await writeTranscript(file, [
			header("aiu-root", tempDir.path()),
			userEntry("u1"),
			replyEntry("a1", "u1", reply({ aiuNano: 1_000_000_000 })),
		]);
		await writeTranscript(path.join(tempDir.path(), "sessions", "root", "Worker.jsonl"), [
			header("aiu-worker", tempDir.path()),
			userEntry("w1"),
			replyEntry("w2", "w1", reply({ aiuNano: 2_000_000_000 })),
			replyEntry("w3", "w2", reply({ missing: true })),
		]);

		const session = await resume(file);
		await session.hydratePersistedSubagents();
		expect(session.getSessionStats().aiu).toEqual({ nano: 3_000_000_000, unknownCalls: 1 });
	});
});
