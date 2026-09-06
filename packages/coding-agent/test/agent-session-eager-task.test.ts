import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent, type AgentMessage, type AgentTool, ThinkingLevel } from "@pk-nerdsaver-ai/pi-agent-core";
import type { TextContent } from "@pk-nerdsaver-ai/pi-ai";
import { AssistantMessageEventStream } from "@pk-nerdsaver-ai/pi-ai/utils/event-stream";
import { getBundledModel } from "@pk-nerdsaver-ai/pi-catalog/models";
import { ModelRegistry } from "@pk-nerdsaver-ai/pi-coding-agent/config/model-registry";
import { Settings } from "@pk-nerdsaver-ai/pi-coding-agent/config/settings";
import { AgentSession } from "@pk-nerdsaver-ai/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@pk-nerdsaver-ai/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@pk-nerdsaver-ai/pi-coding-agent/session/messages";
import { SessionManager } from "@pk-nerdsaver-ai/pi-coding-agent/session/session-manager";
import { TodoTool, type ToolSession } from "@pk-nerdsaver-ai/pi-coding-agent/tools";
import { TempDir } from "@pk-nerdsaver-ai/pi-utils";
import { type } from "arktype";
import { createAssistantMessage } from "./helpers/agent-session-setup";

type ObservedPromptCall = {
	toolChoice: string | undefined;
	toolNames: string[];
	messageRoles: AgentMessage["role"][];
	messageTexts: string[];
	lastMessageRole: AgentMessage["role"];
	lastMessageText: string;
};

type Harness = {
	session: AgentSession;
	observedCalls: ObservedPromptCall[];
	authStorage: AuthStorage;
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

describe("AgentSession eager task prelude", () => {
	let tempDir: TempDir;
	const harnesses: Harness[] = [];

	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-agent-session-eager-task-");
		harnesses.length = 0;
	});

	afterEach(async () => {
		for (const harness of harnesses) {
			await harness.session.dispose();
			harness.authStorage.close();
		}
		harnesses.length = 0;
		vi.restoreAllMocks();
		tempDir.removeSync();
	});

	async function createHarness(
		settingsOverride: Record<string, unknown> = {},
		agentId?: string,
		taskWireName?: string,
		agentKind?: "main" | "sub",
	): Promise<Harness> {
		const observedCalls: ObservedPromptCall[] = [];
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 model to exist");

		const authStorage = await AuthStorage.create(path.join(tempDir.path(), `testauth-${harnesses.length}.db`));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), `models-${harnesses.length}.yml`));
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"task.eager": "always",
			"todo.enabled": false,
			"todo.eager": "default",
			...settingsOverride,
		});
		const sessionManager = SessionManager.inMemory(tempDir.path());

		const mockTaskTool: AgentTool = {
			name: "task",
			label: "Task",
			description: "Mock task tool",
			parameters: type({}),
			execute: async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
			...(taskWireName !== undefined ? { customWireName: taskWireName } : {}),
		};
		const mockBashTool: AgentTool = {
			name: "bash",
			label: "Bash",
			description: "Mock bash tool",
			parameters: type({}),
			execute: async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
		};
		const todoEnabled = settings.get("todo.enabled") === true;
		const toolSession: ToolSession = {
			cwd: tempDir.path(),
			hasUI: false,
			getSessionFile: () => sessionManager.getSessionFile() ?? null,
			getSessionSpawns: () => "*",
			settings,
		};
		const todoTool = todoEnabled ? new TodoTool(toolSession) : undefined;
		const tools: AgentTool[] = todoTool
			? [todoTool as unknown as AgentTool, mockTaskTool, mockBashTool]
			: [mockTaskTool, mockBashTool];

		let session: AgentSession;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools,
				messages: [],
			},
			convertToLlm,
			getToolChoice: () => session?.nextToolChoiceDirective(),
			streamFn: (_model, context, options) => {
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
				const response = createAssistantMessage("done");
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: response });
					stream.push({ type: "done", reason: "stop", message: response });
				});
				return stream;
			},
		});

		const toolRegistry = new Map<string, AgentTool>([
			[mockTaskTool.name, mockTaskTool],
			[mockBashTool.name, mockBashTool],
		]);
		if (todoTool) toolRegistry.set(todoTool.name, todoTool as unknown as AgentTool);

		session = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry,
			toolRegistry,
			agentId,
			agentKind,
		});
		vi.spyOn(session, "evaluateRootCompletionGate").mockReturnValue({
			gate: {
				allDeliverablesPresent: true,
				criteriaSatisfied: true,
				nonSolutionTriggered: false,
				requiredEvidencePresent: true,
				unresolvedBlockersAcknowledged: true,
				scopeValid: true,
			},
			outcome: "pass",
			missingCriteria: [],
			failedCriteria: [],
			unprovenCriteria: [],
		});

		const harness = { session, observedCalls, authStorage };
		harnesses.push(harness);
		return harness;
	}

	it("prepends a hidden eager task reminder without forcing task or repeating the prompt text", async () => {
		const { session, observedCalls } = await createHarness();

		await session.prompt("refactor the parser across modules");

		expect(observedCalls).toHaveLength(1);
		expect(observedCalls[0]?.toolChoice).toBeUndefined();
		expect(observedCalls[0]?.messageRoles).toEqual(["developer", "user"]);
		expect(observedCalls[0]?.messageTexts[0]).toContain("delegation is enabled");
		expect(observedCalls[0]?.messageTexts[0]).toContain("Batch independent slices");
		expect(observedCalls[0]?.messageTexts[0]).toContain("`task`");
		expect(
			observedCalls[0]?.messageTexts.filter(text => text.includes("refactor the parser across modules")),
		).toHaveLength(1);
		expect(observedCalls[0]?.messageTexts[0]).not.toContain("refactor the parser across modules");
	});

	it("skips eager task prelude for prompts ending with a question mark", async () => {
		const { session, observedCalls } = await createHarness();

		await session.prompt("should I refactor the parser?");

		expect(observedCalls).toHaveLength(1);
		expect(observedCalls[0]?.messageRoles).toEqual(["user"]);
		expect(observedCalls[0]?.messageTexts).toEqual(["should I refactor the parser?"]);
	});

	it("skips eager task prelude for prompts ending with an exclamation mark", async () => {
		const { session, observedCalls } = await createHarness();

		await session.prompt("refactor the parser now!");

		expect(observedCalls).toHaveLength(1);
		expect(observedCalls[0]?.messageRoles).toEqual(["user"]);
		expect(observedCalls[0]?.messageTexts).toEqual(["refactor the parser now!"]);
	});

	it("skips eager task prelude for subsequent user messages", async () => {
		const { session, observedCalls } = await createHarness();

		await session.prompt("refactor the parser across modules");
		expect(observedCalls).toHaveLength(1);
		expect(observedCalls[0]?.messageRoles).toEqual(["developer", "user"]);

		observedCalls.length = 0;
		await session.prompt("now update the serializer too");

		expect(observedCalls).toHaveLength(1);
		expect(observedCalls[0]?.toolChoice).toBeUndefined();
		expect(observedCalls[0]?.messageRoles.at(-1)).toBe("user");
		// The turn-1 prelude persists in history; the contract is that NO fresh prelude is
		// prepended adjacent to the new user message on a subsequent turn.
		expect(observedCalls[0]?.messageRoles.at(-2)).not.toBe("developer");
		expect(observedCalls[0]?.messageTexts.at(-1)).toBe("now update the serializer too");
	});

	it("skips eager task prelude when task.eager is disabled", async () => {
		const { session, observedCalls } = await createHarness({ "task.eager": "default" });

		await session.prompt("refactor the parser across modules");

		expect(observedCalls).toHaveLength(1);
		expect(observedCalls[0]?.messageRoles).toEqual(["user"]);
		expect(observedCalls[0]?.messageTexts).toEqual(["refactor the parser across modules"]);
	});

	it("skips eager task prelude when task.eager is preferred (prompt section only, no reminder)", async () => {
		const { session, observedCalls } = await createHarness({ "task.eager": "preferred" });

		await session.prompt("refactor the parser across modules");

		expect(observedCalls).toHaveLength(1);
		expect(observedCalls[0]?.messageRoles).toEqual(["user"]);
		expect(observedCalls[0]?.messageTexts).toEqual(["refactor the parser across modules"]);
	});
	it("prepends eager task prelude when in ultra mode even if task.eager is default", async () => {
		const { session, observedCalls } = await createHarness({ "task.eager": "default" });
		session.setThinkingLevel(ThinkingLevel.Ultra);

		await session.prompt("refactor the parser across modules");

		expect(observedCalls).toHaveLength(1);
		expect(observedCalls[0]?.messageRoles).toEqual(["developer", "user"]);
		expect(observedCalls[0]?.messageTexts[0]).toContain("Task delegation is enabled");
	});

	it("skips eager task prelude for subagent sessions", async () => {
		const { session, observedCalls } = await createHarness({}, "SubAgent", undefined, "sub");

		await session.prompt("refactor the parser across modules");

		expect(observedCalls).toHaveLength(1);
		expect(observedCalls[0]?.messageRoles).toEqual(["user"]);
		expect(observedCalls[0]?.messageTexts).toEqual(["refactor the parser across modules"]);
	});

	it("prepends eager task prelude for a main session with a custom agent id", async () => {
		const { session, observedCalls } = await createHarness({}, "Alice", undefined, "main");

		await session.prompt("refactor the parser across modules");

		expect(observedCalls).toHaveLength(1);
		expect(observedCalls[0]?.messageRoles).toEqual(["developer", "user"]);
		expect(observedCalls[0]?.messageTexts[0]).toContain("delegation is enabled");
	});

	it("prepends both todo and task preludes when both are eager, keeping the forced todo choice", async () => {
		const { session, observedCalls } = await createHarness({
			"todo.enabled": true,
			"todo.eager": "always",
			"todo.reminders": false,
		});

		await session.prompt("refactor the parser across modules");

		expect(observedCalls).toHaveLength(1);
		// eager-todo still forces the todo tool choice on the first turn
		expect(observedCalls[0]?.toolChoice).toBe("todo");
		// both hidden preludes precede the user message: todo first, then task
		expect(observedCalls[0]?.messageRoles).toEqual(["developer", "developer", "user"]);
		const texts = observedCalls[0]?.messageTexts ?? [];
		expect(texts.at(-1)).toBe("refactor the parser across modules");
		// the task reminder is the second prelude (after the todo reminder)
		expect(texts.findIndex(text => text.includes("delegation is enabled"))).toBe(1);
	});

	it("omits batch-call guidance from the eager task reminder when task.batch is disabled", async () => {
		const { session, observedCalls } = await createHarness({ "task.batch": false });

		await session.prompt("refactor the parser across modules");

		expect(observedCalls).toHaveLength(1);
		const reminder = observedCalls[0]?.messageTexts[0] ?? "";
		expect(reminder).toContain("delegation is enabled");
		expect(reminder).not.toContain("Batch independent slices");
	});

	it("renders the task tool's wire name in the eager reminder", async () => {
		const { session, observedCalls } = await createHarness({}, undefined, "delegate");

		await session.prompt("refactor the parser across modules");

		expect(observedCalls).toHaveLength(1);
		const reminder = observedCalls[0]?.messageTexts[0] ?? "";
		expect(reminder).toContain("`delegate`");
		expect(reminder).not.toContain("`task`");
	});
});
