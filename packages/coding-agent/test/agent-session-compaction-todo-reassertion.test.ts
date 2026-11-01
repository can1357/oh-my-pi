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
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session-events";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { POST_COMPACTION_TODO_MESSAGE_TYPE } from "@oh-my-pi/pi-coding-agent/session/todo-tracker";
import { TodoTool, type ToolSession, USER_TODO_EDIT_CUSTOM_TYPE } from "@oh-my-pi/pi-coding-agent/tools";
import { TempDir } from "@oh-my-pi/pi-utils";

// Post-compaction todo reassertion (#16738): when a todo list survives compaction, the
// eager prelude path stays silent by design (it bails once phases exist), so the
// auto-continuation turn must carry a reminder-only reassertion of the surviving
// list — compaction summarized away the `todo` tool results that created it. The
// reassertion renders the full canonical state (statuses and blocker notes included)
// and is skipped for a kept `todo` toolResult. Raw `user_todo_edit` custom entries
// are data-only and still need reassertion, regardless of adjacent messages.
//
// Tests identify the prepend-only message by POST_COMPACTION_TODO_MESSAGE_TYPE in
// transformContext before provider conversion, then assert task/status/blocker
// semantics rather than prompt wording or Markdown layout. The continuation turn
// is selected at the `auto_compaction_end` lifecycle boundary (first provider call
// at/after it), never by prompt wording.

type ObservedPromptCall = {
	callIndex: number;
	toolChoice: string | undefined;
	text: string;
	reassertionText: string | undefined;
	reassertionCount: number;
	visibleTodoToolResultCount: number;
};

type WaitForCall = (predicate: (call: ObservedPromptCall) => boolean) => Promise<ObservedPromptCall>;

type Harness = {
	session: AgentSession;
	observedCalls: ObservedPromptCall[];
	sessionManager: SessionManager;
	waitForCall: WaitForCall;
	/**
	 * Resolves the first provider call at/after the `auto_compaction_end` boundary —
	 * the post-compaction auto-continuation turn. Selected by lifecycle event, never
	 * by prompt wording (AGENTS.md forbids wording assertions); the reminder turn
	 * only fires after the auto-continuation in this harness.
	 */
	waitForPostCompactionCall: (compactionIndex?: number) => Promise<ObservedPromptCall>;
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
function stubCompaction(firstKeptEntryId?: string, replay?: { throughEntryId?: string; provider?: "openai" }): void {
	vi.spyOn(compactionModule, "compact").mockImplementation(async preparation => ({
		summary: "compacted",
		shortSummary: undefined,
		firstKeptEntryId: firstKeptEntryId ?? preparation.firstKeptEntryId,
		tokensBefore: preparation.tokensBefore,
		details: {},
		preserveData:
			replay?.provider === "openai"
				? {
						openaiRemoteCompaction: {
							provider: "openai",
							replacementHistory: [{ type: "compaction", encrypted_content: "test-encrypted-state" }],
							compactionItem: { type: "compaction", encrypted_content: "test-encrypted-state" },
						},
					}
				: replay
					? { anthropicCompaction: { provider: "anthropic", content: "compacted", signature: "test-signature" } }
					: undefined,
		providerReplayThroughEntryId: replay?.throughEntryId,
	}));
}

/** Emit a high-usage assistant turn to drive threshold (context-full) auto-compaction. */
function emitHighUsageTurn(session: AgentSession, nonTerminal = false): void {
	const assistantMsg = {
		role: "assistant" as const,
		content: [{ type: "text" as const, text: "Done." }],
		api: "anthropic-messages" as const,
		provider: "anthropic" as const,
		model: "claude-sonnet-4-5",
		stopReason: nonTerminal ? ("toolUse" as const) : ("stop" as const),
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
		let reassertionText: string | undefined;
		let reassertionCount = 0;
		let visibleTodoToolResultCount = 0;
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
			transformContext: async messages => {
				const reassertions = messages.filter(
					message => message.role === "custom" && message.customType === POST_COMPACTION_TODO_MESSAGE_TYPE,
				);
				reassertionText = reassertions[0] ? getMessageText(reassertions[0]) : undefined;
				reassertionCount = reassertions.length;
				visibleTodoToolResultCount = messages.filter(
					message => message.role === "toolResult" && message.toolName === "todo",
				).length;
				return messages;
			},
			getToolChoice: () => session?.nextToolChoiceDirective(),
			streamFn: (_model, context, options) => {
				const call: ObservedPromptCall = {
					callIndex: observedCalls.length,
					toolChoice: getToolChoiceName(options?.toolChoice),
					text: context.messages.map(message => getMessageText(message)).join("\n"),
					reassertionText,
					reassertionCount,
					visibleTodoToolResultCount,
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

		// Lifecycle boundary for the post-compaction turn: once a compaction run
		// completes, the next provider call is the auto-continuation. Registered
		// before the turn is driven, so the waiter never misses the call.
		const postCompactionFloors: number[] = [];
		const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
			if (event.type === "auto_compaction_end" && event.result !== undefined && !event.aborted) {
				postCompactionFloors.push(observedCalls.length);
			}
		});
		cleanups.push(async () => {
			unsubscribe();
		});
		const waitForPostCompactionCall = (compactionIndex = 0) =>
			waitForCall(
				call =>
					postCompactionFloors[compactionIndex] !== undefined &&
					call.callIndex >= postCompactionFloors[compactionIndex],
			);

		cleanups.push(() => session.dispose());
		return { session, observedCalls, sessionManager, waitForCall, waitForPostCompactionCall };
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
	 * Append a `user_todo_edit` custom entry — the data-only snapshot shape written by
	 * RPC `set_todos`, the SDK, and the interactive quick-complete. Raw custom entries
	 * are never rendered into the model context.
	 */
	function appendUserTodoEdit(
		sessionManager: SessionManager,
		phases: { name: string; tasks: { content: string; status: string; blocker?: string }[] }[],
	): string {
		return sessionManager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, { phases });
	}

	/**
	 * Append a model-visible `todo` toolResult snapshot entry — the durable canonical
	 * shape the todo tool itself persists (a `message` entry, kept-tail visible).
	 */
	function appendTodoToolResultEntry(sessionManager: SessionManager, phases: unknown): string {
		return sessionManager.appendMessage({
			role: "toolResult",
			toolCallId: "todo-snapshot-call",
			toolName: "todo",
			content: [{ type: "text" as const, text: JSON.stringify(phases) ?? "[]" }],
			details: { op: "start", phases },
			isError: false,
			timestamp: Date.now(),
		});
	}

	/** An unrelated developer message does not make a preceding data-only edit visible. */
	function appendUnrelatedDeveloperMessage(sessionManager: SessionManager): void {
		sessionManager.appendMessage({
			role: "developer",
			content: [{ type: "text" as const, text: "Use the project's existing coding conventions." }],
			attribution: "user",
			timestamp: Date.now(),
		});
	}

	/**
	 * Run the first prompt, add a user todo edit that gets summarized away (the keep
	 * boundary lands on a later marker entry), drive a compaction, and resolve with
	 * the compaction auto-continuation provider call (selected at the
	 * `auto_compaction_end` lifecycle boundary, distinct from a todo reminder turn).
	 */
	async function runToContinuationWithTodos(
		session: AgentSession,
		sessionManager: SessionManager,
		waitForPostCompactionCall: () => Promise<ObservedPromptCall>,
		phases: { name: string; tasks: { content: string; status: string; blocker?: string }[] }[],
	): Promise<ObservedPromptCall> {
		activateOngoingGoal(session);
		await session.prompt("refactor the parser across modules");
		appendUserTodoEdit(sessionManager, phases);
		// The keep boundary starts after the todo entry: the snapshot is summarized away.
		const boundaryEntryId = sessionManager.appendCustomEntry("compaction-boundary-marker", {});
		stubCompaction(boundaryEntryId);
		const continuationPromise = waitForPostCompactionCall();
		emitHighUsageTurn(session);
		return continuationPromise;
	}

	it("reasserts the surviving todo list with the full canonical state", async () => {
		const { session, sessionManager, waitForPostCompactionCall } = await createHarness();
		const continuation = await runToContinuationWithTodos(session, sessionManager, waitForPostCompactionCall, [
			{
				name: "Work",
				tasks: [
					{ content: "do the thing", status: "pending" },
					{ content: "finish the parser", status: "in_progress" },
					{ content: "awaiting review", status: "blocked", blocker: "reviewer feedback" },
					{ content: "parked on ci capacity", status: "blocked" },
					{ content: "the old approach", status: "abandoned" },
					{ content: "done thing", status: "completed" },
				],
			},
		]);

		const reassertion = continuation.reassertionText;
		expect(reassertion).toBeDefined();
		for (const fragment of [
			"do the thing",
			"finish the parser",
			"in_progress",
			"awaiting review",
			"blocked",
			"reviewer feedback",
			"parked on ci capacity",
			"the old approach",
			"abandoned",
			"done thing",
			"completed",
		]) {
			expect(reassertion).toContain(fragment);
		}
		// Reminder-only: never a forced tool_choice on the resumed turn.
		expect(continuation.toolChoice).toBeUndefined();
	});

	it("reasserts on an ordinary non-goal auto-continuation", async () => {
		const { session, sessionManager, waitForPostCompactionCall } = await createHarness();
		await session.prompt("refactor the parser across modules");
		appendUserTodoEdit(sessionManager, [
			{
				name: "Work",
				tasks: [{ content: "finish the parser", status: "in_progress" }],
			},
		]);
		const boundaryEntryId = sessionManager.appendCustomEntry("compaction-boundary-marker", {});
		stubCompaction(boundaryEntryId);
		const continuationPromise = waitForPostCompactionCall();
		emitHighUsageTurn(session, true);
		const continuation = await continuationPromise;

		expect(continuation.reassertionText).toContain("finish the parser");
		expect(continuation.reassertionText).toContain("in_progress");
	});

	it("does not reassert when a visible todo toolResult snapshot is still inside the kept tail", async () => {
		const { session, sessionManager, waitForPostCompactionCall } = await createHarness();
		activateOngoingGoal(session);
		await session.prompt("refactor the parser across modules");
		// Keep boundary starts at a kept `todo` toolResult message entry: the model
		// still sees the list in the tail, so the reassertion must stay silent.
		const todoEntryId = appendTodoToolResultEntry(sessionManager, [
			{
				name: "Work",
				tasks: [
					{ content: "finish the parser", status: "in_progress" },
					{ content: "done thing", status: "completed" },
				],
			},
		]);
		stubCompaction(todoEntryId);
		const continuationPromise = waitForPostCompactionCall();
		emitHighUsageTurn(session);
		const continuation = await continuationPromise;

		// The snapshot is visible in the kept tail, so no separate reassertion
		// custom message should be prepended to this continuation.
		expect(continuation.text).toContain("finish the parser");
		expect(continuation.text).toContain("done thing");
		expect(continuation.reassertionText).toBeUndefined();
	});

	it("reasserts when the kept canonical todo result has been pruned", async () => {
		const { session, sessionManager, waitForPostCompactionCall } = await createHarness();
		activateOngoingGoal(session);
		await session.prompt("refactor the parser across modules");
		const todoEntryId = appendTodoToolResultEntry(sessionManager, [
			{
				name: "Work",
				tasks: [{ content: "finish the parser", status: "in_progress" }],
			},
		]);
		const todoEntry = sessionManager.getBranch().find(entry => entry.id === todoEntryId);
		if (todoEntry?.type !== "message" || todoEntry.message.role !== "toolResult") {
			throw new Error("Expected todo toolResult entry");
		}
		todoEntry.message.content = [{ type: "text", text: "[Output truncated - 100 tokens]" }];
		todoEntry.message.prunedAt = Date.now();
		stubCompaction(todoEntryId);
		const continuationPromise = waitForPostCompactionCall();
		emitHighUsageTurn(session);
		const continuation = await continuationPromise;

		expect(continuation.reassertionText).toContain("finish the parser");
		expect(continuation.reassertionText).toContain("in_progress");
	});

	it("does not reassert a visible todo result after the native replay boundary", async () => {
		const { session, sessionManager, waitForPostCompactionCall } = await createHarness();
		activateOngoingGoal(session);
		await session.prompt("refactor the parser across modules");
		const replayThroughEntryId = sessionManager.appendCustomEntry("native-replay-boundary", {});
		appendTodoToolResultEntry(sessionManager, [
			{
				name: "Work",
				tasks: [{ content: "finish the parser", status: "in_progress" }],
			},
		]);
		stubCompaction("", { throughEntryId: replayThroughEntryId });
		const continuationPromise = waitForPostCompactionCall();
		emitHighUsageTurn(session);
		const continuation = await continuationPromise;

		expect(continuation.text).toContain("finish the parser");
		expect(continuation.reassertionText).toBeUndefined();
	});

	it("reasserts a todo result summarized before the native replay boundary", async () => {
		const { session, sessionManager, waitForPostCompactionCall } = await createHarness();
		activateOngoingGoal(session);
		await session.prompt("refactor the parser across modules");
		appendTodoToolResultEntry(sessionManager, [
			{
				name: "Work",
				tasks: [{ content: "finish the parser", status: "in_progress" }],
			},
		]);
		const replayThroughEntryId = sessionManager.appendCustomEntry("native-replay-boundary", {});
		stubCompaction("", { throughEntryId: replayThroughEntryId });
		const continuationPromise = waitForPostCompactionCall();
		emitHighUsageTurn(session);
		const continuation = await continuationPromise;

		expect(continuation.reassertionText).toContain("finish the parser");
		expect(continuation.reassertionText).toContain("in_progress");
	});

	it("reasserts conservatively when the native replay boundary is missing", async () => {
		const { session, sessionManager, waitForPostCompactionCall } = await createHarness();
		activateOngoingGoal(session);
		await session.prompt("refactor the parser across modules");
		appendUserTodoEdit(sessionManager, [
			{
				name: "Work",
				tasks: [{ content: "finish the parser", status: "in_progress" }],
			},
		]);
		stubCompaction("", { throughEntryId: "missing-native-replay-boundary" });
		const continuationPromise = waitForPostCompactionCall();
		emitHighUsageTurn(session);
		const continuation = await continuationPromise;

		expect(continuation.reassertionCount).toBe(1);
		expect(continuation.reassertionText).toContain("finish the parser");
	});

	it("reasserts a todo result covered by full OpenAI remote replacement", async () => {
		const { session, sessionManager, waitForPostCompactionCall } = await createHarness();
		activateOngoingGoal(session);
		await session.prompt("refactor the parser across modules");
		const firstKeptEntryId = sessionManager.appendCustomEntry("remote-kept-boundary", {});
		appendTodoToolResultEntry(sessionManager, [
			{
				name: "Work",
				tasks: [{ content: "finish the parser", status: "in_progress" }],
			},
		]);
		stubCompaction(firstKeptEntryId, { provider: "openai" });
		const continuationPromise = waitForPostCompactionCall();
		emitHighUsageTurn(session);
		const continuation = await continuationPromise;

		expect(continuation.visibleTodoToolResultCount).toBe(0);
		expect(continuation.reassertionText).toContain("finish the parser");
		expect(continuation.reassertionText).toContain("in_progress");
	});

	it("does not reassert an OpenAI snapshot appended after compaction", async () => {
		const { session, sessionManager, waitForPostCompactionCall } = await createHarness();
		activateOngoingGoal(session);
		await session.prompt("refactor the parser across modules");
		const phases = [
			{
				name: "Work",
				tasks: [{ content: "finish the parser", status: "in_progress" }],
			},
		];
		appendUserTodoEdit(sessionManager, phases);
		const firstKeptEntryId = sessionManager.appendCustomEntry("remote-kept-boundary", {});
		stubCompaction(firstKeptEntryId, { provider: "openai" });
		const unsubscribe = session.subscribe(event => {
			if (event.type === "auto_compaction_end" && event.result !== undefined && !event.aborted) {
				unsubscribe();
				appendTodoToolResultEntry(sessionManager, phases);
				session.agent.replaceMessages(sessionManager.buildSessionContext().messages);
			}
		});
		const continuationPromise = waitForPostCompactionCall();
		emitHighUsageTurn(session);
		const continuation = await continuationPromise;

		expect(continuation.visibleTodoToolResultCount).toBe(1);
		expect(continuation.reassertionCount).toBe(0);
	});

	it("reasserts a todo result covered by OpenAI prefix replay", async () => {
		const { session, sessionManager, waitForPostCompactionCall } = await createHarness();
		activateOngoingGoal(session);
		await session.prompt("refactor the parser across modules");
		const firstKeptEntryId = sessionManager.appendCustomEntry("remote-kept-boundary", {});
		appendTodoToolResultEntry(sessionManager, [
			{
				name: "Work",
				tasks: [{ content: "finish the parser", status: "in_progress" }],
			},
		]);
		const replayThroughEntryId = sessionManager.appendCustomEntry("remote-replay-boundary", {});
		stubCompaction(firstKeptEntryId, { provider: "openai", throughEntryId: replayThroughEntryId });
		const continuationPromise = waitForPostCompactionCall();
		emitHighUsageTurn(session);
		const continuation = await continuationPromise;

		expect(continuation.reassertionText).toContain("finish the parser");
		expect(continuation.reassertionText).toContain("in_progress");
	});

	it("does not reassert a raw todo result after the OpenAI prefix replay boundary", async () => {
		const { session, sessionManager, waitForPostCompactionCall } = await createHarness();
		activateOngoingGoal(session);
		await session.prompt("refactor the parser across modules");
		const firstKeptEntryId = sessionManager.appendCustomEntry("remote-kept-boundary", {});
		const replayThroughEntryId = sessionManager.appendCustomEntry("remote-replay-boundary", {});
		appendTodoToolResultEntry(sessionManager, [
			{
				name: "Work",
				tasks: [{ content: "finish the parser", status: "in_progress" }],
			},
		]);
		stubCompaction(firstKeptEntryId, { provider: "openai", throughEntryId: replayThroughEntryId });
		const continuationPromise = waitForPostCompactionCall();
		emitHighUsageTurn(session);
		const continuation = await continuationPromise;

		expect(continuation.text).toContain("finish the parser");
		expect(continuation.reassertionText).toBeUndefined();
	});

	it("reasserts a kept user todo edit: custom entries are never model-visible", async () => {
		const { session, sessionManager, waitForPostCompactionCall } = await createHarness();
		activateOngoingGoal(session);
		await session.prompt("refactor the parser across modules");
		// The user edit lies inside the kept tail (boundary starts earlier), but raw
		// custom entries are data-only — the context rebuild never emits them, and
		// no manual-edit reminder follows (the RPC set_todos / SDK / quick-complete
		// shapes). Position alone must not suppress the reassertion.
		const boundaryEntryId = sessionManager.appendCustomEntry("compaction-boundary-marker", {});
		appendUserTodoEdit(sessionManager, [
			{
				name: "Work",
				tasks: [
					{ content: "finish the parser", status: "in_progress" },
					{ content: "done thing", status: "completed" },
				],
			},
		]);
		stubCompaction(boundaryEntryId);
		const continuationPromise = waitForPostCompactionCall();
		emitHighUsageTurn(session);
		const continuation = await continuationPromise;

		expect(continuation.reassertionText).toContain("finish the parser");
		expect(continuation.reassertionText).toContain("in_progress");
		expect(continuation.reassertionText).toContain("done thing");
		expect(continuation.reassertionText).toContain("completed");
	});

	it("reasserts a kept user todo edit followed by an unrelated developer message", async () => {
		const { session, sessionManager, waitForPostCompactionCall } = await createHarness();
		activateOngoingGoal(session);
		await session.prompt("refactor the parser across modules");
		// Adjacency and role do not identify a todo reminder. A later developer
		// message can be unrelated to the edit and must not suppress the list.
		const boundaryEntryId = sessionManager.appendCustomEntry("compaction-boundary-marker", {});
		appendUserTodoEdit(sessionManager, [
			{
				name: "Work",
				tasks: [{ content: "finish the parser", status: "in_progress" }],
			},
		]);
		appendUnrelatedDeveloperMessage(sessionManager);
		stubCompaction(boundaryEntryId);
		const continuationPromise = waitForPostCompactionCall();
		emitHighUsageTurn(session);
		const continuation = await continuationPromise;

		expect(continuation.reassertionText).toContain("finish the parser");
		expect(continuation.reassertionText).toContain("in_progress");
	});

	it("does not replay an old reminder and inject a duplicate on the next compaction", async () => {
		const { session, sessionManager, waitForPostCompactionCall } = await createHarness();
		const firstContinuation = await runToContinuationWithTodos(session, sessionManager, waitForPostCompactionCall, [
			{
				name: "Work",
				tasks: [{ content: "finish the parser", status: "in_progress" }],
			},
		]);
		expect(firstContinuation.reassertionCount).toBe(1);
		await session.waitForIdle();

		// Keep the region where the first reminder would be persisted. A durable
		// reminder would replay here while the original todo edit stays summarized.
		const autoContinueEntry = sessionManager
			.getBranch()
			.findLast(
				entry => entry.type === "message" && entry.message.role === "developer" && entry.message.synthetic === true,
			);
		if (!autoContinueEntry) throw new Error("Expected the first auto-continuation entry");
		stubCompaction(autoContinueEntry.id);
		const secondContinuationPromise = waitForPostCompactionCall(1);
		emitHighUsageTurn(session);
		const secondContinuation = await secondContinuationPromise;

		expect(secondContinuation.reassertionCount).toBe(1);
	});

	it("does not reassert when no todo list exists", async () => {
		const { session, waitForPostCompactionCall } = await createHarness();
		activateOngoingGoal(session);
		await session.prompt("refactor the parser across modules");
		stubCompaction();
		const continuationPromise = waitForPostCompactionCall();
		emitHighUsageTurn(session);
		const continuation = await continuationPromise;

		expect(continuation.reassertionText).toBeUndefined();
	});

	it("does not reassert when todo support is disabled", async () => {
		const { session, sessionManager, waitForPostCompactionCall } = await createHarness({
			"todo.enabled": false,
		});
		const continuation = await runToContinuationWithTodos(session, sessionManager, waitForPostCompactionCall, [
			{
				name: "Work",
				tasks: [{ content: "finish the parser", status: "in_progress" }],
			},
		]);

		expect(continuation.reassertionText).toBeUndefined();
	});

	it("does not reassert when the todo tool is not active", async () => {
		const { session, sessionManager, waitForPostCompactionCall } = await createHarness();
		activateOngoingGoal(session);
		await session.prompt("refactor the parser across modules");
		session.setActiveToolsByName(["bash"]);
		appendUserTodoEdit(sessionManager, [
			{
				name: "Work",
				tasks: [{ content: "finish the parser", status: "in_progress" }],
			},
		]);
		const boundaryEntryId = sessionManager.appendCustomEntry("compaction-boundary-marker", {});
		stubCompaction(boundaryEntryId);
		const continuationPromise = waitForPostCompactionCall();
		emitHighUsageTurn(session);
		const continuation = await continuationPromise;

		expect(continuation.reassertionText).toBeUndefined();
	});

	it("does not reassert when todo.reminders is disabled", async () => {
		const { session, sessionManager, waitForPostCompactionCall } = await createHarness({
			"todo.reminders": false,
		});
		const continuation = await runToContinuationWithTodos(session, sessionManager, waitForPostCompactionCall, [
			{
				name: "Work",
				tasks: [
					{ content: "finish the parser", status: "in_progress" },
					{ content: "done thing", status: "completed" },
				],
			},
		]);

		expect(continuation.reassertionText).toBeUndefined();
	});

	it("reasserts blocked work even when no actionable task remains", async () => {
		const { session, sessionManager, waitForPostCompactionCall } = await createHarness();
		const continuation = await runToContinuationWithTodos(session, sessionManager, waitForPostCompactionCall, [
			{
				name: "Work",
				tasks: [
					{ content: "awaiting review", status: "blocked", blocker: "reviewer feedback" },
					{ content: "done thing", status: "completed" },
					{ content: "old approach", status: "abandoned" },
				],
			},
		]);

		for (const fragment of [
			"awaiting review",
			"blocked",
			"reviewer feedback",
			"done thing",
			"completed",
			"old approach",
			"abandoned",
		]) {
			expect(continuation.reassertionText).toContain(fragment);
		}
	});

	it("does not reassert when every task is complete", async () => {
		const { session, sessionManager, waitForPostCompactionCall } = await createHarness();
		const continuation = await runToContinuationWithTodos(session, sessionManager, waitForPostCompactionCall, [
			{ name: "Work", tasks: [{ content: "done thing", status: "completed" }] },
		]);

		expect(continuation.reassertionText).toBeUndefined();
	});

	it("does not reassert in plan mode", async () => {
		const { session, sessionManager, waitForPostCompactionCall } = await createHarness();
		activateOngoingGoal(session);
		await session.prompt("refactor the parser across modules");
		session.setPlanModeState({ enabled: true, planFilePath: path.join(tempDir.path(), "plan.md") });
		appendUserTodoEdit(sessionManager, [
			{ name: "Work", tasks: [{ content: "finish the parser", status: "in_progress" }] },
		]);
		const boundaryEntryId = sessionManager.appendCustomEntry("compaction-boundary-marker", {});
		stubCompaction(boundaryEntryId);
		const continuationPromise = waitForPostCompactionCall();
		emitHighUsageTurn(session);
		const continuation = await continuationPromise;

		expect(continuation.reassertionText).toBeUndefined();
	});
});
