import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentMessage, type AgentTool } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, TextContent, ToolCall } from "@oh-my-pi/pi-ai";
import * as ai from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
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
		sharedAuthStorage.setRuntimeApiKey("anthropic", "test-key");
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
		// `always` renders the hard, forced reminder.
		expect(session.formatSessionAsText()).not.toContain("<user-request>");
	});

	it("initializes todos once, then continues within the same user turn", async () => {
		scriptedResponses = [
			createToolCallAssistantMessage("todo", {
				op: "init",
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
		expect(request?.systemPrompt?.[1]).toContain("<title>");
	});

	it("does not refresh todo-init titles when the current title is user-authored", async () => {
		await recreateSession({ "title.refreshOnReplan": true });
		await session.setSessionName("Manual parser title", "user");
		const completeSimpleMock = vi.spyOn(ai, "completeSimple");
		scriptedResponses = [
			createToolCallAssistantMessage("todo", {
				op: "init",
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
		// `preferred` renders the soft nudge, never the hard MUST directive.
	});
});
