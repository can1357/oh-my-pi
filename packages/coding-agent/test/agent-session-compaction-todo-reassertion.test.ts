import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentMessage, type AgentTool } from "@oh-my-pi/pi-agent-core";
import * as compactionModule from "@oh-my-pi/pi-agent-core/compaction";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TodoTool, type ToolSession, USER_TODO_EDIT_CUSTOM_TYPE } from "@oh-my-pi/pi-coding-agent/tools";
import { TempDir } from "@oh-my-pi/pi-utils";

// Post-compaction todo reassertion (#16738): when a todo list survives compaction, the
// eager prelude path stays silent by design (it bails once phases exist), so the
// auto-continuation turn must carry a reminder-only reassertion of the surviving
// list — compaction summarized away the `todo` tool results that created it. The
// reassertion renders the full canonical state (statuses and blocker notes included)
// and is skipped when the latest todo snapshot still lies inside the kept tail, where
// the model already sees it.
//
// The goal-mode auto-continuation prompt already carries a `<todo_context>` block
// (bracket-first, no blocker notes), so these tests assert on the canonical render
// shape of the reassertion — `<content> [<status>]` / `[blocked: <note>]` — which only
// the post-compaction reassertion produces. Custom nudge messages are also normalized
// into the context before they reach the provider stream, so message roles are not
// asserted.

const AUTO_CONTINUE_MARKER = "Resume the user's latest intent";

type ObservedPromptCall = {
	callIndex: number;
	toolChoice: string | undefined;
	text: string;
};

type WaitForCall = (predicate: (call: ObservedPromptCall) => boolean) => Promise<ObservedPromptCall>;

type Harness = {
	session: AgentSession;
	observedCalls: ObservedPromptCall[];
	sessionManager: SessionManager;
	waitForCall: WaitForCall;
};

function getToolChoiceName(choice: unknown): string | undefined {
	if (!choice) return undefined;
	if (typeof choice === "string") return choice;
	if (typeof choice !== "object" || !("type" in choice)) return undefined;
	const toolChoice = choice as { type?: string; name?: string; function?: { name?: string } };
	if (toolChoice.type === "tool") return toolChoice.name;
	if (toolChoice.type === "function") return toolChoice.name ?? toolChoice.function?.name;
	return undefined;
}

function isTextContentBlock(value: unknown): value is { type: "text"; text: string } {
	return (
		typeof value === "object" &&
		value !== null &&
		(value as { type?: unknown }).type === "text" &&
		typeof (value as { text?: unknown }).text === "string"
	);
}

function getMessageText(message: AgentMessage): string {
	if (!("content" in message)) return "";
	if (typeof message.content === "string") return message.content;
	if (!Array.isArray(message.content)) return "";
	const text: string[] = [];
	for (const content of message.content) {
		if (isTextContentBlock(content)) text.push(content.text);
	}
	return text.join("\n");
}

function createAssistantResponse(text: string) {
	return {
		role: "assistant" as const,
		content: [{ type: "text" as const, text }],
		api: "anthropic-messages" as const,
		provider: "anthropic" as const,
		model: "claude-sonnet-4-5",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop" as const,
		timestamp: Date.now(),
	};
}

/** Short-circuit the LLM summary so compaction completes without a network call. */
function stubCompaction(firstKeptEntryId?: string): void {
	vi.spyOn(compactionModule, "compact").mockImplementation(async preparation => ({
		summary: "compacted",
		shortSummary: undefined,
		firstKeptEntryId: firstKeptEntryId ?? preparation.firstKeptEntryId,
		tokensBefore: preparation.tokensBefore,
		details: {},
	}));
}

/** Emit a high-usage assistant turn to drive threshold (context-full) auto-compaction. */
function emitHighUsageTurn(session: AgentSession): void {
	const assistantMsg = {
		role: "assistant" as const,
		content: [{ type: "text" as const, text: "Done." }],
		api: "anthropic-messages" as const,
		provider: "anthropic" as const,
		model: "claude-sonnet-4-5",
		stopReason: "stop" as const,
		usage: {
			input: 190_000,
			output: 1_000,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 191_000,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: Date.now(),
	};
	session.agent.emitExternalEvent({ type: "message_end", message: assistantMsg });
	session.agent.emitExternalEvent({ type: "agent_end", messages: [assistantMsg] });
}

describe("AgentSession post-compaction todo reassertion", () => {
	let tempDir: TempDir;
	let sharedDir: TempDir;
	let sharedAuthStorage: AuthStorage;
	let sharedModelRegistry: ModelRegistry;
	const cleanups: Array<() => Promise<void>> = [];

	beforeAll(async () => {
		sharedDir = TempDir.createSync("@pi-agent-session-compaction-todo-reassertion-shared-");
		sharedAuthStorage = await AuthStorage.create(path.join(sharedDir.path(), "auth.db"));
		sharedAuthStorage.keys.setRuntime("anthropic", "test-key");
		sharedModelRegistry = new ModelRegistry(sharedAuthStorage, path.join(sharedDir.path(), "models.yml"));
	});

	afterAll(() => {
		sharedAuthStorage.close();
		sharedDir.removeSync();
	});

	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-agent-session-compaction-todo-reassertion-");
		cleanups.length = 0;
	});

	afterEach(async () => {
		for (const cleanup of cleanups) await cleanup();
		cleanups.length = 0;
		tempDir.removeSync();
		vi.restoreAllMocks();
	});

	async function createHarness(settingsOverride: Record<string, unknown> = {}): Promise<Harness> {
		const observedCalls: ObservedPromptCall[] = [];
		const waiters: Array<{
			predicate: (call: ObservedPromptCall) => boolean;
			resolve: (call: ObservedPromptCall) => void;
		}> = [];
		const defaultModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!defaultModel) throw new Error("Expected claude-sonnet-4-5 model to exist");
		const model = { ...defaultModel, contextWindow: 200_000, maxTokens: 64_000 };

		const settings = Settings.isolated({
			"compaction.enabled": true,
			"compaction.asyncEnabled": false,
			"compaction.autoContinue": true,
			"compaction.methodOrder": ["soft"],
			"task.eager": "default",
			"todo.enabled": true,
			"todo.eager": "default",
			"todo.reminders": true,
			...settingsOverride,
		});
		const sessionManager = SessionManager.inMemory(tempDir.path());

		const mockTaskTool: AgentTool = {
			name: "task",
			label: "Task",
			description: "Mock task tool",
			parameters: type({}),
			execute: async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
		};
		const mockBashTool: AgentTool = {
			name: "bash",
			label: "Bash",
			description: "Mock bash tool",
			parameters: type({}),
			execute: async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
		};
		const toolSession: ToolSession = {
			cwd: tempDir.path(),
			hasUI: false,
			getSessionFile: () => sessionManager.getSessionFile() ?? null,
			getSessionSpawns: () => "*",
			settings,
		};
		const todoTool = new TodoTool(toolSession);
		const tools: AgentTool[] = [todoTool as unknown as AgentTool, mockTaskTool, mockBashTool];

		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools, messages: [] },
			convertToLlm,
			getToolChoice: () => session?.nextToolChoiceDirective(),
			streamFn: (_model, context, options) => {
				const call: ObservedPromptCall = {
					callIndex: observedCalls.length,
					toolChoice: getToolChoiceName(options?.toolChoice),
					text: context.messages.map(message => getMessageText(message)).join("\n"),
				};
				observedCalls.push(call);
				for (let i = waiters.length - 1; i >= 0; i--) {
					const waiter = waiters[i];
					if (waiter?.predicate(call)) {
						waiter.resolve(call);
						waiters.splice(i, 1);
					}
				}
				const response = createAssistantResponse("done");
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
			[todoTool.name, todoTool as unknown as AgentTool],
		]);

		const session = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry: sharedModelRegistry,
			toolRegistry,
		});

		const waitForCall: WaitForCall = predicate => {
			const existing = observedCalls.find(predicate);
			if (existing) return Promise.resolve(existing);
			const { promise, resolve } = Promise.withResolvers<ObservedPromptCall>();
			waiters.push({ predicate, resolve });
			return promise;
		};

		cleanups.push(() => session.dispose());
		return { session, observedCalls, sessionManager, waitForCall };
	}

	function activateOngoingGoal(session: AgentSession): void {
		const now = Date.now();
		session.setGoalModeState({
			enabled: true,
			mode: "active",
			goal: {
				id: "compaction-todo-reassertion",
				objective: "finish the parser refactor",
				status: "active",
				tokensUsed: 0,
				timeUsedSeconds: 0,
				createdAt: now,
				updatedAt: now,
			},
		});
	}

	/**
	 * Run the first prompt, add a todo entry that gets summarized away (the keep
	 * boundary lands on a later marker entry), drive a compaction, and resolve with
	 * the compaction auto-continuation provider call (identified by the
	 * auto-continue template marker, distinct from a todo reminder turn).
	 */
	async function runToContinuationWithTodos(
		session: AgentSession,
		sessionManager: SessionManager,
		waitForCall: WaitForCall,
		phases: { name: string; tasks: { content: string; status: string; blocker?: string }[] }[],
	): Promise<ObservedPromptCall> {
		activateOngoingGoal(session);
		await session.prompt("refactor the parser across modules");
		sessionManager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, { phases });
		// The keep boundary starts after the todo entry: the snapshot is summarized away.
		const boundaryEntryId = sessionManager.appendCustomEntry("compaction-boundary-marker", {});
		stubCompaction(boundaryEntryId);
		const continuationPromise = waitForCall(call => call.callIndex > 0 && call.text.includes(AUTO_CONTINUE_MARKER));
		emitHighUsageTurn(session);
		return continuationPromise;
	}

	it("reasserts the surviving todo list with the full canonical state", async () => {
		const { session, sessionManager, waitForCall } = await createHarness();
		const continuation = await runToContinuationWithTodos(session, sessionManager, waitForCall, [
			{
				name: "Work",
				tasks: [
					{ content: "do the thing", status: "pending" },
					{ content: "finish the parser", status: "in_progress" },
					{ content: "awaiting review", status: "pending", blocker: "reviewer feedback" },
					{ content: "done thing", status: "completed" },
				],
			},
		]);

		// Canonical render shape: status/blocker markers trail the task content, and
		// blocked tasks keep their blocker note — none of which the goal-mode
		// <todo_context> block produces.
		expect(continuation.text).toContain("- awaiting review [blocked: reviewer feedback]");
		expect(continuation.text).toContain("- finish the parser [in_progress]");
		expect(continuation.text).toContain("- done thing [completed]");
		// Reminder-only: never a forced tool_choice on the resumed turn.
		expect(continuation.toolChoice).toBeUndefined();
	});

	it("does not reassert when the latest todo snapshot is still inside the kept tail", async () => {
		const { session, sessionManager, waitForCall } = await createHarness();
		activateOngoingGoal(session);
		await session.prompt("refactor the parser across modules");
		// Keep boundary starts at the todo entry itself: the model still sees the snapshot.
		const todoEntryId = sessionManager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, {
			phases: [{ name: "Work", tasks: [{ content: "done thing", status: "completed" }] }],
		});
		stubCompaction(todoEntryId);
		const continuationPromise = waitForCall(call => call.callIndex > 0 && call.text.includes(AUTO_CONTINUE_MARKER));
		emitHighUsageTurn(session);
		const continuation = await continuationPromise;

		// The snapshot is visible in the kept tail, so the canonical reassertion
		// (content-then-marker shape) must not fire.
		expect(continuation.text).not.toContain("- done thing [completed]");
	});

	it("does not reassert when no todo list exists", async () => {
		const { session, waitForCall } = await createHarness();
		activateOngoingGoal(session);
		await session.prompt("refactor the parser across modules");
		stubCompaction();
		const continuationPromise = waitForCall(call => call.callIndex > 0 && call.text.includes(AUTO_CONTINUE_MARKER));
		emitHighUsageTurn(session);
		const continuation = await continuationPromise;

		expect(continuation.text).not.toContain("[completed]");
		expect(continuation.text).not.toContain("[in_progress]");
		expect(continuation.text).not.toContain("[blocked:");
	});

	it("does not reassert when todo.reminders is disabled", async () => {
		const { session, sessionManager, waitForCall } = await createHarness({ "todo.reminders": false });
		const continuation = await runToContinuationWithTodos(session, sessionManager, waitForCall, [
			{
				name: "Work",
				tasks: [
					{ content: "finish the parser", status: "in_progress" },
					{ content: "done thing", status: "completed" },
				],
			},
		]);

		expect(continuation.text).not.toContain("- finish the parser [in_progress]");
		expect(continuation.text).not.toContain("- done thing [completed]");
	});

	it("does not reassert when every task is complete", async () => {
		const { session, sessionManager, waitForCall } = await createHarness();
		const continuation = await runToContinuationWithTodos(session, sessionManager, waitForCall, [
			{ name: "Work", tasks: [{ content: "done thing", status: "completed" }] },
		]);

		expect(continuation.text).not.toContain("- done thing [completed]");
	});

	it("does not reassert in plan mode", async () => {
		const { session, sessionManager, waitForCall } = await createHarness();
		activateOngoingGoal(session);
		await session.prompt("refactor the parser across modules");
		session.setPlanModeState({ enabled: true, planFilePath: path.join(tempDir.path(), "plan.md") });
		sessionManager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, {
			phases: [{ name: "Work", tasks: [{ content: "finish the parser", status: "in_progress" }] }],
		});
		const boundaryEntryId = sessionManager.appendCustomEntry("compaction-boundary-marker", {});
		stubCompaction(boundaryEntryId);
		const continuationPromise = waitForCall(call => call.callIndex > 0 && call.text.includes(AUTO_CONTINUE_MARKER));
		emitHighUsageTurn(session);
		const continuation = await continuationPromise;

		expect(continuation.text).not.toContain("- finish the parser [in_progress]");
	});
});
