import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent, type AgentMessage, type AgentTool } from "@pk-nerdsaver-ai/pi-agent-core";
import * as compactionModule from "@pk-nerdsaver-ai/pi-agent-core/compaction";
import type { TextContent } from "@pk-nerdsaver-ai/pi-ai";
import { AssistantMessageEventStream } from "@pk-nerdsaver-ai/pi-ai/utils/event-stream";
import { getBundledModel } from "@pk-nerdsaver-ai/pi-catalog/models";
import { ModelRegistry } from "@pk-nerdsaver-ai/pi-coding-agent/config/model-registry";
import { Settings } from "@pk-nerdsaver-ai/pi-coding-agent/config/settings";
import { AgentSession } from "@pk-nerdsaver-ai/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@pk-nerdsaver-ai/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@pk-nerdsaver-ai/pi-coding-agent/session/messages";
import { SessionManager } from "@pk-nerdsaver-ai/pi-coding-agent/session/session-manager";
import { TodoTool, type ToolSession, USER_TODO_EDIT_CUSTOM_TYPE } from "@pk-nerdsaver-ai/pi-coding-agent/tools";
import { TempDir } from "@pk-nerdsaver-ai/pi-utils";
import { type } from "arktype";

// Re-injecting eager preludes after compaction: the first-message preludes are the
// oldest messages, so compaction summarizes them away and the agent silently loses
// the delegate-via-tasks / phased-todo guidance. The post-compaction auto-continuation
// turn must carry the gated reminders again (reminder-only — never a forced tool_choice).

const CONTINUE_MARKER = "Resume work on the user's most recent intent";

type ObservedPromptCall = {
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
	return message.content
		.filter(isTextContentBlock)
		.map(content => content.text)
		.join("\n");
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
	const cleanups: Array<() => Promise<void>> = [];

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
		opts: { agentId?: string; agentKind?: "main" | "sub" } = {},
	): Promise<Harness> {
		const observedCalls: ObservedPromptCall[] = [];
		const waiters: Array<{
			predicate: (call: ObservedPromptCall) => boolean;
			resolve: (call: ObservedPromptCall) => void;
		}> = [];
		const bundledModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!bundledModel) throw new Error("Expected claude-sonnet-4-5 model to exist");
		// The usage fixtures below are written against a 200k window. Pinned here
		// rather than inherited from the catalog, whose claude-sonnet-4-5 entry
		// tracks the live model and moved to 1M — which drops 191k to ~19% of the
		// window, so compaction never triggers and the awaited event never fires.
		const model = { ...bundledModel, contextWindow: 200_000 };

		const authStorage = await AuthStorage.create(path.join(tempDir.path(), `testauth-${cleanups.length}.db`));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), `models-${cleanups.length}.yml`));
		const settings = Settings.isolated({
			"compaction.enabled": true,
			"compaction.autoContinue": true,
			"compaction.strategy": "context-full",
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

		let session: AgentSession;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools, messages: [] },
			convertToLlm,
			getToolChoice: () => session?.nextToolChoiceDirective(),
			streamFn: (_model, context, options) => {
				const call: ObservedPromptCall = {
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

		session = new AgentSession({
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

		cleanups.push(async () => {
			await session.dispose();
			authStorage.close();
		});
		return { session, observedCalls, sessionManager, waitForCall };
	}

	/** Run the first prompt, drive a compaction, and resolve with the auto-continuation provider call. */
	async function runToContinuation(session: AgentSession, waitForCall: WaitForCall): Promise<ObservedPromptCall> {
		await session.prompt("refactor the parser across modules");
		emitHighUsageTurn(session);
		return waitForCall(call => call.messageTexts.some(text => text.includes(CONTINUE_MARKER)));
	}

	it("re-injects the eager task reminder on the auto-continuation turn (task.eager always)", async () => {
		const { session, waitForCall } = await createHarness();
		stubCompaction();

		const continuation = await runToContinuation(session, waitForCall);

		const reminder = continuation.messageTexts.find(text => text.includes("delegation is enabled"));
		expect(reminder).toBeDefined();
		expect(reminder).toContain("`task`");
		// Reminder-only: the post-compaction nudge never forces a tool on the resumed turn.
		expect(continuation.toolChoice).toBeUndefined();
	});

	it("does not re-inject the eager task reminder when task.eager is default", async () => {
		const { session, waitForCall } = await createHarness({ "task.eager": "default" });
		stubCompaction();

		const continuation = await runToContinuation(session, waitForCall);

		expect(continuation.messageTexts.some(text => text.includes("delegation is enabled"))).toBe(false);
	});

	it("does not re-inject the eager task reminder when task.eager is preferred", async () => {
		const { session, waitForCall } = await createHarness({ "task.eager": "preferred" });
		stubCompaction();

		const continuation = await runToContinuation(session, waitForCall);

		expect(continuation.messageTexts.some(text => text.includes("delegation is enabled"))).toBe(false);
	});

	it("does not re-inject the eager task reminder for subagent sessions", async () => {
		const { session, waitForCall } = await createHarness({}, { agentId: "SubAgent", agentKind: "sub" });
		stubCompaction();

		const continuation = await runToContinuation(session, waitForCall);

		expect(continuation.messageTexts.some(text => text.includes("delegation is enabled"))).toBe(false);
	});

	it("does not re-inject the eager task reminder in plan mode", async () => {
		const { session, waitForCall } = await createHarness();
		session.setPlanModeState({ enabled: true, planFilePath: path.join(tempDir.path(), "plan.md") });
		stubCompaction();

		const continuation = await runToContinuation(session, waitForCall);

		expect(continuation.messageTexts.some(text => text.includes("delegation is enabled"))).toBe(false);
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
		// A surviving todo entry; pin firstKeptEntryId so compaction preserves it in the branch.
		const todoEntryId = sessionManager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, {
			phases: [{ name: "Work", tasks: [{ content: "do the thing", status: "pending" }] }],
		});
		stubCompaction(todoEntryId);

		const continuationPromise = waitForCall(call => call.messageTexts.some(text => text.includes(CONTINUE_MARKER)));
		emitHighUsageTurn(session);
		const continuation = await continuationPromise;

		expect(session.getTodoPhases().length).toBeGreaterThan(0);
		expect(continuation.messageTexts.some(text => text.includes("Consider calling"))).toBe(false);
		expect(continuation.messageTexts.some(text => text.includes("You MUST call"))).toBe(false);
	});
});
