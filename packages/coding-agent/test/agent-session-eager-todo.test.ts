import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentMessage, type AgentTool } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, TextContent, ToolCall } from "@oh-my-pi/pi-ai";
import * as ai from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import { AgentSession, type AgentSessionConfig } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { TodoTool } from "@oh-my-pi/pi-coding-agent/tools";
import { setInteractiveHost, TempDir } from "@oh-my-pi/pi-utils";
import { createAssistantMessage } from "./helpers/agent-session-setup";

type ObservedPromptCall = {
	toolChoice: string | undefined;
	toolNames: string[];
	messageRoles: AgentMessage["role"][];
	messageTexts: string[];
	lastMessageRole: AgentMessage["role"];
	lastMessageText: string;
};

function isTextContentBlock(value: unknown): value is TextContent {
	if (!value || typeof value !== "object") return false;
	return (value as TextContent).type === "text" && typeof (value as TextContent).text === "string";
}

function getToolChoiceName(choice: unknown): string | undefined {
	if (!choice) return undefined;
	if (typeof choice === "string") return choice;
	if (typeof choice !== "object" || !("type" in choice)) return undefined;
	const toolChoice = choice as { type?: string; name?: string; function?: { name?: string } };
	if (toolChoice.type === "tool") return toolChoice.name;
	if (toolChoice.type === "function") return toolChoice.name ?? toolChoice.function?.name;
	return undefined;
}

function createToolCallAssistantMessage(name: string, args: Record<string, unknown>): AssistantMessage {
	const toolCall: ToolCall = {
		type: "toolCall",
		id: `call_${name}`,
		name,
		arguments: args,
	};
	return {
		role: "assistant",
		content: [toolCall],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: Date.now(),
	};
}

function createAssistantMessageWithThinking(text: string, thinking: string): AssistantMessage {
	return {
		...createAssistantMessage(text),
		content: [
			{ type: "thinking", thinking },
			{ type: "text", text },
		],
	};
}

function getMessageText(message: AgentMessage): string {
	if (!("content" in message)) {
		return "";
	}
	if (typeof message.content === "string") {
		return message.content;
	}
	if (!Array.isArray(message.content)) {
		return "";
	}
	const text: string[] = [];
	for (const content of message.content) {
		if (isTextContentBlock(content)) text.push(content.text);
	}
	return text.join("\n");
}

describe("AgentSession eager todo enforcement", () => {
	let tempDir: TempDir;
	let session: AgentSession;
	let streamCallCount = 0;
	let scriptedResponses: AssistantMessage[] = [];
	let sharedDir: TempDir;
	let sharedAuthStorage: AuthStorage;
	let sharedModelRegistry: ModelRegistry;
	let previousNoTitle: string | undefined;
	const observedCalls: ObservedPromptCall[] = [];

	async function createSession(
		settingsOverride: Record<string, unknown> = {},
		sessionOverride: Partial<AgentSessionConfig> = {},
	): Promise<void> {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 model to exist");

		const modelRegistry = sharedModelRegistry;
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"todo.enabled": true,
			"todo.eager": "always",
			"todo.reminders": false,
			"title.refreshOnReplan": false,
			...settingsOverride,
		});
		const sessionManager = SessionManager.inMemory(tempDir.path());

		const toolSession: ToolSession = {
			cwd: tempDir.path(),
			hasUI: false,
			getSessionFile: () => sessionManager.getSessionFile() ?? null,
			getSessionSpawns: () => "*",
			settings,
			getTodoPhases: () => session?.getTodoPhases() ?? [],
			// Mirrors sdk.ts wiring: TodoTool commits phases during execute (#6148 removed the message_end replay).
			setTodoPhases: phases => session?.setTodoPhases(phases),
		};
		const todoTool = new TodoTool(toolSession);
		const mockBashTool: AgentTool = {
			name: "bash",
			label: "Bash",
			description: "Mock bash tool",
			parameters: type({}),
			execute: async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
		};

		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [todoTool, mockBashTool],
				messages: [],
			},
			convertToLlm,
			getToolChoice: () => session?.nextToolChoiceDirective(),
			streamFn: (_model, context, options) => {
				streamCallCount++;
				const lastMessage = context.messages.at(-1);
				if (!lastMessage) {
					throw new Error("Expected prompt context to include a message");
				}
				observedCalls.push({
					toolChoice: getToolChoiceName(options?.toolChoice),
					toolNames: (context.tools ?? []).map(tool => tool.name),
					messageRoles: context.messages.map(message => message.role),
					messageTexts: context.messages.map(message => getMessageText(message)),
					lastMessageRole: lastMessage.role,
					lastMessageText: getMessageText(lastMessage),
				});
				const response = scriptedResponses.shift() ?? createAssistantMessage("done");
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: response });
					const reason =
						response.stopReason === "toolUse" || response.stopReason === "length" ? response.stopReason : "stop";
					stream.push({ type: "done", reason, message: response });
				});
				return stream;
			},
		});

		const toolRegistry = new Map<string, AgentTool>([
			[todoTool.name, todoTool as unknown as AgentTool],
			[mockBashTool.name, mockBashTool],
		]);

		session = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry,
			toolRegistry,
			...sessionOverride,
		});
	}

	async function recreateSession(
		settingsOverride: Record<string, unknown> = {},
		sessionOverride: Partial<AgentSessionConfig> = {},
	): Promise<void> {
		await session.dispose();
		streamCallCount = 0;
		scriptedResponses = [];
		observedCalls.length = 0;
		await createSession(settingsOverride, sessionOverride);
	}

	function waitForSessionName(expected: string): Promise<void> {
		if (session.sessionManager.getSessionName() === expected) return Promise.resolve();
		const { promise, resolve } = Promise.withResolvers<void>();
		const unsubscribe = session.sessionManager.onSessionNameChanged(() => {
			if (session.sessionManager.getSessionName() !== expected) return;
			unsubscribe();
			resolve();
		});
		return promise;
	}

	beforeAll(async () => {
		sharedDir = TempDir.createSync("@pi-agent-session-eager-todo-shared-");
		sharedAuthStorage = await AuthStorage.create(path.join(sharedDir.path(), "auth.db"));
		sharedAuthStorage.keys.setRuntime("anthropic", "test-key");
		sharedModelRegistry = new ModelRegistry(sharedAuthStorage, path.join(sharedDir.path(), "models.yml"));
	});

	afterAll(() => {
		sharedAuthStorage.close();
		sharedDir.removeSync();
	});

	beforeEach(async () => {
		previousNoTitle = Bun.env.PI_NO_TITLE;
		delete Bun.env.PI_NO_TITLE;
		tempDir = TempDir.createSync("@pi-agent-session-eager-todo-");
		streamCallCount = 0;
		scriptedResponses = [];
		observedCalls.length = 0;
		await createSession();
	});

	afterEach(async () => {
		if (session) {
			await session.dispose();
		}
		vi.restoreAllMocks();
		if (previousNoTitle === undefined) delete Bun.env.PI_NO_TITLE;
		else Bun.env.PI_NO_TITLE = previousNoTitle;
		tempDir.removeSync();
	});

	it("prepends a hidden eager todo reminder without repeating the prompt text", async () => {
		await session.prompt("list all work trees");

		expect(observedCalls).toHaveLength(1);
		expect(observedCalls[0]).toEqual({
			toolChoice: "todo",
			toolNames: ["todo", "bash"],
			messageRoles: ["developer", "user"],
			messageTexts: [expect.any(String), "list all work trees"],
			lastMessageRole: "user",
			lastMessageText: "list all work trees",
		});
		expect(observedCalls[0]?.messageTexts.filter(text => text.includes("list all work trees"))).toHaveLength(1);
		expect(observedCalls[0]?.messageTexts[0]).not.toContain("list all work trees");
	});

	it("initializes todos once, then continues within the same user turn", async () => {
		scriptedResponses = [
			createToolCallAssistantMessage("todo", {
				op: "init",
				finish_turn: false,
				list: [{ phase: "List worktrees", items: ["List all git worktrees in the current repository"] }],
			}),
			createAssistantMessage("real user turn handled"),
		];

		await session.prompt("list all work trees");

		expect(streamCallCount).toBe(2);
		expect(observedCalls).toHaveLength(2);
		expect(observedCalls[0]).toEqual({
			toolChoice: "todo",
			toolNames: ["todo", "bash"],
			messageRoles: ["developer", "user"],
			messageTexts: [expect.any(String), "list all work trees"],
			lastMessageRole: "user",
			lastMessageText: "list all work trees",
		});
		expect(observedCalls[1]?.toolChoice).toBeUndefined();
		expect(observedCalls[1]?.lastMessageRole).toBe("toolResult");
		expect(observedCalls[1]?.messageRoles.slice(-2)).toEqual(["assistant", "toolResult"]);
		expect(session.getTodoPhases()).toHaveLength(1);
		expect(session.getTodoPhases()[0]?.tasks[0]?.content).toBe("List all git worktrees in the current repository");
	});

	it("refreshes an auto title on todo init from recent user, assistant, and thinking context", async () => {
		await recreateSession({ "title.refreshOnReplan": true });
		await session.setSessionName("Old auto title", "auto");
		const priorUser: AgentMessage = {
			role: "user",
			content: "fix parser recovery",
			timestamp: Date.now() - 2,
		};
		const priorAssistant = createAssistantMessageWithThinking(
			"I found the parser recovery path.",
			"The recovery heuristic should drive the replan title.",
		);
		session.agent.appendMessage(priorUser);
		session.sessionManager.appendMessage(priorUser);
		session.agent.appendMessage(priorAssistant);
		session.sessionManager.appendMessage(priorAssistant);
		const completeSimpleMock = vi.spyOn(ai, "completeSimple").mockResolvedValue({
			stopReason: "stop",
			content: [{ type: "text", text: "<title>Parser recovery replan</title>" }],
		} as never);
		scriptedResponses = [
			createToolCallAssistantMessage("todo", {
				op: "init",
				finish_turn: false,
				list: [{ phase: "Parser", items: ["Rework parser diagnostics around recovery"] }],
			}),
			createAssistantMessage("todo initialized"),
		];

		const titleApplied = waitForSessionName("Parser recovery replan");
		await session.prompt("replan parser diagnostics");
		await titleApplied;

		expect(completeSimpleMock).toHaveBeenCalledTimes(1);
		const request = completeSimpleMock.mock.calls[0]?.[1] as { messages?: Array<{ content?: string }> } | undefined;
		const titleInput = request?.messages?.[0]?.content;
		expect(titleInput).toContain("fix parser recovery");
		expect(titleInput).toContain("I found the parser recovery path.");
		expect(titleInput).toContain("The recovery heuristic should drive the replan title.");
		expect(titleInput).toContain("replan parser diagnostics");
		const metadata = completeSimpleMock.mock.calls[0]?.[2]?.metadata;
		if (!metadata || typeof metadata.user_id !== "string") {
			throw new Error("Expected title request metadata.user_id");
		}
		const userId: unknown = JSON.parse(metadata.user_id);
		if (!userId || typeof userId !== "object" || !("session_id" in userId) || typeof userId.session_id !== "string") {
			throw new Error("Expected title request metadata.user_id.session_id");
		}
		expect(userId.session_id).not.toBe(session.sessionId);
	});

	it("keeps a card title's icon and code when a replan refreshes it", async () => {
		// Tern indexes parked panes by the card; the title model names none, so the refresh must carry it over.
		await recreateSession({ "title.refreshOnReplan": true });
		await session.setSessionName("🧪 FLAKY: Fix flaky park tests", "auto");
		vi.spyOn(ai, "completeSimple").mockResolvedValue({
			stopReason: "stop",
			content: [{ type: "text", text: "<title>Stabilize park test timing</title>" }],
		} as never);
		scriptedResponses = [
			createToolCallAssistantMessage("todo", {
				op: "init",
				finish_turn: false,
				list: [{ phase: "Park", items: ["Stabilize park test timing"] }],
			}),
			createAssistantMessage("todo initialized"),
		];

		const titleApplied = waitForSessionName("🧪 FLAKY: Stabilize park test timing");
		await session.prompt("replan the park tests");
		await titleApplied;

		expect(session.sessionManager.getSessionName()).toBe("🧪 FLAKY: Stabilize park test timing");
	});

	it("forwards the configured title system prompt to the replan refresh path", async () => {
		// Issue #3734: TITLE_SYSTEM.md must apply on todo-init replan refresh,
		// not just first-input titling. Without the threaded override, the
		// bundled prompt silently overwrote auto titles in Plan Mode.
		const customPrompt = "Generate kebab-case titles prefixed with `plan/`.";
		await recreateSession({ "title.refreshOnReplan": true });
		session.setTitleSystemPrompt(customPrompt);
		await session.setSessionName("Old auto title", "auto");
		const priorUser: AgentMessage = {
			role: "user",
			content: "rework parser diagnostics",
			timestamp: Date.now() - 1,
		};
		session.agent.appendMessage(priorUser);
		session.sessionManager.appendMessage(priorUser);
		const completeSimpleMock = vi.spyOn(ai, "completeSimple").mockResolvedValue({
			stopReason: "stop",
			content: [{ type: "text", text: "<title>plan/parser-diagnostics</title>" }],
		} as never);
		scriptedResponses = [
			createToolCallAssistantMessage("todo", {
				op: "init",
				finish_turn: false,
				list: [{ phase: "Parser", items: ["Replan parser diagnostics"] }],
			}),
			createAssistantMessage("todo initialized"),
		];

		const titleApplied = waitForSessionName("plan/parser-diagnostics");
		await session.prompt("replan parser diagnostics");
		await titleApplied;

		expect(completeSimpleMock).toHaveBeenCalledTimes(1);
		const request = completeSimpleMock.mock.calls[0]?.[1] as { systemPrompt?: string[] } | undefined;
		expect(request?.systemPrompt?.[0]).toBe(customPrompt);
	});

	it("does not refresh todo-init titles when the current title is user-authored", async () => {
		await recreateSession({ "title.refreshOnReplan": true });
		await session.setSessionName("Manual parser title", "user");
		const completeSimpleMock = vi.spyOn(ai, "completeSimple");
		scriptedResponses = [
			createToolCallAssistantMessage("todo", {
				op: "init",
				finish_turn: false,
				list: [{ phase: "Parser", items: ["Replan parser diagnostics"] }],
			}),
			createAssistantMessage("todo initialized"),
		];

		await session.prompt("replan parser diagnostics");

		expect(completeSimpleMock).not.toHaveBeenCalled();
		expect(session.sessionManager.getSessionName()).toBe("Manual parser title");
	});

	it("does not refresh todo-init titles for headless subagent sessions", async () => {
		// Issue #5910: a subagent (agentKind "sub") in a non-interactive host has no
		// operator-visible title, so a todo-init replan refresh only wastes a
		// tiny-model LLM call. isInteractiveHost() defaults false under bun test.
		await recreateSession({ "title.refreshOnReplan": true }, { agentKind: "sub" });
		await session.setSessionName("Old auto title", "auto");
		const priorUser: AgentMessage = {
			role: "user",
			content: "rework parser diagnostics",
			timestamp: Date.now() - 1,
		};
		session.agent.appendMessage(priorUser);
		session.sessionManager.appendMessage(priorUser);
		const completeSimpleMock = vi.spyOn(ai, "completeSimple");
		scriptedResponses = [
			createToolCallAssistantMessage("todo", {
				op: "init",
				finish_turn: false,
				list: [{ phase: "Parser", items: ["Replan parser diagnostics"] }],
			}),
			createAssistantMessage("todo initialized"),
		];

		await session.prompt("replan parser diagnostics");

		expect(completeSimpleMock).not.toHaveBeenCalled();
		expect(session.sessionManager.getSessionName()).toBe("Old auto title");
	});

	it("refreshes todo-init titles for a subagent focusable in an interactive host", async () => {
		// A live subagent selected from the Agent Hub renders its session name in
		// the status line, so the interactive host must keep the replan refresh the
		// user enabled — only headless hosts skip it (issue #5910 review follow-up).
		const previousInteractiveHost = setInteractiveHost(true);
		try {
			await recreateSession({ "title.refreshOnReplan": true }, { agentKind: "sub" });
			await session.setSessionName("Old auto title", "auto");
			const priorUser: AgentMessage = {
				role: "user",
				content: "rework parser diagnostics",
				timestamp: Date.now() - 1,
			};
			session.agent.appendMessage(priorUser);
			session.sessionManager.appendMessage(priorUser);
			const completeSimpleMock = vi.spyOn(ai, "completeSimple").mockResolvedValue({
				stopReason: "stop",
				content: [{ type: "text", text: "<title>Parser diagnostics replan</title>" }],
			} as never);
			scriptedResponses = [
				createToolCallAssistantMessage("todo", {
					op: "init",
					finish_turn: false,
					list: [{ phase: "Parser", items: ["Replan parser diagnostics"] }],
				}),
				createAssistantMessage("todo initialized"),
			];

			const titleApplied = waitForSessionName("Parser diagnostics replan");
			await session.prompt("replan parser diagnostics");
			await titleApplied;

			expect(completeSimpleMock).toHaveBeenCalledTimes(1);
			expect(session.sessionManager.getSessionName()).toBe("Parser diagnostics replan");
		} finally {
			setInteractiveHost(previousInteractiveHost);
		}
	});

	it("does not refresh todo-init titles when title refresh on replan is disabled", async () => {
		const completeSimpleMock = vi.spyOn(ai, "completeSimple");
		await session.setSessionName("Old auto title", "auto");
		scriptedResponses = [
			createToolCallAssistantMessage("todo", {
				op: "init",
				finish_turn: false,
				list: [{ phase: "Parser", items: ["Replan parser diagnostics"] }],
			}),
			createAssistantMessage("todo initialized"),
		];

		await session.prompt("replan parser diagnostics");

		expect(completeSimpleMock).not.toHaveBeenCalled();
		expect(session.sessionManager.getSessionName()).toBe("Old auto title");
	});

	it("does not refresh todo-init titles when automatic titles are disabled", async () => {
		Bun.env.PI_NO_TITLE = "1";
		await recreateSession({ "title.refreshOnReplan": true });
		await session.setSessionName("Old auto title", "auto");
		const completeSimpleMock = vi.spyOn(ai, "completeSimple");
		scriptedResponses = [
			createToolCallAssistantMessage("todo", {
				op: "init",
				finish_turn: false,
				list: [{ phase: "Parser", items: ["Replan parser diagnostics"] }],
			}),
			createAssistantMessage("todo initialized"),
		];

		await session.prompt("replan parser diagnostics");

		expect(completeSimpleMock).not.toHaveBeenCalled();
		expect(session.sessionManager.getSessionName()).toBe("Old auto title");
	});

	it("skips eager todo enforcement for prompts ending with a question mark", async () => {
		await session.prompt("list all work trees?");

		expect(observedCalls).toHaveLength(1);
		expect(observedCalls[0]).toEqual({
			toolChoice: undefined,
			toolNames: ["todo", "bash"],
			messageRoles: ["user"],
			messageTexts: ["list all work trees?"],
			lastMessageRole: "user",
			lastMessageText: "list all work trees?",
		});
	});

	it("skips eager todo enforcement for prompts ending with an exclamation mark", async () => {
		await session.prompt("list all work trees!");

		expect(observedCalls).toHaveLength(1);
		expect(observedCalls[0]).toEqual({
			toolChoice: undefined,
			toolNames: ["todo", "bash"],
			messageRoles: ["user"],
			messageTexts: ["list all work trees!"],
			lastMessageRole: "user",
			lastMessageText: "list all work trees!",
		});
	});

	it("skips eager todo enforcement for subsequent user messages", async () => {
		// First prompt: eager todo fires
		await session.prompt("refactor the parser module");
		expect(observedCalls).toHaveLength(1);
		expect(observedCalls[0]?.toolChoice).toBe("todo");

		// Second prompt: eager todo must NOT fire
		observedCalls.length = 0;
		await session.prompt("actually skip that, just fix the typo");
		expect(observedCalls).toHaveLength(1);
		expect(observedCalls[0]).toEqual({
			toolChoice: undefined,
			toolNames: ["todo", "bash"],
			messageRoles: expect.arrayContaining(["user"]),
			messageTexts: expect.arrayContaining(["actually skip that, just fix the typo"]),
			lastMessageRole: "user",
			lastMessageText: "actually skip that, just fix the typo",
		});
	});

	it("prepends the eager todo reminder without forcing the todo tool when todo.eager is preferred", async () => {
		await session.dispose();
		await createSession({ "todo.eager": "preferred" });

		await session.prompt("list all work trees");

		expect(observedCalls).toHaveLength(1);
		expect(observedCalls[0]?.toolChoice).toBeUndefined();
		expect(observedCalls[0]?.messageRoles).toEqual(["developer", "user"]);
		expect(observedCalls[0]?.messageTexts.at(-1)).toBe("list all work trees");
		expect(observedCalls[0]?.messageTexts[0]).not.toContain("list all work trees");
	});

	describe("Todo batch finality", () => {
		beforeEach(() => {
			session.setTodoPhases([
				{
					name: "Work",
					tasks: [
						{ content: "first", status: "in_progress" },
						{ content: "second", status: "pending" },
					],
				},
			]);
		});

		function batch(text: string | undefined, args: Record<string, unknown>[]): AssistantMessage {
			const response = createToolCallAssistantMessage("todo", args[0]);
			response.content = args.map((arguments_, index) => ({
				type: "toolCall",
				id: `todo-final-${index}`,
				name: "todo",
				arguments: arguments_,
			}));
			if (text !== undefined) response.content.unshift({ type: "text", text });
			return response;
		}

		it("finishes with blocked and open tasks without completing them", async () => {
			scriptedResponses = [
				batch("I need your access approval before proceeding.", [
					{ op: "block", task: "first", reason: "Access approval", finish_turn: true },
				]),
			];
			await session.prompt("Record the blocker");
			expect(streamCallCount).toBe(1);
			expect(session.getTodoPhases()[0]?.tasks).toEqual([
				{ content: "first", status: "blocked", blocker: "Access approval" },
				{ content: "second", status: "in_progress" },
			]);
			const persisted = session.sessionManager
				.getBranch()
				.filter(entry => entry.type === "message" && entry.message.role === "toolResult");
			expect(persisted).toHaveLength(1);
		});

		it("finishes an inferred mutation without requiring an explicit op", async () => {
			scriptedResponses = [
				batch("The replacement plan is ready.", [
					{ list: [{ phase: "Replacement", items: ["new task"] }], finish_turn: true },
				]),
			];
			await session.prompt("Replace the plan");
			expect(streamCallCount).toBe(1);
			expect(session.getTodoPhases()[0]?.tasks[0]?.content).toBe("new task");
		});

		it.each([
			{ name: "false", args: { op: "done", task: "first", finish_turn: false }, error: false },
			{ name: "missing", args: { op: "done", task: "first" }, error: true },
			{ name: "null", args: { op: "done", task: "first", finish_turn: null }, error: true },
			{ name: "string", args: { op: "done", task: "first", finish_turn: "true" }, error: true },
			{ name: "view", args: { op: "view", finish_turn: true }, error: false },
		])("continues for $name finish requests", async ({ args, error }) => {
			const before = session.getTodoPhases();
			scriptedResponses = [batch("Final text", [args]), createAssistantMessage("Result handled")];
			await session.prompt("Update the tasks");
			expect(streamCallCount).toBe(2);
			expect(session.agent.state.messages.at(-1)).toMatchObject({
				role: "assistant",
				content: [{ type: "text", text: "Result handled" }],
			});
			const result = session.agent.state.messages.find(message => message.role === "toolResult");
			expect(result?.role === "toolResult" && Boolean(result.isError)).toBe(error);
			if (error || args.op === "view") expect(session.getTodoPhases()).toEqual(before);
			else expect(session.getTodoPhases()[0]?.tasks[0]?.status).toBe("completed");
		});

		it.each([undefined, " \n\t"])("requires nonblank text in the same message: %j", async text => {
			const prior = createAssistantMessage("An earlier response is not this reply.");
			session.agent.appendMessage(prior);
			session.sessionManager.appendMessage(prior);
			scriptedResponses = [
				batch(text, [{ op: "done", task: "first", finish_turn: true }]),
				createAssistantMessage("Result handled"),
			];
			await session.prompt("Update the tasks");
			expect(streamCallCount).toBe(2);
			expect(session.getTodoPhases()[0]?.tasks[0]?.status).toBe("completed");
			expect(observedCalls[1]?.messageRoles).toContain("toolResult");
		});

		it.each(["failure", "view", "mixed", "skipped"])("continues when a sibling is %s", async sibling => {
			const response = batch("Final text", [
				{ op: "done", task: "first", finish_turn: true },
				sibling === "view"
					? { op: "view", finish_turn: false }
					: { op: "done", task: sibling === "failure" ? "missing task" : "second", finish_turn: false },
			]);
			const second = response.content[2];
			if (second.type !== "toolCall") throw new Error("Expected sibling call");
			if (sibling === "mixed") {
				second.name = "bash";
				second.arguments = {};
			}
			if (sibling === "skipped") {
				session.agent.beforeToolCall = ctx =>
					ctx.toolCall.id === second.id ? { block: true, reason: "Sibling blocked" } : undefined;
			}
			scriptedResponses = [response, createAssistantMessage("Sibling result handled")];
			await session.prompt("Update both tasks");
			expect(streamCallCount).toBe(2);
			expect(session.getTodoPhases()[0]?.tasks[0]?.status).toBe("completed");
			expect(session.getTodoPhases()[0]?.tasks[1]?.status).toBe("in_progress");
			expect(observedCalls[1]?.messageRoles.filter(role => role === "toolResult")).toHaveLength(2);
			expect(session.agent.state.messages.at(-1)).toMatchObject({
				role: "assistant",
				content: [{ type: "text", text: "Sibling result handled" }],
			});
		});

		it.each(["steer", "followUp", "aside"] as const)(
			"delivers queued %s input at the normal stop boundary",
			async mode => {
				const todo = session.agent.state.tools.find(tool => tool.name === "todo");
				if (!todo) throw new Error("Expected Todo tool");
				const execute = todo.execute.bind(todo);
				todo.execute = async (...args) => {
					const result = await execute(...args);
					if (mode === "aside") {
						await session.sendCustomMessage(
							{ customType: "async-result", content: "BACKGROUND_RESULT", display: false },
							{ deliverAs: "aside" },
						);
					} else {
						session.agent[mode]({ role: "user", content: "QUEUED_USER_INPUT", timestamp: Date.now() });
					}
					return result;
				};
				scriptedResponses = [
					batch("The first task is complete.", [{ op: "done", task: "first", finish_turn: true }]),
					createAssistantMessage("Queued input handled"),
				];
				await session.prompt("Complete the first task");
				expect(streamCallCount).toBe(2);
				const marker = mode === "aside" ? "BACKGROUND_RESULT" : "QUEUED_USER_INPUT";
				expect(observedCalls[1]?.messageTexts.join("\n")).toContain(marker);
				expect(session.agent.hasQueuedMessages()).toBe(false);
				expect(session.agent.state.messages.at(-1)).toMatchObject({
					role: "assistant",
					content: [{ type: "text", text: "Queued input handled" }],
				});
				expect(session.getTodoPhases()[0]?.tasks[0]?.status).toBe("completed");
				expect(JSON.stringify(session.sessionManager.getBranch())).toContain(marker);
			},
		);

		it.each(["reordered", "missing", "duplicate", "unmatched"])(
			"matches complete batch results by ID: %s",
			async shape => {
				const original = Agent.prototype.setOnTurnEnd;
				vi.spyOn(Agent.prototype, "setOnTurnEnd").mockImplementation(function (this: Agent, callback) {
					original.call(
						this,
						callback &&
							(async (messages, signal, context) => {
								if (context?.toolResults.length === 2) {
									context.toolResults = [...context.toolResults].reverse();
									if (shape === "missing") context.toolResults.pop();
									if (shape === "duplicate") context.toolResults[1] = context.toolResults[0];
									if (shape === "unmatched")
										context.toolResults[0] = { ...context.toolResults[0], toolCallId: "unmatched" };
								}
								await callback(messages, signal, context);
							}),
					);
				});
				await recreateSession();
				scriptedResponses = [
					batch("The updated plan is ready.", [
						{ op: "init", items: ["first"], finish_turn: true },
						{ op: "done", task: "first", finish_turn: false },
					]),
					createAssistantMessage("Unmatched result handled"),
				];
				await session.prompt("Update the plan");
				expect(streamCallCount).toBe(shape === "reordered" ? 1 : 2);
				expect(session.getTodoPhases()[0]?.tasks[0]?.status).toBe("completed");
				expect(
					session.sessionManager
						.getBranch()
						.filter(entry => entry.type === "message" && entry.message.role === "toolResult"),
				).toHaveLength(2);
			},
		);

		it.each(["nit", "blocker"] as const)("preserves terminal advisor %s delivery", async severity => {
			const advisor = createMockModel({
				responses: [
					{
						content: [
							{
								type: "toolCall",
								id: "advice-final",
								name: "advise",
								arguments: { note: "TODO_BOUNDARY_ADVICE", severity },
							},
						],
					},
					{ content: ["Review complete"] },
				],
			});
			await recreateSession(
				{ "advisor.syncBacklog": "strict", "advisor.reviewMode": "agent-end", "advisor.immuneTurns": 0 },
				{ advisorStreamFn: advisor.stream, advisorTools: [] },
			);
			session.settings.setModelRole("advisor", "anthropic/claude-sonnet-4-5");
			expect(session.setAdvisorEnabled(true)).toBe(true);
			scriptedResponses = [
				batch("The plan is ready.", [{ op: "init", items: ["first"], finish_turn: true }]),
				createAssistantMessage("Advisor blocker handled"),
			];
			await session.prompt("Prepare the plan");
			await session.waitForIdle();
			expect(streamCallCount).toBe(severity === "blocker" ? 2 : 1);
			expect(session.getTodoPhases()[0]?.tasks[0]?.content).toBe("first");
			expect(JSON.stringify(session.sessionManager.getBranch())).toContain("TODO_BOUNDARY_ADVICE");
			if (severity === "blocker")
				expect(observedCalls[1]?.messageTexts.join("\n")).toContain("TODO_BOUNDARY_ADVICE");
		});

		it.each([false, true])("preserves Todo reminders unless awaiting the user: %s", async awaitingUser => {
			await recreateSession({ "todo.reminders": true, "todo.remindersMax": 1 });
			let reminders = 0;
			session.subscribe(event => {
				if (event.type === "todo_reminder") reminders++;
			});
			scriptedResponses = [
				batch(awaitingUser ? "Which environment should I use?" : "The plan is ready.", [
					{ op: "init", items: ["first"], finish_turn: true },
				]),
				createAssistantMessage("Reminder handled"),
			];
			await session.prompt("Prepare the plan");
			expect(streamCallCount).toBe(awaitingUser ? 1 : 2);
			expect(reminders).toBe(awaitingUser ? 0 : 1);
			expect(session.getTodoPhases()[0]?.tasks[0]?.status).toBe("in_progress");
		});

		it("runs session_stop hooks and handles their continuation after final Todo updates", async () => {
			const emitSessionStop = vi
				.fn()
				.mockResolvedValueOnce({ continue: true, additionalContext: "STOP_HOOK_INPUT" })
				.mockResolvedValue(undefined);
			const extensionRunner = {
				emit: vi.fn().mockResolvedValue(undefined),
				emitBeforeAgentStart: vi.fn().mockResolvedValue(undefined),
				hasHandlers: (eventType: string) => eventType === "session_stop",
				emitSessionStop,
			} as unknown as ExtensionRunner;
			await recreateSession({}, { extensionRunner });
			scriptedResponses = [
				batch("The plan is ready.", [{ op: "init", items: ["first"], finish_turn: true }]),
				createAssistantMessage("Stop hook handled"),
			];
			await session.prompt("Prepare the plan");
			expect(streamCallCount).toBe(2);
			expect(emitSessionStop).toHaveBeenCalledTimes(2);
			expect(observedCalls[1]?.messageTexts.join("\n")).toContain("STOP_HOOK_INPUT");
			expect(session.getTodoPhases()[0]?.tasks[0]?.content).toBe("first");
		});

		function seedReplay(response: AssistantMessage): AgentMessage[] {
			const messages = [
				{ role: "user", content: "Prepare the work", timestamp: 1 },
				createAssistantMessage("The earlier response is preserved."),
				{ role: "user", content: "Update the plan", timestamp: 2 },
				response,
			] satisfies AgentMessage[];
			for (const message of messages) {
				session.agent.appendMessage(message);
				session.sessionManager.appendMessage(message);
			}
			return messages;
		}

		function expectReplayPreserved(history: AgentMessage[], continuation: AssistantMessage): void {
			const persisted = session.sessionManager
				.getBranch()
				.flatMap(entry => (entry.type === "message" ? [entry.message] : []));
			for (const messages of [session.agent.state.messages, persisted]) {
				expect(messages.slice(0, history.length)).toEqual(history);
				expect(
					messages
						.filter(message => message.role === "assistant" || message.role === "toolResult")
						.map(message => message.role),
				).toEqual(["assistant", "assistant", "toolResult", "assistant"]);
				const lastAssistant = messages.findLast(message => message.role === "assistant");
				expect(lastAssistant?.role).toBe(continuation.role);
				expect(lastAssistant?.content).toEqual(continuation.content);
				const results = messages.filter(message => message.role === "toolResult");
				expect(results).toHaveLength(1);
				expect(results[0]).toMatchObject({ toolCallId: "todo-final-0", toolName: "todo", isError: false });
			}
		}

		it("continues with a Todo reminder after replaying a final Todo init", async () => {
			await recreateSession({ "todo.reminders": true, "todo.remindersMax": 1 });
			let reminders = 0;
			session.subscribe(event => {
				if (event.type === "todo_reminder") reminders++;
			});
			const response = batch("The plan is ready.", [{ op: "init", items: ["first"], finish_turn: true }]);
			const history = seedReplay(response);
			const continuation = createAssistantMessage("Replay reminder handled");
			scriptedResponses = [continuation];

			await session.agent.continue();
			await session.waitForIdle();

			expect(streamCallCount).toBe(1);
			expect(reminders).toBe(1);
			expect(observedCalls[0]?.lastMessageRole).toBe("developer");
			expect(observedCalls[0]?.lastMessageText).toContain("You stopped with 1 incomplete todo item(s)");
			expect(observedCalls[0]?.lastMessageText).toContain("first");
			expect(session.getTodoPhases()[0]?.tasks).toEqual([{ content: "first", status: "in_progress" }]);
			expectReplayPreserved(history, continuation);
		});

		it("runs session_stop and its continuation after replaying a final Todo update", async () => {
			const emitSessionStop = vi
				.fn()
				.mockResolvedValueOnce({ continue: true, additionalContext: "REPLAY_STOP_HOOK_INPUT" })
				.mockResolvedValue(undefined);
			const extensionRunner = {
				emit: vi.fn().mockResolvedValue(undefined),
				emitBeforeAgentStart: vi.fn().mockResolvedValue(undefined),
				hasHandlers: (eventType: string) => eventType === "session_stop",
				emitSessionStop,
			} as unknown as ExtensionRunner;
			await recreateSession({}, { extensionRunner });
			session.setTodoPhases([{ name: "Work", tasks: [{ content: "first", status: "in_progress" }] }]);
			const response = batch("The task is complete.", [{ op: "done", task: "first", finish_turn: true }]);
			const history = seedReplay(response);
			const continuation = createAssistantMessage("Replay stop hook handled");
			scriptedResponses = [continuation];

			await session.agent.continue();
			await session.waitForIdle();

			expect(streamCallCount).toBe(1);
			expect(emitSessionStop).toHaveBeenCalledTimes(2);
			expect(emitSessionStop.mock.calls[0]?.[0]).toMatchObject({
				last_assistant_message: { role: response.role, content: response.content },
			});
			expect(emitSessionStop.mock.calls[1]?.[0]).toMatchObject({
				last_assistant_message: { role: continuation.role, content: continuation.content },
			});
			expect(observedCalls[0]?.messageTexts.join("\n")).toContain("REPLAY_STOP_HOOK_INPUT");
			expect(session.getTodoPhases()[0]?.tasks).toEqual([{ content: "first", status: "completed" }]);
			expectReplayPreserved(history, continuation);
		});

		it("finishes replayed Todo batches before any acknowledgement call", async () => {
			const response = batch("The task is complete.", [{ op: "done", task: "first", finish_turn: true }]);
			session.agent.appendMessage(response);
			session.sessionManager.appendMessage(response);
			await session.agent.continue();
			await session.waitForIdle();
			expect(streamCallCount).toBe(0);
			expect(session.getTodoPhases()[0]?.tasks[0]?.status).toBe("completed");
			expect(
				session.sessionManager
					.getBranch()
					.some(
						entry =>
							entry.type === "message" &&
							entry.message.role === "toolResult" &&
							entry.message.toolCallId === "todo-final-0",
					),
			).toBe(true);
		});
	});
});
