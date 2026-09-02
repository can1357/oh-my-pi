import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentMessage, type AgentTool } from "@oh-my-pi/pi-agent-core";
import * as compactionModule from "@oh-my-pi/pi-agent-core/compaction";
import type { Model, TextContent } from "@oh-my-pi/pi-ai";
import * as codexResponses from "@oh-my-pi/pi-ai/providers/openai-codex-responses";
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

// Re-injecting eager preludes after compaction: the first-message preludes are the
// oldest messages, so compaction summarizes them away and the agent silently loses
// the delegate-via-tasks / phased-todo guidance. The post-compaction auto-continuation
// turn must carry the gated reminders again (reminder-only — never a forced tool_choice).

const TASK_DELEGATION_MARKER = "Task delegation enabled";

type ObservedPromptCall = {
	callIndex: number;
	toolChoice: string | undefined;
	messageTexts: string[];
};

type WaitForCall = (predicate: (call: ObservedPromptCall) => boolean) => Promise<ObservedPromptCall>;

type Harness = {
	session: AgentSession;
	observedCalls: ObservedPromptCall[];
	sessionManager: SessionManager;
	// Resolves with the first provider call (already-seen or future) matching the predicate.
	// Awaiting the real streamFn call avoids wall-clock polling for the async compaction path.
	waitForCall: WaitForCall;
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

describe("AgentSession eager prelude re-injection after compaction", () => {
	let tempDir: TempDir;
	let sharedDir: TempDir;
	let sharedAuthStorage: AuthStorage;
	let sharedModelRegistry: ModelRegistry;
	const cleanups: Array<() => Promise<void>> = [];

	beforeAll(async () => {
		sharedDir = TempDir.createSync("@pi-agent-session-eager-compaction-shared-");
		sharedAuthStorage = await AuthStorage.create(path.join(sharedDir.path(), "auth.db"));
		sharedAuthStorage.setRuntimeApiKey("anthropic", "test-key");
		sharedAuthStorage.setRuntimeApiKey("openai-codex", "test-key");
		sharedModelRegistry = new ModelRegistry(sharedAuthStorage, path.join(sharedDir.path(), "models.yml"));
	});

	afterAll(() => {
		sharedAuthStorage.close();
		sharedDir.removeSync();
	});

	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-agent-session-eager-compaction-");
		cleanups.length = 0;
	});

	afterEach(async () => {
		for (const cleanup of cleanups) await cleanup();
		cleanups.length = 0;
		tempDir.removeSync();
		vi.restoreAllMocks();
	});

	async function createHarness(
		settingsOverride: Record<string, unknown> = {},
		opts: { agentId?: string; agentKind?: "main" | "sub"; model?: Model } = {},
	): Promise<Harness> {
		const observedCalls: ObservedPromptCall[] = [];
		const waiters: Array<{
			predicate: (call: ObservedPromptCall) => boolean;
			resolve: (call: ObservedPromptCall) => void;
		}> = [];
		const defaultModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!defaultModel) throw new Error("Expected claude-sonnet-4-5 model to exist");
		const selectedModel = opts.model ?? defaultModel;
		// Pin the window and output reservation: usage figures below trip the
		// context-full strategy at a 200k/64k threshold; catalog regeneration must
		// not shift the headroom math.
		const model = { ...selectedModel, contextWindow: 200_000, maxTokens: 64_000 };

		const modelRegistry = sharedModelRegistry;
		const settings = Settings.isolated({
			"compaction.enabled": true,
			// These suites assert the blocking threshold pass itself; keep the
			// speculation grace band from deferring it.
			"compaction.asyncEnabled": false,
			"compaction.autoContinue": true,
			"compaction.methodOrder": ["soft"],
			"task.eager": "always",
			"todo.enabled": false,
			"todo.eager": "default",
			"todo.reminders": false,
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

		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools, messages: [] },
			convertToLlm,
			getToolChoice: () => session?.nextToolChoiceDirective(),
			streamFn: (_model, context, options) => {
				const call: ObservedPromptCall = {
					callIndex: observedCalls.length,
					toolChoice: getToolChoiceName(options?.toolChoice),
					messageTexts: context.messages.map(message => getMessageText(message)),
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
		]);
		if (todoTool) toolRegistry.set(todoTool.name, todoTool as unknown as AgentTool);

		const session = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry,
			toolRegistry,
			agentId: opts.agentId,
			agentKind: opts.agentKind,
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
				id: "eager-prelude-compaction",
				objective: "finish the parser refactor",
				status: "active",
				tokensUsed: 0,
				timeUsedSeconds: 0,
				createdAt: now,
				updatedAt: now,
			},
		});
	}

	/** Run the first prompt, drive a compaction, and resolve with the auto-continuation provider call. */
	async function runToContinuation(session: AgentSession, waitForCall: WaitForCall): Promise<ObservedPromptCall> {
		activateOngoingGoal(session);
		await session.prompt("refactor the parser across modules");
		emitHighUsageTurn(session);
		return waitForCall(call => call.callIndex > 0);
	}

	it("re-injects the eager task reminder on the auto-continuation turn (task.eager always)", async () => {
		const { session, waitForCall } = await createHarness();
		stubCompaction();

		const continuation = await runToContinuation(session, waitForCall);

		const reminder = continuation.messageTexts.find(text => text.includes(TASK_DELEGATION_MARKER));
		expect(reminder).toBeDefined();
		expect(reminder).toContain("`task`");
		// Reminder-only: the post-compaction nudge never forces a tool on the resumed turn.
		expect(continuation.toolChoice).toBeUndefined();
	});
	it("does not re-inject the eager task reminder when task.eager is default", async () => {
		const { session, waitForCall } = await createHarness({ "task.eager": "default" });
		stubCompaction();

		const continuation = await runToContinuation(session, waitForCall);

		expect(continuation.messageTexts.some(text => text.includes(TASK_DELEGATION_MARKER))).toBe(false);
	});
	it("does not re-inject the eager task reminder when task.eager is preferred", async () => {
		const { session, waitForCall } = await createHarness({ "task.eager": "preferred" });
		stubCompaction();

		const continuation = await runToContinuation(session, waitForCall);

		expect(continuation.messageTexts.some(text => text.includes(TASK_DELEGATION_MARKER))).toBe(false);
	});
	it("does not re-inject the eager task reminder for subagent sessions", async () => {
		const { session, waitForCall } = await createHarness({}, { agentId: "SubAgent", agentKind: "sub" });
		stubCompaction();

		const continuation = await runToContinuation(session, waitForCall);

		expect(continuation.messageTexts.some(text => text.includes(TASK_DELEGATION_MARKER))).toBe(false);
	});
	it("does not re-inject the eager task reminder in plan mode", async () => {
		const { session, waitForCall } = await createHarness();
		session.setPlanModeState({ enabled: true, planFilePath: path.join(tempDir.path(), "plan.md") });
		stubCompaction();

		const continuation = await runToContinuation(session, waitForCall);

		expect(continuation.messageTexts.some(text => text.includes(TASK_DELEGATION_MARKER))).toBe(false);
	});

	it("re-injects the eager todo reminder on the auto-continuation turn (todo.eager preferred)", async () => {
		const { session, waitForCall } = await createHarness({
			"task.eager": "default",
			"todo.enabled": true,
			"todo.eager": "preferred",
		});
		stubCompaction();

		const continuation = await runToContinuation(session, waitForCall);

		expect(continuation.messageTexts.some(text => text.includes("Consider calling"))).toBe(true);
		expect(continuation.toolChoice).toBeUndefined();
	});

	it("re-injects the eager todo reminder reminder-only for todo.eager always (no forced tool)", async () => {
		const { session, waitForCall } = await createHarness({
			"task.eager": "default",
			"todo.enabled": true,
			"todo.eager": "always",
		});
		stubCompaction();

		const continuation = await runToContinuation(session, waitForCall);

		// `always` keeps the strong forced wording in the reminder text...
		expect(continuation.messageTexts.some(text => text.includes("You MUST call"))).toBe(true);
		// ...but post-compaction never attaches the forced todo tool_choice.
		expect(continuation.toolChoice).toBeUndefined();
	});

	it("does not re-inject the eager todo reminder when todos survived compaction", async () => {
		const { session, sessionManager, waitForCall } = await createHarness({
			"task.eager": "default",
			"todo.enabled": true,
			"todo.eager": "preferred",
		});
		await session.prompt("refactor the parser across modules");
		activateOngoingGoal(session);
		// A surviving todo entry; pin firstKeptEntryId so compaction preserves it in the branch.
		const todoEntryId = sessionManager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, {
			phases: [{ name: "Work", tasks: [{ content: "do the thing", status: "pending" }] }],
		});
		stubCompaction(todoEntryId);

		const continuationPromise = waitForCall(call => call.callIndex > 0);
		emitHighUsageTurn(session);
		const continuation = await continuationPromise;

		expect(session.getTodoPhases().length).toBeGreaterThan(0);
		expect(continuation.messageTexts.some(text => text.includes("Consider calling"))).toBe(false);
		expect(continuation.messageTexts.some(text => text.includes("You MUST call"))).toBe(false);
	});

	it("resets Codex provider history after successful auto-compaction", async () => {
		const model = getBundledModel("openai-codex", "gpt-5.6-terra");
		if (!model) throw new Error("Expected gpt-5.6-terra model to exist");
		const resetSpy = vi.spyOn(codexResponses, "resetOpenAICodexHistoryAfterCompaction");
		const { session, waitForCall } = await createHarness({}, { model });
		stubCompaction();

		await runToContinuation(session, waitForCall);

		expect(resetSpy).toHaveBeenCalledTimes(1);
		const reset = resetSpy.mock.calls[0]?.[0];
		if (!reset) throw new Error("Expected Codex compaction reset");
		expect(reset.providerSessionState).toBe(session.providerSessionState);
		expect(reset.sessionId).toBe(session.sessionId);
		expect(reset.compaction).toMatchObject({
			trigger: "auto",
			reason: "context_limit",
			phase: "pre_turn",
		});
	});
});
