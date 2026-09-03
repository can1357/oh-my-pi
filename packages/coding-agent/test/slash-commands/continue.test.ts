import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel, type MockHandler } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { executeAcpBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/acp-builtins";
import { executeBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import { TempDir } from "@oh-my-pi/pi-utils";
import manualContinuePrompt from "../../src/prompts/system/manual-continue.md" with { type: "text" };

describe("/continue slash command", () => {
	let tempDir: TempDir;
	let session: AgentSession | undefined;
	let authStorage: AuthStorage | undefined;

	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-continue-command-");
	});

	afterEach(async () => {
		await session?.dispose();
		authStorage?.close();
		vi.restoreAllMocks();
	});

	async function createSession(handler: MockHandler): Promise<AgentSession> {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const mock = createMockModel({ handler });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			streamFn: mock.stream,
		});
		authStorage = await AuthStorage.create(":memory:");
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
		});
		return session;
	}

	function createTuiRuntime(activeSession: AgentSession) {
		const setText = vi.fn();
		const showStatus = vi.fn();
		const ctx = {
			session: activeSession,
			editor: { setText },
			showStatus,
		} as unknown as InteractiveModeContext;
		return { runtime: { ctx }, setText, showStatus };
	}

	it("continues from a rewound agent turn without adding a user turn", async () => {
		let providerCalls = 0;
		const replies = ["Turn 1 done", "Turn 2 discarded", "Turn 3 continued"];
		const activeSession = await createSession(() => {
			const content = replies[providerCalls];
			providerCalls++;
			if (!content) throw new Error("Unexpected provider call");
			return { content: [content] };
		});
		await activeSession.prompt("do the first thing");
		const rewindTarget = activeSession.sessionManager
			.getBranch()
			.findLast(entry => entry.type === "message" && entry.message.role === "assistant");
		if (!rewindTarget) throw new Error("Expected an assistant turn to rewind to");
		await activeSession.prompt("do the second thing");
		const navigation = await activeSession.navigateTree(rewindTarget.id, { summarize: false });
		expect(navigation).toMatchObject({ cancelled: false });
		const harness = createTuiRuntime(activeSession);

		expect(await executeBuiltinSlashCommand("/continue", harness.runtime)).toBe(true);
		await activeSession.waitForIdle();

		expect(providerCalls).toBe(3);
		const messages = activeSession.agent.state.messages;
		expect(messages.filter(message => message.role === "user")).toHaveLength(1);
		const assistantTexts = messages
			.filter(message => message.role === "assistant")
			.flatMap(message => message.content)
			.flatMap(block => (block.type === "text" ? [block.text] : []));
		expect(assistantTexts).toEqual(["Turn 1 done", "Turn 3 continued"]);
		const developerMessages = messages.filter(message => message.role === "developer");
		expect(developerMessages).toHaveLength(1);
		expect(developerMessages[0]?.content).toEqual([{ type: "text", text: manualContinuePrompt }]);
		expect(developerMessages[0]).toHaveProperty("attribution", "agent");
		expect(harness.setText).toHaveBeenCalledWith("");
		expect(harness.showStatus).not.toHaveBeenCalled();
	});

	it("refuses a duplicate while the continuation is still scheduled", async () => {
		let providerCalls = 0;
		const activeSession = await createSession(() => {
			providerCalls++;
			return { content: [providerCalls === 1 ? "Turn 1 done" : "Turn 2 continued"] };
		});
		await activeSession.prompt("do the thing");
		const harness = createTuiRuntime(activeSession);

		const firstCommand = executeBuiltinSlashCommand("/continue", harness.runtime);
		const duplicateCommand = executeBuiltinSlashCommand("/continue", harness.runtime);
		expect(await firstCommand).toBe(true);
		expect(await duplicateCommand).toBe(true);
		await activeSession.waitForIdle();

		expect(providerCalls).toBe(2);
		expect(harness.showStatus).toHaveBeenCalledTimes(1);
		expect(harness.showStatus).toHaveBeenCalledWith("Nothing to continue");
	});

	it("reports refusal while the session is streaming", async () => {
		const gate = Promise.withResolvers<void>();
		const streamStarted = Promise.withResolvers<void>();
		let providerCalls = 0;
		const activeSession = await createSession(() => {
			providerCalls++;
			streamStarted.resolve();
			return gate.promise.then(() => ({ content: ["Turn done"] }));
		});
		const firstTurn = activeSession.prompt("do the thing");
		await streamStarted.promise;
		const harness = createTuiRuntime(activeSession);

		expect(await executeBuiltinSlashCommand("/continue", harness.runtime)).toBe(true);
		expect(harness.showStatus).toHaveBeenCalledWith("Nothing to continue");
		expect(providerCalls).toBe(1);

		gate.resolve();
		await firstTurn;
		await activeSession.waitForIdle();
		expect(providerCalls).toBe(1);
	});

	it("reports refusal on an empty transcript without calling the provider", async () => {
		let providerCalls = 0;
		const activeSession = await createSession(() => {
			providerCalls++;
			return { content: ["unused"] };
		});
		const harness = createTuiRuntime(activeSession);

		expect(await executeBuiltinSlashCommand("/continue", harness.runtime)).toBe(true);
		await activeSession.waitForIdle();

		expect(providerCalls).toBe(0);
		expect(harness.showStatus).toHaveBeenCalledWith("Nothing to continue");
	});

	it("keeps text-mode hosts open through the scheduled continuation", async () => {
		let providerCalls = 0;
		const activeSession = await createSession(() => {
			providerCalls++;
			return { content: [providerCalls === 1 ? "Turn 1 done" : "Turn 2 continued"] };
		});
		await activeSession.prompt("do the thing");
		const output = vi.fn();

		const result = await executeAcpBuiltinSlashCommand("/continue", {
			session: activeSession,
			sessionManager: activeSession.sessionManager,
			settings: activeSession.settings,
			cwd: activeSession.sessionManager.getCwd(),
			output,
			refreshCommands: () => {},
			reloadPlugins: async () => {},
			keepTurnOpenUntilIdle: () => activeSession.waitForIdle(),
		});

		expect(result).toEqual({ consumed: true, agentInvoked: true });
		expect(providerCalls).toBe(2);
		expect(output).toHaveBeenCalledWith("Continuing the agent's work.");
	});
});
