import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent, type AgentMessage, type AgentTool } from "@pk-nerdsaver-ai/pi-agent-core";
import type { AssistantMessage, TextContent, ToolCall } from "@pk-nerdsaver-ai/pi-ai";
import { AssistantMessageEventStream } from "@pk-nerdsaver-ai/pi-ai/utils/event-stream";
import { getBundledModel } from "@pk-nerdsaver-ai/pi-catalog/models";
import { ModelRegistry } from "@pk-nerdsaver-ai/pi-coding-agent/config/model-registry";
import { Settings } from "@pk-nerdsaver-ai/pi-coding-agent/config/settings";
import { AgentSession } from "@pk-nerdsaver-ai/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@pk-nerdsaver-ai/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@pk-nerdsaver-ai/pi-coding-agent/session/messages";
import { SessionManager } from "@pk-nerdsaver-ai/pi-coding-agent/session/session-manager";
import type { ToolSession } from "@pk-nerdsaver-ai/pi-coding-agent/tools";
import { TodoTool } from "@pk-nerdsaver-ai/pi-coding-agent/tools";
import { TempDir } from "@pk-nerdsaver-ai/pi-utils";
import { type } from "arktype";
import eagerTodoPrompt from "../src/prompts/system/eager-todo.md" with { type: "text" };
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
	return message.content
		.filter(isTextContentBlock)
		.map(content => content.text)
		.join("\n");
}

describe("AgentSession eager todo enforcement", () => {
	let tempDir: TempDir;
	let session: AgentSession;
	let streamCallCount = 0;
	let scriptedResponses: AssistantMessage[] = [];
	let authStorage: AuthStorage | undefined;
	const observedCalls: ObservedPromptCall[] = [];

	async function createSession(settingsOverride: Record<string, unknown> = {}): Promise<void> {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 model to exist");

		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"todo.enabled": true,
			"todo.eager": "always",
			"todo.reminders": false,
			...settingsOverride,
		});
		const sessionManager = SessionManager.inMemory(tempDir.path());

		const toolSession: ToolSession = {
			cwd: tempDir.path(),
			hasUI: false,
			getSessionFile: () => sessionManager.getSessionFile() ?? null,
			getSessionSpawns: () => "*",
			settings,
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
		});
	}

	beforeEach(async () => {
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
		authStorage?.close();
		authStorage = undefined;
		tempDir.removeSync();
	});

	it("keeps eager init instructions aligned with the todo schema", () => {
		expect(eagerTodoPrompt).toContain("single `init` op");
		expect(eagerTodoPrompt).toContain("phase names and task-label strings");
		expect(eagerTodoPrompt).not.toContain("`details`");
		expect(eagerTodoPrompt).not.toContain("in_progress");
		expect(eagerTodoPrompt).not.toContain("pending");
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
		expect(observedCalls[0]?.messageTexts[0]).toContain("You MUST call");
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
		authStorage?.close();
		await createSession({ "todo.eager": "preferred" });

		await session.prompt("list all work trees");

		expect(observedCalls).toHaveLength(1);
		expect(observedCalls[0]?.toolChoice).toBeUndefined();
		expect(observedCalls[0]?.messageRoles).toEqual(["developer", "user"]);
		expect(observedCalls[0]?.messageTexts.at(-1)).toBe("list all work trees");
		expect(observedCalls[0]?.messageTexts[0]).not.toContain("list all work trees");
		// `preferred` renders the soft nudge, never the hard MUST directive.
		expect(observedCalls[0]?.messageTexts[0]).toContain("Consider calling");
		expect(observedCalls[0]?.messageTexts[0]).not.toContain("You MUST call");
		expect(observedCalls[0]?.messageTexts[0]).not.toContain("Before substantive work, create a phased todo.");
	});
});
