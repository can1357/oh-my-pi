/**
 * Regression #9816: while a subagent is focused, the TUI is unsubscribed from
 * the main AgentSession. A main-session tool completion can therefore be emitted
 * with no display listener while its following tool-result `message_end` is
 * still being persisted. Returning immediately used to rebuild from the stale
 * dangling toolCall, classify the now-idle session as historical, and seal a
 * permanent `all running jobs` card.
 *
 * Contract: focus attach subscribes to the target, drains its in-flight event
 * handlers/persistence, then rebuilds. A completion already emitted during the
 * focus blackout is authoritative in the rebuilt transcript; a later event is
 * delivered through the newly installed subscription.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { ToolResultMessage } from "@oh-my-pi/pi-ai";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { TranscriptContainer } from "@oh-my-pi/pi-coding-agent/modes/components/transcript-container";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import { SessionFocusController } from "@oh-my-pi/pi-coding-agent/modes/controllers/session-focus-controller";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { UiHelpers } from "@oh-my-pi/pi-coding-agent/modes/utils/ui-helpers";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry, MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession, AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { SessionContext } from "@oh-my-pi/pi-coding-agent/session/session-context";
import type { AgentProgress, TaskToolDetails } from "@oh-my-pi/pi-coding-agent/task/types";

const usage = {
	input: 1,
	output: 1,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 2,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const danglingHubWait = {
	role: "assistant",
	content: [{ type: "toolCall", id: "hub-1", name: "hub", arguments: { op: "wait" } }],
	api: "anthropic-messages",
	provider: "anthropic",
	model: "claude-sonnet-4-5",
	stopReason: "toolUse",
	usage,
	timestamp: Date.now(),
} as unknown as AgentMessage;

const completedHubWait = {
	role: "toolResult",
	toolCallId: "hub-1",
	toolName: "hub",
	content: [{ type: "text", text: "Completed (1)" }],
	details: {
		op: "wait",
		jobs: [
			{
				id: "Sleeper1",
				type: "task",
				status: "completed",
				label: "Sleeper1",
				durationMs: 11_300,
			},
		],
	},
	isError: false,
	timestamp: Date.now(),
} as ToolResultMessage;

const danglingTask = {
	role: "assistant",
	content: [
		{
			type: "toolCall",
			id: "task-1",
			name: "task",
			arguments: {
				tasks: [{ name: "Parent", agent: "task", task: "Inspect the focus rebuild" }],
			},
		},
	],
	api: "anthropic-messages",
	provider: "anthropic",
	model: "claude-sonnet-4-5",
	stopReason: "toolUse",
	usage,
	timestamp: Date.now(),
} as unknown as AgentMessage;

function runningProgress(id: string, description: string, overrides: Partial<AgentProgress> = {}): AgentProgress {
	return {
		index: 0,
		id,
		agent: "task",
		agentSource: "bundled",
		status: "running",
		task: description,
		description,
		currentTool: "read",
		currentToolArgs: "packages/coding-agent/src/modes",
		recentTools: [],
		recentOutput: [],
		toolCount: 4,
		requests: 3,
		tokens: 1200,
		cost: 0.04,
		durationMs: 2500,
		...overrides,
	};
}

const nestedProgress: TaskToolDetails = {
	projectAgentsDir: null,
	results: [],
	totalDurationMs: 2500,
	progress: [runningProgress("Parent.Child", "Inspect child layout")],
};

const taskProgressUpdate = {
	type: "tool_execution_update",
	toolCallId: "task-1",
	toolName: "task",
	args: { tasks: [{ name: "Parent", agent: "task", task: "Inspect the focus rebuild" }] },
	partialResult: {
		content: [{ type: "text", text: "Running 1 agent..." }],
		details: {
			projectAgentsDir: null,
			results: [],
			totalDurationMs: 2500,
			progress: [
				runningProgress("Parent", "Inspect parent layout", {
					inflightTaskDetails: nestedProgress,
				}),
			],
		} satisfies TaskToolDetails,
	},
} satisfies Extract<AgentSessionEvent, { type: "tool_execution_update" }>;

const backgroundTaskCall = {
	role: "assistant",
	content: [
		{
			type: "toolCall",
			id: "task-bg",
			name: "task",
			arguments: { tasks: [{ name: "Bg", agent: "task", task: "background work" }] },
		},
	],
	api: "anthropic-messages",
	provider: "anthropic",
	model: "claude-sonnet-4-5",
	stopReason: "toolUse",
	usage,
	timestamp: Date.now(),
} as unknown as AgentMessage;

// The initial `async.state === "running"` snapshot the detached call persists:
// a bare parent row, no current-tool line to distinguish it from a later frame.
const backgroundTaskRunningResult = {
	role: "toolResult",
	toolCallId: "task-bg",
	toolName: "task",
	content: [{ type: "text", text: "Spawned agent `Bg`..." }],
	details: {
		projectAgentsDir: null,
		results: [],
		totalDurationMs: 10,
		progress: [runningProgress("Bg", "Background work", { currentTool: undefined, currentToolArgs: undefined })],
		async: { state: "running", jobId: "job-bg", type: "task" },
	},
	isError: false,
	timestamp: Date.now(),
} as unknown as ToolResultMessage;

function backgroundProgressUpdate(
	marker: string,
	state: "running" | "completed" | "failed" = "running",
): Extract<AgentSessionEvent, { type: "tool_execution_update" }> {
	return {
		type: "tool_execution_update",
		toolCallId: "task-bg",
		toolName: "task",
		args: { tasks: [{ name: "Bg", agent: "task", task: "background work" }] },
		partialResult: {
			content: [{ type: "text", text: "Running background task Bg..." }],
			details: {
				projectAgentsDir: null,
				results: [],
				totalDurationMs: 20,
				progress: [runningProgress("Bg", "Background work", { currentTool: "grep", currentToolArgs: marker })],
				async: { state, jobId: "job-bg", type: "task" },
			} satisfies TaskToolDetails,
		},
	} satisfies Extract<AgentSessionEvent, { type: "tool_execution_update" }>;
}

interface SessionStub {
	session: AgentSession;
	hasListener(): boolean;
	emitToolUpdate(event: Extract<AgentSessionEvent, { type: "tool_execution_update" }>): Promise<void>;
	stagePersistedCompletion(): () => void;
}

function makeSession(
	initialMessages: AgentMessage[],
	initialStreaming: boolean,
	runningJobIds: string[] = [],
): SessionStub {
	let messages = initialMessages;
	let streaming = initialStreaming;
	let listener: ((event: AgentSessionEvent) => Promise<void> | void) | undefined;
	let persistence = Promise.resolve();
	const activeToolUpdates = new Map<string, Extract<AgentSessionEvent, { type: "tool_execution_update" }>>();

	const stub = {
		get isStreaming() {
			return streaming;
		},
		retryAttempt: 0,
		subscribe(next: (event: AgentSessionEvent) => Promise<void> | void) {
			listener = next;
			return () => {
				if (listener === next) listener = undefined;
			};
		},
		async settleInFlightMessagePersistence() {
			await persistence;
		},
		buildTranscriptSessionContext() {
			return { messages } as SessionContext;
		},
		getToolByName: () => undefined,
		activeToolExecutionUpdates: () => [...activeToolUpdates.values()],
		getAsyncJobSnapshot: () => ({ running: runningJobIds.map(id => ({ id })) }),
		hasBuiltInTool: () => true,
		sessionManager: {
			getCwd: () => process.cwd(),
			getEntries: () => messages,
		},
	};

	return {
		session: stub as unknown as AgentSession,
		hasListener: () => listener !== undefined,
		emitToolUpdate: async event => {
			activeToolUpdates.set(event.toolCallId, event);
			await listener?.(event);
		},
		stagePersistedCompletion: () => {
			streaming = false;
			const pending = Promise.withResolvers<void>();
			persistence = pending.promise;
			return () => {
				messages = [danglingHubWait, completedHubWait];
				pending.resolve();
			};
		},
	};
}

function createFixture(main = makeSession([danglingHubWait], true)) {
	const worker = makeSession([], false);
	const registry = new AgentRegistry();
	registry.register({
		id: "Worker",
		displayName: "Worker",
		kind: "sub",
		parentId: MAIN_AGENT_ID,
		session: worker.session,
		status: "running",
	});
	const lifecycle = new AgentLifecycleManager(registry);
	const pendingMessagesContainer = new TranscriptContainer();
	const pendingTools = new Map();
	const ctx = {
		isInitialized: true,
		init: vi.fn(async () => {}),
		session: main.session,
		get viewSession() {
			return focus?.target ?? main.session;
		},
		chatContainer: new TranscriptContainer(),
		pendingMessagesContainer,
		transcriptMessageComponents: new WeakMap(),
		pendingTools,
		pendingBashComponents: [],
		pendingPythonComponents: [],
		initialChatRendered: false,
		hideToolActivity: false,
		ui: { requestRender: vi.fn(), requestComponentRender: vi.fn() },
		statusLine: { invalidate: vi.fn(), markActivityStart: vi.fn(), setSession: vi.fn() },
		updateEditorBorderColor: vi.fn(),
		settings: { get: () => false },
		addMessageToChat: (message: AgentMessage) => helpers.addMessageToChat(message),
		renderSessionContext: (context: SessionContext, options?: unknown) =>
			helpers.renderSessionContext(context, options as never),
		renderSessionContextIncrementally: (context: SessionContext, options: unknown, renderChunk?: () => void) =>
			helpers.renderSessionContextIncrementally(context, options as never, renderChunk),
		reloadTodos: vi.fn(async () => {}),
		toolOutputExpanded: false,
		hideThinkingBlock: false,
		lastAssistantUsage: undefined,
		loadingAnimation: undefined,
		autoCompactionLoader: undefined,
		retryLoader: undefined,
		setTodos: vi.fn(),
		showStatus: vi.fn(),
		showWarning: vi.fn(),
		clearPinnedError: vi.fn(),
		clearTransientSessionUi: () => {
			pendingMessagesContainer.disposeChildren();
			pendingTools.clear();
		},
		updateEditorTopBorder: vi.fn(),
		ensureLoadingAnimation: vi.fn(),
	} as unknown as InteractiveModeContext;

	const helpers = new UiHelpers(ctx);
	const eventController = new EventController(ctx);
	ctx.eventController = eventController;
	ctx.renderInitialMessages = options => helpers.renderInitialMessages(options);
	const focus = new SessionFocusController(ctx, registry, () => lifecycle);
	ctx.unsubscribe = main.session.subscribe(event => eventController.handleEvent(event));
	return { ctx, focus, main };
}

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	await initTheme();
});

afterAll(() => {
	resetSettingsForTest();
});

describe("#9816 focus blackout across an in-flight hub wait", () => {
	it("drains a lost completion into the transcript before rebuilding the main session", async () => {
		const { ctx, focus, main } = createFixture();
		await ctx.renderInitialMessages();
		expect(Bun.stripANSI(ctx.chatContainer.render(120).join("\n"))).toContain("all running jobs");

		await focus.focusAgent("Worker");
		expect(main.hasListener()).toBe(false);

		// The main wait completes while its TUI listener is detached. AgentSession
		// has emitted the terminal display event but its following tool-result
		// message_end is still persisting.
		const finishPersistence = main.stagePersistedCompletion();
		const returning = focus.unfocus();
		queueMicrotask(finishPersistence);
		await returning;

		const rendered = Bun.stripANSI(ctx.chatContainer.render(120).join("\n"));
		expect(rendered).toContain("1 job settled");
		expect(rendered).toContain("Sleeper1");
		expect(rendered).not.toContain("all running jobs");
		expect(ctx.pendingTools.has("hub-1")).toBe(false);
	});
});

describe("#10446 task progress across a focus rebuild", () => {
	it("restores the latest in-flight task board after returning to main", async () => {
		const main = makeSession([danglingTask], true);
		const fixture = createFixture(main);

		await fixture.ctx.renderInitialMessages();
		await main.emitToolUpdate(taskProgressUpdate);
		const before = Bun.stripANSI(fixture.ctx.chatContainer.render(120).join("\n"));
		expect(before).toContain("Parent>Child");
		expect(before).toContain("packages/coding-agent/src/modes");

		await fixture.focus.focusAgent("Worker");
		await fixture.focus.unfocus();

		const after = Bun.stripANSI(fixture.ctx.chatContainer.render(120).join("\n"));
		expect(after).toContain("Parent>Child");
		expect(after).toContain("packages/coding-agent/src/modes");
	});
});

describe("#10447 persisted background task board across a focus rebuild", () => {
	it("keeps a returned detached task parked so cached and later progress land after return", async () => {
		// Detached task: its call already returned an async.state "running" result
		// (persisted), and the main session is idle while the job keeps streaming.
		const main = makeSession([backgroundTaskCall, backgroundTaskRunningResult], false, ["job-bg"]);
		const fixture = createFixture(main);

		await fixture.ctx.renderInitialMessages();
		await main.emitToolUpdate(backgroundProgressUpdate("cached-progress-marker"));
		const before = Bun.stripANSI(fixture.ctx.chatContainer.render(120).join("\n"));
		expect(before).toContain("cached-progress-marker");

		await fixture.focus.focusAgent("Worker");
		await fixture.focus.unfocus();

		// The rebuilt board replays the cached snapshot instead of collapsing to
		// the persisted "running" result, and the card is still parked as pending.
		const after = Bun.stripANSI(fixture.ctx.chatContainer.render(120).join("\n"));
		expect(after).toContain("cached-progress-marker");
		expect(fixture.ctx.pendingTools.has("task-bg")).toBe(true);

		// A live frame emitted after return still routes to the preserved card.
		await main.emitToolUpdate(backgroundProgressUpdate("post-return-marker"));
		const live = Bun.stripANSI(fixture.ctx.chatContainer.render(120).join("\n"));
		expect(live).toContain("post-return-marker");
	});

	it("replays a terminal frame that lands while another session is focused", async () => {
		const main = makeSession([backgroundTaskCall, backgroundTaskRunningResult], false, ["job-bg"]);
		const fixture = createFixture(main);

		await fixture.ctx.renderInitialMessages();
		await fixture.focus.focusAgent("Worker");
		await main.emitToolUpdate(backgroundProgressUpdate("completed-while-focused", "completed"));
		await fixture.focus.unfocus();

		const after = Bun.stripANSI(fixture.ctx.chatContainer.render(120).join("\n"));
		expect(after).toContain("completed-while-focused");
		expect(fixture.ctx.pendingTools.has("task-bg")).toBe(false);
	});

	it("finalizes a persisted running snapshot when its job no longer exists", async () => {
		const main = makeSession([backgroundTaskCall, backgroundTaskRunningResult], false);
		const fixture = createFixture(main);

		await fixture.ctx.renderInitialMessages();

		expect(fixture.ctx.pendingTools.has("task-bg")).toBe(false);
	});
});
