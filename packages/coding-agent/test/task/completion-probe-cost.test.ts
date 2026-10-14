import { afterAll, beforeAll, describe, expect, it, vi } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Model, Usage } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { registerPersistedSubagents } from "@oh-my-pi/pi-coding-agent/registry/persisted-agents";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { startCompletionProbe } from "@oh-my-pi/pi-coding-agent/task/completion-probe";
import { TempDir } from "@oh-my-pi/pi-utils";
import * as path from "node:path";
import { mkdir } from "node:fs/promises";

function usage(cost: number): Usage {
	return {
		input: 10,
		output: 2,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 12,
		cost: { input: cost, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
	};
}

function assistant(target: Model, cost: number, text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: target.api,
		provider: target.provider,
		model: target.id,
		usage: usage(cost),
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

async function flushMicrotasks(): Promise<void> {
	for (let index = 0; index < 8; index++) await Promise.resolve();
}

describe("completion probe cost persistence", () => {
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;

	beforeAll(async () => {
		authStorage = await AuthStorage.create(":memory:");
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterAll(() => authStorage.close());

	it("keeps late successful probe billing in live and cold lifetime totals across branch changes", async () => {
		const target = modelRegistry.getAll().find(candidate => candidate.contextWindow && candidate.contextWindow > 0);
		if (!target) throw new Error("Expected a bundled model with a context window");

		using tempDir = TempDir.createSync("@omp-completion-probe-cost-");
		const rootSessionFile = path.join(tempDir.path(), "main.jsonl");
		const agentDir = path.join(tempDir.path(), "main");
		await Bun.write(rootSessionFile, "");
		await mkdir(agentDir, { recursive: true });
		const sessionManager = SessionManager.create(tempDir.path(), agentDir);
		let session: AgentSession | undefined;
		let sessionManagerClosed = false;
		let restoredSession: SessionManager | undefined;
		const controller = new AbortController();
		const estimates: Array<{ percent: number; cost: number }> = [];
		vi.useFakeTimers();
		try {
			const warmStartId = sessionManager.appendMessage({ role: "user", content: "Warm start", timestamp: 1 });
			sessionManager.appendMessage(assistant(target, 0.25, "Warm answer before probing"));
			sessionManager.appendMessageToBranch(assistant(target, 0.05, "Warm answer on another branch"), warmStartId);
			const agent = new Agent({
				initialState: {
					model: target,
					systemPrompt: ["Test"],
					tools: [],
					messages: sessionManager.buildSessionContext().messages,
				},
			});
			session = new AgentSession({
				agent,
				sessionManager,
				settings: Settings.isolated({ "compaction.enabled": false }),
				modelRegistry,
			});
			session.agent.state.isStreaming = true;
			const pendingProbe = Promise.withResolvers<{
				replyText: string;
				assistantMessage: AssistantMessage;
			}>();
			const probeRequest = vi.spyOn(session, "runEphemeralTurn").mockReturnValue(pendingProbe.promise);

			startCompletionProbe({
				session: () => session ?? null,
				signal: controller.signal,
				onEstimate: (percent, cost) => estimates.push({ percent, cost }),
			});
			vi.advanceTimersByTime(2 * 60_000);
			await flushMicrotasks();
			expect(probeRequest).toHaveBeenCalledTimes(1);
			const interveningLeaf = sessionManager.appendMessage(assistant(target, 0.1, "Warm answer while probing"));
			pendingProbe.resolve({
				replyText: "The task is about 80% complete.",
				assistantMessage: assistant(target, 0.4, "The task is about 80% complete."),
			});
			await flushMicrotasks();
			controller.abort();
			vi.useRealTimers();
			if (session) session.agent.state.isStreaming = false;

			expect(estimates).toEqual([{ percent: 80, cost: 0.4 }]);
			expect(sessionManager.getLeafId()).toBe(interveningLeaf);
			const probeUsage = sessionManager.getEntries().find(entry => entry.type === "model_usage");
			expect(probeUsage).toMatchObject({
				type: "model_usage",
				purpose: "task-completion-probe",
				usage: { cost: { total: 0.4 } },
			});
			if (!probeUsage) throw new Error("Expected probe usage in the live session");
			expect(sessionManager.getBranch().some(entry => entry.id === probeUsage.id)).toBe(false);
			const liveUsageAfterProbe = sessionManager.getUsageStatistics();
			expect(liveUsageAfterProbe.cost).toBeCloseTo(0.8, 9);
			expect(liveUsageAfterProbe.subagentCost).toBe(0);

			await sessionManager.flush();
			const flushedFile = sessionManager.getSessionFile();
			if (!flushedFile) throw new Error("Expected the flushed session file");
			const reopenedBeforeClose = await SessionManager.open(flushedFile, undefined, undefined, {
				initialCwd: tempDir.path(),
				suppressBreadcrumb: true,
			});
			try {
				expect(reopenedBeforeClose.getLeafId()).toBe(interveningLeaf);
				const reopenedContext = reopenedBeforeClose.buildSessionContext().messages;
				expect(reopenedContext.map(message => message.role)).toEqual(["user", "assistant", "assistant"]);
				expect(reopenedContext.at(-1)).toMatchObject({
					role: "assistant",
					content: [{ type: "text", text: "Warm answer while probing" }],
				});
				expect(reopenedBeforeClose.getUsageStatistics().cost).toBeCloseTo(0.8, 9);
			} finally {
				await reopenedBeforeClose.close();
			}

			sessionManager.appendMessage(assistant(target, 0.15, "Warm answer after probing"));
			sessionManager.appendMessage({
				role: "toolResult",
				toolCallId: "task-1",
				toolName: "task",
				content: [{ type: "text", text: "Nested task result" }],
				details: { usage: usage(0.75) },
				isError: false,
				timestamp: 4,
			});
			const liveUsageAfterTurns = sessionManager.getUsageStatistics();
			expect(liveUsageAfterTurns.cost).toBeCloseTo(1.7, 9);
			expect(liveUsageAfterTurns.subagentCost).toBeCloseTo(0.75, 9);

			await sessionManager.flush();
			const sessionFile = sessionManager.getSessionFile();
			if (!sessionFile) throw new Error("Expected a persisted subagent session file");
			await session?.dispose();
			session = undefined;
			await sessionManager.close();
			sessionManagerClosed = true;
			restoredSession = await SessionManager.open(sessionFile, undefined, undefined, {
				initialCwd: tempDir.path(),
				suppressBreadcrumb: true,
			});
			const restoredUsage = restoredSession.getUsageStatistics();
			expect(restoredUsage.cost).toBeCloseTo(1.7, 9);
			expect(restoredUsage.subagentCost).toBeCloseTo(0.75, 9);

			const registry = new AgentRegistry();
			await registerPersistedSubagents(registry, rootSessionFile);
			const id = path.basename(sessionFile, ".jsonl");
			const history = registry.get(id)?.history;
			expect(history?.directCost).toBeCloseTo(0.95, 8);
			expect(history?.metrics?.requests).toBe(3);
			expect(history?.metrics?.cost).toBeCloseTo(0.5, 9);
		} finally {
			controller.abort();
			vi.useRealTimers();
			await restoredSession?.close();
			await session?.dispose();
			if (!sessionManagerClosed) await sessionManager.close();
		}
	});

	it("continues on the restored leaf after flushing and reopening before close", async () => {
		const target = modelRegistry.getAll().find(candidate => candidate.contextWindow && candidate.contextWindow > 0);
		if (!target) throw new Error("Expected a bundled model with a context window");

		using tempDir = TempDir.createSync("@omp-late-usage-reopen-");
		const original = SessionManager.create(tempDir.path(), tempDir.path());
		let originalClosed = false;
		let reopened: SessionManager | undefined;
		try {
			original.appendMessage({ role: "user", content: "Prompt A1", timestamp: 1 });
			const answerA1 = original.appendMessage(assistant(target, 0, "Answer A1"));
			original.appendMessage({ role: "user", content: "Prompt A2", timestamp: 2 });
			const answerA2 = original.appendMessage(assistant(target, 0, "Answer A2"));
			const probeUsageId = original.appendModelUsage(
				{
					purpose: "task-completion-probe",
					role: "smol",
					api: target.api,
					provider: target.provider,
					model: target.id,
					usage: usage(0.008),
					stopReason: "stop",
				},
				{ sessionId: original.getSessionId(), parentId: answerA1 },
			);
			if (!probeUsageId) throw new Error("Expected late probe usage to be recorded");
			await original.flush();
			const sessionFile = original.getSessionFile();
			if (!sessionFile) throw new Error("Expected the flushed session file");

			reopened = await SessionManager.open(sessionFile, undefined, undefined, {
				initialCwd: tempDir.path(),
				suppressBreadcrumb: true,
			});
			expect(reopened.getLeafId()).toBe(answerA2);
			expect(reopened.getEntry(probeUsageId)).toMatchObject({
				type: "model_usage",
				parentId: answerA1,
				activeLeafId: answerA2,
			});
			expect(reopened.buildSessionContext().messages.map(message => message.role)).toEqual([
				"user",
				"assistant",
				"user",
				"assistant",
			]);
			expect(reopened.buildSessionContext().messages.at(-1)).toMatchObject({
				role: "assistant",
				content: [{ type: "text", text: "Answer A2" }],
			});
			expect(reopened.getUsageStatistics().cost).toBeCloseTo(0.008, 9);

			await original.close();
			originalClosed = true;
			const promptA3 = reopened.appendMessage({ role: "user", content: "Prompt A3", timestamp: 3 });
			expect(reopened.getEntry(promptA3)?.parentId).toBe(answerA2);
			const answerA3 = reopened.appendMessage(assistant(target, 0, "Answer A3"));
			expect(reopened.buildSessionContext().messages.at(-1)).toMatchObject({
				role: "assistant",
				content: [{ type: "text", text: "Answer A3" }],
			});
			await reopened.flush();
			const continued = await SessionManager.open(sessionFile, undefined, undefined, {
				initialCwd: tempDir.path(),
				suppressBreadcrumb: true,
			});
			try {
				expect(continued.getLeafId()).toBe(answerA3);
				expect(continued.buildSessionContext().messages.at(-1)).toMatchObject({
					role: "assistant",
					content: [{ type: "text", text: "Answer A3" }],
				});
				expect(continued.getUsageStatistics().cost).toBeCloseTo(0.008, 9);
			} finally {
				await continued.close();
			}
			expect(reopened.getUsageStatistics().cost).toBeCloseTo(0.008, 9);
		} finally {
			await reopened?.close();
			if (!originalClosed) await original.close();
		}
	});

	it("replays an explicit cleared leaf after late usage is flushed", async () => {
		const target = modelRegistry.getAll().find(candidate => candidate.contextWindow && candidate.contextWindow > 0);
		if (!target) throw new Error("Expected a bundled model with a context window");

		using tempDir = TempDir.createSync("@omp-cleared-usage-leaf-");
		const original = SessionManager.create(tempDir.path(), tempDir.path());
		let reopened: SessionManager | undefined;
		try {
			original.appendMessage({ role: "user", content: "Prompt before reset", timestamp: 1 });
			const ownerParent = original.appendMessage(assistant(target, 0, "Answer before reset"));
			original.appendMessage({ role: "user", content: "Successor before reset", timestamp: 2 });
			original.resetLeaf();
			const usageId = original.appendModelUsage(
				{
					purpose: "task-completion-probe",
					role: "smol",
					api: target.api,
					provider: target.provider,
					model: target.id,
					usage: usage(0.008),
					stopReason: "stop",
				},
				{ sessionId: original.getSessionId(), parentId: ownerParent },
			);
			if (!usageId) throw new Error("Expected late probe usage to be recorded");

			await original.flush();
			const sessionFile = original.getSessionFile();
			if (!sessionFile) throw new Error("Expected the flushed session file");
			reopened = await SessionManager.open(sessionFile, undefined, undefined, {
				initialCwd: tempDir.path(),
				suppressBreadcrumb: true,
			});

			expect(reopened.getEntry(usageId)).toMatchObject({ type: "model_usage", activeLeafId: null });
			expect(reopened.getLeafId()).toBeNull();
			expect(reopened.getBranch()).toEqual([]);
			expect(reopened.buildSessionContext().messages).toEqual([]);
			expect(reopened.getUsageStatistics().cost).toBeCloseTo(0.008, 9);
		} finally {
			await reopened?.close();
			await original.close();
		}
	});
});
