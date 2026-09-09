import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { Agent, CompactionCancelledError, type AgentTool } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, UserMessage } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession, type AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { CONTEXT_NOTES_ENTRY_TYPE, getContextNotes } from "@oh-my-pi/pi-coding-agent/session/context-notes";
import {
	createCustomMessage,
	convertToLlm,
	SKILL_PROMPT_MESSAGE_TYPE,
} from "@oh-my-pi/pi-coding-agent/session/messages";
import { buildSessionContext } from "@oh-my-pi/pi-coding-agent/session/session-context";
import type { CompactionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { ExtensionRuntime, loadExtensionFromFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { computeNonMessageTokens } from "@oh-my-pi/pi-coding-agent/modes/utils/context-usage";
import { mnemopiBackend } from "@oh-my-pi/pi-coding-agent/mnemopi/backend";
import type { Tool, ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { ContextNotesTool, NewContextTool } from "@oh-my-pi/pi-coding-agent/tools/context-notes";
import { BUILTIN_TOOL_NAMES } from "@oh-my-pi/pi-coding-agent/tools/builtin-names";
import { GrepTool } from "@oh-my-pi/pi-coding-agent/tools/grep";
import { EvalTool } from "@oh-my-pi/pi-coding-agent/tools/eval";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

const authStorage = createInMemoryAuthStorage();
authStorage.setRuntimeApiKey("anthropic", "test-key");
authStorage.setRuntimeApiKey("openai-codex", "test-key");
const modelRegistry = new ModelRegistry(authStorage);

afterAll(() => {
	authStorage.close();
});

function user(text: string): UserMessage {
	return { role: "user", content: text, timestamp: Date.now() };
}

function assistant(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		stopReason: "stop",
		usage: {
			input: 100,
			output: 20,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 120,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: Date.now(),
	};
}

describe("experimental context management", () => {
	let session: AgentSession | undefined;

	beforeEach(() => {
		vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected network request"));
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await session?.dispose();
		session = undefined;
	});

	async function createCodeModeSession() {
		const mock = createMockModel({
			responses: [
				{
					content: ["Working on the task. ".repeat(100), { type: "toolCall", name: "new_context", arguments: {} }],
				},
				{ content: ["done"] },
			],
		});
		const manager = SessionManager.inMemory();
		const history = [user("old task"), assistant("old result")];
		for (const message of history) manager.appendMessage(message);
		const settings = Settings.isolated({
			"compaction.experimentalContextManagement": true,
			"compaction.keepRecentTokens": 128,
			"compaction.midTurnEnabled": false,
			"providers.openai-codex.codeMode": "on",
		});
		const toolSession: ToolSession = {
			cwd: process.cwd(),
			hasUI: false,
			getSessionFile: () => null,
			getSessionId: () => manager.getSessionId(),
			getSessionSpawns: () => "*",
			sessionManager: manager,
			settings,
		};
		const tools: Tool[] = [
			new ReadTool(toolSession),
			new GrepTool(toolSession),
			new ContextNotesTool(toolSession),
			new NewContextTool(toolSession),
			new EvalTool(toolSession),
		];
		const model = { ...mock.model, provider: "openai-codex" };
		const agent = new Agent({
			initialState: { model, systemPrompt: ["test"], tools, messages: history },
			getApiKey: () => "test-key",
			streamFn: mock.stream,
		});
		session = new AgentSession({
			agent,
			sessionManager: manager,
			settings,
			modelRegistry,
			toolRegistry: new Map(tools.map(tool => [tool.name, tool])),
			builtInToolNames: BUILTIN_TOOL_NAMES,
		});
		await session.setActiveToolsByName(tools.map(tool => tool.name));
		return { session, manager, mock };
	}

	it("exposes new_context directly in Code Mode and rolls over once below the automatic threshold", async () => {
		const { session, manager, mock } = await createCodeModeSession();
		const events: AgentSessionEvent[] = [];
		session.subscribe(event => {
			events.push(event);
		});
		expect(session.getActiveToolNames()).toContain("new_context");
		expect(session.getActiveToolNames()).not.toContain("read");
		const request = "Implement the task; preserve the public API and do not deploy.";
		await session.prompt(request);
		await session.waitForIdle();

		expect(mock.calls).toHaveLength(2);
		expect(mock.calls[0].context.tools?.some(tool => tool.name === "new_context")).toBe(true);
		expect(manager.getEntries().filter(entry => entry.type === "compaction")).toHaveLength(1);
		expect(events.filter(event => event.type === "auto_compaction_start")).toHaveLength(1);
		expect(events.filter(event => event.type === "auto_compaction_end")).toMatchObject([
			{ aborted: false, willRetry: false },
		]);
		expect(
			mock.calls[1].context.messages.filter(
				message => message.role === "user" && JSON.stringify(message.content).includes(request),
			),
		).toHaveLength(1);
		expect(
			mock.calls[1].context.messages.some(message => message.role === "user" && message.content === "old task"),
		).toBe(false);
	});

	it("retains the latest request through successive rollovers and context reconstruction without notes", async () => {
		const { session, manager, mock } = await createCodeModeSession();
		const request = "Keep the API compatible; implement this task without deploying.";
		await session.prompt(request);
		await session.waitForIdle();
		const moreWork = assistant("More progress on the same task. ".repeat(100));
		manager.appendMessage(moreWork);
		session.agent.replaceMessages([...session.agent.state.messages, moreWork]);
		await session.compact();
		expect(manager.getEntries().filter(entry => entry.type === "compaction")).toHaveLength(2);
		expect(mock.calls).toHaveLength(2);
		expect(
			session.agent.state.messages.filter(
				message => message.role === "user" && JSON.stringify(message.content).includes(request),
			),
		).toHaveLength(1);
		const rebuilt = manager.buildSessionContext().messages;
		expect(
			rebuilt.filter(message => message.role === "user" && JSON.stringify(message.content).includes(request)),
		).toHaveLength(1);
	});

	it("closes the lifecycle when cancellation occurs during awaited start dispatch", async () => {
		const { session, manager } = await createCodeModeSession();
		const events: AgentSessionEvent[] = [];
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		session.subscribe(async event => {
			if (event.type !== "auto_compaction_start" && event.type !== "auto_compaction_end") return;
			events.push(event);
			if (event.type === "auto_compaction_start") {
				started.resolve();
				await release.promise;
			}
		});
		const prompt = session.prompt("continue the task");
		try {
			await started.promise;
			expect(session.isCompacting).toBe(true);
			session.abortCompaction();
		} finally {
			release.resolve();
		}
		await prompt;
		await session.waitForIdle();
		expect(events).toMatchObject([
			{ type: "auto_compaction_start" },
			{ type: "auto_compaction_end", aborted: true, willRetry: false },
		]);
		expect(events).toHaveLength(2);
		expect(manager.getEntries().filter(entry => entry.type === "compaction")).toHaveLength(0);
		expect(session.isCompacting).toBe(false);
	});
	it("keeps exact earlier requirements and the latest notebook through three real rollover boundaries", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled model");
		const manager = SessionManager.inMemory();
		const first = [
			user("earliest requirement: preserve the release-blocking migration."),
			assistant("first result"),
			user("second task"),
			assistant("second result"),
		];
		for (const message of first) manager.appendMessage(message);
		const settings = Settings.isolated({
			"compaction.experimentalContextManagement": true,
			"compaction.keepRecentTokens": 1,
		});
		const toolSession: ToolSession = {
			cwd: process.cwd(),
			hasUI: false,
			getSessionFile: () => null,
			getSessionId: () => manager.getSessionId(),
			getSessionSpawns: () => "*",
			sessionManager: manager,
			settings,
		};
		const notesTool = new ContextNotesTool(toolSession);
		const readTool = new ReadTool(toolSession);
		const tools: Tool[] = [readTool, new GrepTool(toolSession), notesTool, new NewContextTool(toolSession)];
		const toolRegistry = new Map<string, AgentTool>(tools.map(tool => [tool.name, tool]));
		const agent = new Agent({
			initialState: { model, systemPrompt: ["test"], tools, messages: first },
		});
		session = new AgentSession({
			agent,
			sessionManager: manager,
			settings,
			modelRegistry,
			toolRegistry,
			builtInToolNames: BUILTIN_TOOL_NAMES,
		});

		await session.compact();
		await notesTool.execute("notebook-one", { text: "First rollover notebook." });
		const second = [user("third task"), assistant("third result"), user("fourth task"), assistant("fourth result")];
		for (const message of second) manager.appendMessage(message);
		agent.replaceMessages([...agent.state.messages, ...second]);
		await session.compact();
		await notesTool.execute("notebook-two", { text: "Second rollover notebook." });
		const third = [user("fifth task"), assistant("fifth result"), user("sixth task"), assistant("sixth result")];
		for (const message of third) manager.appendMessage(message);
		agent.replaceMessages([...agent.state.messages, ...third]);
		await notesTool.execute("notebook-latest", {
			text: "Latest durable notebook: retry only after migration backup.",
		});
		await session.compact();

		const boundaries = manager.getEntries().filter((entry): entry is CompactionEntry => entry.type === "compaction");
		expect(boundaries.map(entry => entry.details)).toEqual([
			{ kind: "experimental-context-rollover", version: 1 },
			{ kind: "experimental-context-rollover", version: 1 },
			{ kind: "experimental-context-rollover", version: 1 },
		]);
		expect(manager.getEntries().filter(entry => entry.type === "message")).toHaveLength(
			first.length + second.length + third.length,
		);

		const history = await readTool.execute("retrieve-earliest-requirement", { path: "history://current/full" });
		const historyText = history.content.find(content => content.type === "text");
		if (historyText?.type !== "text") throw new Error("Expected full history text");
		expect(historyText.text).toContain("earliest requirement: preserve the release-blocking migration.");

		expect(getContextNotes(manager.getBranch())?.text).toBe(
			"Latest durable notebook: retry only after migration backup.",
		);
		const notebook = agent.state.messages.find(
			message => message.role === "custom" && message.customType === CONTEXT_NOTES_ENTRY_TYPE,
		);
		if (notebook?.role !== "custom") throw new Error("Expected persisted context notebook");
		expect(notebook.content).toContain("Latest durable notebook: retry only after migration backup.");
	});

	it("consumes a new context request only after every tool result in its batch is journaled", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled model");
		const manager = SessionManager.inMemory();
		const seed = [
			user("first task"),
			assistant("first result ".repeat(512)),
			user("second task"),
			assistant("second result"),
		];
		for (const message of seed) manager.appendMessage(message);
		const settings = Settings.isolated({
			"compaction.experimentalContextManagement": true,
			"compaction.keepRecentTokens": 512,
		});
		const toolSession: ToolSession = {
			cwd: process.cwd(),
			hasUI: false,
			getSessionFile: () => null,
			getSessionId: () => manager.getSessionId(),
			getSessionSpawns: () => "*",
			sessionManager: manager,
			settings,
		};
		const contextNotes = new ContextNotesTool(toolSession);
		const newContext = new NewContextTool(toolSession);
		const tools: Tool[] = [new ReadTool(toolSession), new GrepTool(toolSession), contextNotes, newContext];
		const observedContexts: string[] = [];
		let providerCalls = 0;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["test"], tools, messages: seed },
			convertToLlm,
			streamFn: (_model, context) => {
				providerCalls++;
				if (providerCalls === 2) observedContexts.push(JSON.stringify(context.messages));
				const reason = providerCalls === 1 ? "toolUse" : "stop";
				const message = assistant("Rollover completed after the tool batch.");
				message.stopReason = reason;
				if (reason === "toolUse") {
					message.content = [
						{
							type: "toolCall",
							id: "batch-notes",
							name: "context_notes",
							arguments: { text: "Notebook saved with the request." },
						},
						{ type: "toolCall", id: "batch-rollover", name: "new_context", arguments: {} },
					];
				}
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: message });
					stream.push({ type: "done", reason, message });
				});
				return stream;
			},
		});
		session = new AgentSession({
			agent,
			sessionManager: manager,
			settings,
			modelRegistry,
			toolRegistry: new Map(tools.map(tool => [tool.name, tool])),
			builtInToolNames: BUILTIN_TOOL_NAMES,
		});

		await session.prompt("save the notebook and roll over");

		const branch = manager.getBranch();
		expect(
			branch.filter(
				entry => entry.type === "message" && entry.message.role === "toolResult" && entry.message.isError,
			),
		).toEqual([]);
		const compactionIndex = branch.findIndex(entry => entry.type === "compaction");
		const batchToolResultIndexes = branch
			.map((entry, index) => ({ entry, index }))
			.filter(
				({ entry }) =>
					entry.type === "message" &&
					entry.message.role === "toolResult" &&
					(entry.message.toolCallId === "batch-notes" || entry.message.toolCallId === "batch-rollover"),
			)
			.map(({ index }) => index);
		expect(providerCalls).toBe(2);
		expect(batchToolResultIndexes).toHaveLength(2);
		expect(compactionIndex).toBeGreaterThan(Math.max(...batchToolResultIndexes));
		expect(getContextNotes(branch)?.text).toBe("Notebook saved with the request.");
		expect(observedContexts.join("\n")).toContain("history://current/full");
		expect(observedContexts.join("\n")).toContain("Notebook saved with the request.");
	});

	async function createExplicitRolloverSession(settingsOverrides: Record<string, unknown>, withRolloverCall: boolean) {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled model");
		const manager = SessionManager.inMemory();
		const history = [
			user("old task"),
			assistant("old result ".repeat(512)),
			user("middle task"),
			assistant("middle result ".repeat(64)),
		];
		for (const message of history) manager.appendMessage(message);
		const settings = Settings.isolated({
			"compaction.experimentalContextManagement": true,
			"compaction.keepRecentTokens": 512,
			...settingsOverrides,
		});
		const toolSession: ToolSession = {
			cwd: process.cwd(),
			hasUI: false,
			getSessionFile: () => null,
			getSessionId: () => manager.getSessionId(),
			getSessionSpawns: () => "*",
			sessionManager: manager,
			settings,
		};
		const tools: Tool[] = [
			new ReadTool(toolSession),
			new GrepTool(toolSession),
			new ContextNotesTool(toolSession),
			new NewContextTool(toolSession),
		];
		let providerCalls = 0;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["test"], tools, messages: history },
			convertToLlm,
			streamFn: (_model, _context) => {
				providerCalls++;
				const reason = providerCalls === 1 && withRolloverCall ? "toolUse" : "stop";
				const message = assistant("Rollover acknowledged.");
				message.stopReason = reason;
				if (reason === "toolUse") {
					message.content = [{ type: "toolCall", id: "rollover-one", name: "new_context", arguments: {} }];
				}
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: message });
					stream.push({ type: "done", reason, message });
				});
				return stream;
			},
		});
		const rolloverSession = new AgentSession({
			agent,
			sessionManager: manager,
			settings,
			modelRegistry,
			toolRegistry: new Map(tools.map(tool => [tool.name, tool])),
			builtInToolNames: BUILTIN_TOOL_NAMES,
		});
		return { rolloverSession, manager, agent, providerCalls: () => providerCalls };
	}

	it("commits an explicit rollover with Auto-Compact disabled and stays inert without a request", async () => {
		const first = await createExplicitRolloverSession({ "compaction.enabled": false }, true);
		session = first.rolloverSession;
		const request = "Ship the audit; keep the interface stable.";
		await first.rolloverSession.prompt(request);
		await first.rolloverSession.waitForIdle();
		expect(first.providerCalls()).toBe(2);
		const boundaries = first.manager
			.getEntries()
			.filter((entry): entry is CompactionEntry => entry.type === "compaction");
		expect(boundaries).toHaveLength(1);
		expect(boundaries[0]?.details).toEqual({ kind: "experimental-context-rollover", version: 1 });

		await first.rolloverSession.dispose();
		session = undefined;
		const second = await createExplicitRolloverSession({ "compaction.enabled": false }, false);
		session = second.rolloverSession;
		await second.rolloverSession.prompt("Continue without rolling over.");
		await second.rolloverSession.waitForIdle();
		expect(second.providerCalls()).toBe(1);
		expect(second.manager.getEntries().filter(entry => entry.type === "compaction")).toHaveLength(0);
	});

	function createRolloverTools(manager: SessionManager, settings: Settings) {
		const toolSession: ToolSession = {
			cwd: process.cwd(),
			hasUI: false,
			getSessionFile: () => null,
			getSessionId: () => manager.getSessionId(),
			getSessionSpawns: () => "*",
			sessionManager: manager,
			settings,
		};
		const contextNotes = new ContextNotesTool(toolSession);
		const tools: Tool[] = [
			new ReadTool(toolSession),
			new GrepTool(toolSession),
			contextNotes,
			new NewContextTool(toolSession),
		];
		return { tools, contextNotes };
	}

	it("retains a user-invoked skill prompt across rollover instead of an older ordinary request", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled model");
		const manager = SessionManager.inMemory();
		const seed = [
			user("plain earlier request"),
			assistant("work in progress ".repeat(512)),
			createCustomMessage(
				SKILL_PROMPT_MESSAGE_TYPE,
				"Run the deployment audit skill and report findings.",
				true,
				undefined,
				new Date().toISOString(),
				"user",
			),
			assistant("skill finished"),
		];
		for (const message of seed) manager.appendMessage(message);
		const settings = Settings.isolated({
			"compaction.experimentalContextManagement": true,
			"compaction.keepRecentTokens": 1,
		});
		const { tools } = createRolloverTools(manager, settings);
		const agent = new Agent({ initialState: { model, systemPrompt: ["test"], messages: seed, tools } });
		session = new AgentSession({
			agent,
			sessionManager: manager,
			settings,
			modelRegistry,
			toolRegistry: new Map(tools.map(tool => [tool.name, tool])),
			builtInToolNames: BUILTIN_TOOL_NAMES,
		});
		await session.compact();
		const messages = session.agent.state.messages;
		const serialized = JSON.stringify(messages);
		expect(
			messages.filter(
				message =>
					message.role === "custom" &&
					(message as { customType?: string }).customType === SKILL_PROMPT_MESSAGE_TYPE,
			),
		).toHaveLength(1);
		expect(serialized).toContain("Run the deployment audit skill and report findings.");
		expect(serialized).not.toContain("plain earlier request");
	});

	it("counts the injected notebook and retained request in the persisted rollover tokensAfter", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled model");
		const manager = SessionManager.inMemory();
		const seed = [
			user("first task"),
			assistant("first result ".repeat(128)),
			user("second task"),
			assistant("second result"),
		];
		for (const message of seed) manager.appendMessage(message);
		const settings = Settings.isolated({
			"compaction.experimentalContextManagement": true,
			"compaction.keepRecentTokens": 1,
		});
		const { tools, contextNotes } = createRolloverTools(manager, settings);
		const agent = new Agent({
			initialState: { model, systemPrompt: ["test"], messages: seed, tools },
		});
		session = new AgentSession({
			agent,
			sessionManager: manager,
			settings,
			modelRegistry,
			toolRegistry: new Map(tools.map(tool => [tool.name, tool])),
			builtInToolNames: BUILTIN_TOOL_NAMES,
		});
		const notebookText = `Durable notebook:\n${"- task state entry line. ".repeat(64)}`;
		await contextNotes.execute("save-notebook", { text: notebookText });
		await session.compact();
		const entry = manager
			.getEntries()
			.find((candidate): candidate is CompactionEntry => candidate.type === "compaction");
		if (!entry) throw new Error("Expected a rollover boundary");
		const expected =
			computeNonMessageTokens(session, agent.tokenizer) +
			agent.tokenizer.countMessages(manager.buildSessionContext().messages);
		expect(entry.tokensAfter).toBe(expected);
		expect(entry.tokensAfter).toBeGreaterThan(agent.tokenizer.countMessages(manager.buildSessionContext().messages));
	});

	it("skips built-in remote memory recall during local rollover while preserving the boundary", async () => {
		const recallSpy = vi.spyOn(mnemopiBackend, "preCompactionContext").mockResolvedValue("recalled context");
		try {
			const model = getBundledModel("anthropic", "claude-sonnet-4-5");
			if (!model) throw new Error("Expected bundled model");
			const manager = SessionManager.inMemory();
			const seed = [
				user("first task"),
				assistant("first result ".repeat(512)),
				user("second task"),
				assistant("second result"),
			];
			for (const message of seed) manager.appendMessage(message);
			const settings = Settings.isolated({
				"compaction.experimentalContextManagement": true,
				"compaction.keepRecentTokens": 1,
				"memory.backend": "mnemopi",
			});
			const { tools } = createRolloverTools(manager, settings);
			const agent = new Agent({ initialState: { model, systemPrompt: ["test"], messages: seed, tools } });
			session = new AgentSession({
				agent,
				sessionManager: manager,
				settings,
				modelRegistry,
				toolRegistry: new Map(tools.map(tool => [tool.name, tool])),
				builtInToolNames: BUILTIN_TOOL_NAMES,
			});
			await session.compact();
			expect(recallSpy).not.toHaveBeenCalled();
			expect(manager.getEntries().filter(candidate => candidate.type === "compaction")).toHaveLength(1);
		} finally {
			recallSpy.mockRestore();
		}
	});

	it("commits no boundary when the run aborts mid-rollover while the compaction hook is parked", async () => {
		const tempDir = TempDir.createSync("@pi-experimental-abort-");
		try {
			const model = getBundledModel("anthropic", "claude-sonnet-4-5");
			if (!model) throw new Error("Expected bundled model");
			const manager = SessionManager.inMemory(tempDir.path());
			const seed = [
				user("first task"),
				assistant("first result ".repeat(512)),
				user("second task"),
				assistant("second result"),
			];
			for (const message of seed) manager.appendMessage(message);
			const settings = Settings.isolated({
				"compaction.experimentalContextManagement": true,
				"compaction.keepRecentTokens": 1,
			});
			const enteredHook = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const runtime = new ExtensionRuntime();
			const extension = await loadExtensionFromFactory(
				pi => {
					pi.on("session_before_compact", async () => {
						enteredHook.resolve();
						await release.promise;
						return {};
					});
				},
				tempDir.path(),
				new EventBus(),
				runtime,
				"experimental-abort",
			);
			const extensionRunner = new ExtensionRunner([extension], runtime, tempDir.path(), manager, modelRegistry);
			const { tools } = createRolloverTools(manager, settings);
			const agent = new Agent({ initialState: { model, systemPrompt: ["test"], messages: seed, tools } });
			session = new AgentSession({
				agent,
				sessionManager: manager,
				settings,
				modelRegistry,
				toolRegistry: new Map(tools.map(tool => [tool.name, tool])),
				builtInToolNames: BUILTIN_TOOL_NAMES,
				extensionRunner,
			});
			const compacted = session.compact();
			await enteredHook.promise;
			session.abort();
			release.resolve();
			await expect(compacted).rejects.toThrow(CompactionCancelledError);
			expect(manager.getEntries().filter(entry => entry.type === "compaction")).toHaveLength(0);
		} finally {
			tempDir.removeSync();
		}
	});
});
