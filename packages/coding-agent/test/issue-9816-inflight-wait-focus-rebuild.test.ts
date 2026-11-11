/**
 * Regression #9816: while a subagent is focused, the TUI is unsubscribed from
 * the main AgentSession. A main-session tool completion can therefore be emitted
 * with no display listener while its following tool-result `message_end` is
 * still being persisted. Returning immediately used to rebuild from the stale
 * dangling toolCall, classify the now-idle session as historical, and seal a
 * permanent pending `wait` card.
 *
 * Contract: focus attach subscribes to the target, drains its in-flight event
 * handlers/persistence, then rebuilds. A completion already emitted during the
 * focus blackout is authoritative in the rebuilt transcript; a later event is
 * delivered through the newly installed subscription.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, ToolResultMessage } from "@oh-my-pi/pi-ai";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import { SessionFocusController } from "@oh-my-pi/pi-coding-agent/modes/controllers/session-focus-controller";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { UiHelpers } from "@oh-my-pi/pi-coding-agent/modes/utils/ui-helpers";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry, MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession, AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { SessionContext } from "@oh-my-pi/pi-coding-agent/session/session-context";
import type { AgentProgress, TaskToolDetails } from "@oh-my-pi/pi-tui/tools/task";
import { createInteractiveModeContext } from "./helpers/interactive-mode-context";

const usage = {
	input: 1,
	output: 1,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 2,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const danglingWait = {
	role: "assistant",
	content: [{ type: "toolCall", id: "wait-1", name: "wait", arguments: {} }],
	api: "anthropic-messages",
	provider: "anthropic",
	model: "claude-sonnet-4-5",
	stopReason: "toolUse",
	usage,
	timestamp: Date.now(),
} as unknown as AgentMessage;

const completedWait = {
	role: "toolResult",
	toolCallId: "wait-1",
	toolName: "wait",
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
	emit(event: AgentSessionEvent): Promise<void>;
	setLiveAssistant(message: AssistantMessage | null, results: ToolResultMessage[]): void;
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
	let liveMessage: AssistantMessage | null = null;
	let bufferedResults: ToolResultMessage[] = [];

	const stub = {
		get isStreaming() {
			return streaming;
		},
		retryAttempt: 0,
		agent: {
			get state() {
				return { streamMessage: liveMessage };
			},
			getPendingToolResults: () => bufferedResults,
		},
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
			getConversationTip: () => undefined,
		},
	};

	return {
		session: stub as unknown as AgentSession,
		hasListener: () => listener !== undefined,
		emitToolUpdate: async event => {
			activeToolUpdates.set(event.toolCallId, event);
			await listener?.(event);
		},
		emit: async event => {
			if (event.type === "message_end" && event.message.role === "assistant") liveMessage = null;
			await listener?.(event);
		},
		setLiveAssistant: (message, results) => {
			liveMessage = message;
			bufferedResults = results;
		},
		stagePersistedCompletion: () => {
			streaming = false;
			const pending = Promise.withResolvers<void>();
			persistence = pending.promise;
			return () => {
				messages = [danglingWait, completedWait];
				pending.resolve();
			};
		},
	};
}

function createFixture(main = makeSession([danglingWait], true), worker = makeSession([], false)) {
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
	const ctx = createInteractiveModeContext({
		session: main.session,
		initialChatRendered: false,
	});
	ctx.clearTransientSessionUi = () => {
		ctx.pendingMessagesContainer.disposeChildren();
		ctx.pendingTools.clear();
		ctx.streamingComponent = undefined;
		ctx.streamingMessage = undefined;
	};

	const helpers = new UiHelpers(ctx);
	ctx.addMessageToChat = helpers.addMessageToChat.bind(helpers);
	ctx.renderSessionContext = helpers.renderSessionContext.bind(helpers);
	ctx.renderSessionContextIncrementally = helpers.renderSessionContextIncrementally.bind(helpers);
	ctx.renderInitialMessages = helpers.renderInitialMessages.bind(helpers);
	const eventController = new EventController(ctx);
	ctx.eventController = eventController;
	const focus = new SessionFocusController(ctx, registry, () => lifecycle);
	Object.defineProperty(ctx, "viewSession", {
		configurable: true,
		get: () => focus.target ?? main.session,
	});
	ctx.unsubscribe = main.session.subscribe(event => eventController.handleEvent(event));
	return { ctx, focus, main, worker };
}

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	await initTheme();
});

afterAll(() => {
	resetSettingsForTest();
});

describe("#9816 focus blackout across an in-flight wait", () => {
	it("drains a lost completion into the transcript before rebuilding the main session", async () => {
		const { ctx, focus, main } = createFixture();
		await ctx.renderInitialMessages();
		const pending = Bun.stripANSI(ctx.chatContainer.render(120).join("\n"));
		expect(pending).toContain("Wait");
		expect(pending).not.toContain("Sleeper1");

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
		expect(rendered).toContain("Sleeper1 done");
		expect(ctx.pendingTools.has("wait-1")).toBe(false);
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

describe("live Cursor focus recovery without another delta", () => {
	const paused: AssistantMessage = {
		role: "assistant",
		content: [
			{ type: "thinking", thinking: "PAUSED_REASONING" },
			{ type: "toolCall", id: "paused-grep", name: "grep", arguments: { pattern: "sample" } },
			{ type: "text", text: "LAST_VISIBLE_TEXT" },
		],
		api: "cursor-agent",
		provider: "cursor",
		model: "cursor-grok-4.6",
		stopReason: "stop",
		usage,
		timestamp: 1,
	};
	const result: ToolResultMessage = {
		role: "toolResult",
		toolCallId: "paused-grep",
		toolName: "grep",
		content: [{ type: "text", text: "COMPLETED_MATCH" }],
		isError: false,
		timestamp: 2,
	};

	it("keeps post-tool text streaming when a live update races with focus restoration", async () => {
		const settledResult: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "settled-grep",
			toolName: "grep",
			content: [{ type: "text", text: "SETTLED_DURING_SWITCH" }],
			isError: false,
			timestamp: 2,
		};
		const liveMessage: AssistantMessage = {
			...paused,
			content: [
				{ type: "thinking", thinking: "PAUSED_REASONING" },
				{ type: "toolCall", id: "settled-grep", name: "grep", arguments: { pattern: "settled" } },
				{ type: "toolCall", id: "paused-grep", name: "grep", arguments: { pattern: "sample" } },
				{ type: "text", text: "LAST_VISIBLE_TEXT" },
			],
		};
		const main = makeSession([], true);
		main.setLiveAssistant(liveMessage, []);
		const { ctx, focus } = createFixture(main);
		try {
			await focus.focusAgent("Worker");
			const renderInitialMessages = ctx.renderInitialMessages.bind(ctx);
			// Emitted mid-rebuild; delivery is queued behind it, so it is awaited only afterwards.
			// `settled-grep` both starts and finishes before the switch ends (its buffered result is
			// consumed by `restoreAssistant` ahead of its queued `tool_execution_start`).
			let racing: Promise<unknown> = Promise.resolve();
			ctx.renderInitialMessages = async options => {
				await renderInitialMessages(options);
				main.setLiveAssistant(liveMessage, [settledResult]);
				racing = Promise.all([
					main.emit({
						type: "message_update",
						message: liveMessage,
						assistantMessageEvent: {
							type: "text_delta",
							contentIndex: 3,
							delta: "LAST_VISIBLE_TEXT",
							partial: liveMessage,
						},
					}),
					main.emit({
						type: "tool_execution_start",
						toolCallId: "settled-grep",
						toolName: "grep",
						args: { pattern: "settled" },
						intent: undefined,
					}),
					main.emit({
						type: "tool_execution_end",
						toolCallId: "settled-grep",
						toolName: "grep",
						result: { content: settledResult.content, details: {} },
						isError: false,
					}),
					main.emit({
						type: "tool_execution_start",
						toolCallId: "paused-grep",
						toolName: "grep",
						args: { pattern: "sample" },
						intent: undefined,
					}),
				]);
			};
			await focus.unfocus();
			await racing;

			const continued: AssistantMessage = {
				...liveMessage,
				content: [...liveMessage.content.slice(0, 3), { type: "text", text: "LAST_VISIBLE_TEXT AFTER_FOCUS" }],
			};
			await main.emit({
				type: "message_update",
				message: continued,
				assistantMessageEvent: { type: "text_delta", contentIndex: 3, delta: " AFTER_FOCUS", partial: continued },
			});
			const rendered = () => Bun.stripANSI(ctx.chatContainer.render(120).join("\n"));
			expect(rendered()).toContain("AFTER_FOCUS");
			expect(rendered().match(/SETTLED_DURING_SWITCH/g)).toHaveLength(1);
			expect(ctx.pendingTools.has("settled-grep")).toBe(false);
			expect(ctx.pendingTools.has("paused-grep")).toBe(true);

			await main.emit({
				type: "tool_execution_end",
				toolCallId: "paused-grep",
				toolName: "grep",
				result: { content: result.content, details: {} },
				isError: false,
			});
			await main.emit({ type: "message_end", message: continued });
			const final = rendered();
			expect(final.match(/AFTER_FOCUS/g)).toHaveLength(1);
			expect(final.match(/SETTLED_DURING_SWITCH/g)).toHaveLength(1);
			expect(final.match(/COMPLETED_MATCH/g)).toHaveLength(1);
			expect(final.indexOf("PAUSED_REASONING")).toBeGreaterThanOrEqual(0);
			expect(final.indexOf("PAUSED_REASONING")).toBeLessThan(final.indexOf("SETTLED_DURING_SWITCH"));
			expect(final.indexOf("SETTLED_DURING_SWITCH")).toBeLessThan(final.indexOf("COMPLETED_MATCH"));
			expect(final.indexOf("COMPLETED_MATCH")).toBeLessThan(final.indexOf("LAST_VISIBLE_TEXT AFTER_FOCUS"));
			expect(ctx.pendingTools.size).toBe(0);
		} finally {
			focus.dispose();
			ctx.unsubscribe?.();
			ctx.eventController.dispose();
			for (const component of ctx.pendingTools.values()) component.seal();
		}
	});

	it("restores the paused assistant and completed card before any later event", async () => {
		const main = makeSession([], true);
		main.setLiveAssistant(paused, [result]);
		const { ctx, focus } = createFixture(main);
		await focus.focusAgent("Worker");
		await focus.unfocus();
		const rendered = () => Bun.stripANSI(ctx.chatContainer.render(120).join("\n"));
		expect(rendered()).toContain("PAUSED_REASONING");
		expect(rendered()).toContain("COMPLETED_MATCH");
		expect(ctx.pendingTools.size).toBe(0);
		await main.emit({ type: "message_end", message: paused });
		expect(rendered().match(/LAST_VISIBLE_TEXT/g)).toHaveLength(1);
		expect(rendered().match(/COMPLETED_MATCH/g)).toHaveLength(1);
	});

	it("materializes an orphaned terminal message without needing a message_update", async () => {
		const main = makeSession([], true);
		main.setLiveAssistant(null, [result]);
		const { ctx, focus } = createFixture(main);
		await focus.focusAgent("Worker");
		await focus.unfocus();
		await main.emit({ type: "message_end", message: paused });
		const rendered = Bun.stripANSI(ctx.chatContainer.render(120).join("\n"));
		expect(rendered).toContain("LAST_VISIBLE_TEXT");
		expect(rendered).toContain("COMPLETED_MATCH");
		expect(ctx.pendingTools.size).toBe(0);
	});

	it("settles replay-created tool cards from buffered results", async () => {
		const main = makeSession([paused], true);
		main.setLiveAssistant(null, [result]);
		const { ctx, focus } = createFixture(main);
		await focus.focusAgent("Worker");
		await focus.unfocus();
		expect(Bun.stripANSI(ctx.chatContainer.render(120).join("\n"))).toContain("COMPLETED_MATCH");
		expect(ctx.pendingTools.size).toBe(0);
	});

	it("serializes focused assistant-end link resolution ahead of the next turn and drops queued events on detach", async () => {
		const mainLive: AssistantMessage = {
			...paused,
			content: [{ type: "text", text: "MAIN_ACTIVE_STREAM" }],
			timestamp: 10,
		};
		const main = makeSession([], true);
		main.setLiveAssistant(mainLive, []);
		const worker = makeSession([], true);
		const { ctx, focus } = createFixture(main, worker);
		ctx.settings = Settings.isolated({ "display.smoothStreaming": false });
		const firstAssistant: AssistantMessage = {
			...paused,
			content: [
				{ type: "text", text: "FIRST_LINK_TEXT [guide](guide.md)" },
				{ type: "toolCall", id: "paused-grep", name: "grep", arguments: { pattern: "sample" } },
			],
			stopReason: "toolUse",
			timestamp: 1,
		};
		const secondAssistant: AssistantMessage = {
			...paused,
			content: [{ type: "text", text: "SECOND_LIVE_TEXT [next](next.md)" }],
			timestamp: 3,
		};
		const continuedSecond: AssistantMessage = {
			...secondAssistant,
			content: [{ type: "text", text: "SECOND_LIVE_TEXT [next](next.md) CONTINUED" }],
		};
		const thirdAssistant: AssistantMessage = {
			...paused,
			content: [{ type: "text", text: "STALE_THIRD_WORKER_TEXT" }],
			timestamp: 4,
		};
		let linkStarted = Promise.withResolvers<void>();
		let linkGate = Promise.withResolvers<ReadonlyMap<string, string>>();
		ctx.resolveAssistantMessageLinkHrefs = async () => {
			linkStarted.resolve();
			return linkGate.promise;
		};
		try {
			await focus.focusAgent("Worker");

			const firstEnd = worker.emit({ type: "message_end", message: firstAssistant });
			await linkStarted.promise;

			const toolStart = worker.emit({
				type: "tool_execution_start",
				toolCallId: "paused-grep",
				toolName: "grep",
				args: { pattern: "sample" },
				intent: undefined,
			});
			const toolEnd = worker.emit({
				type: "tool_execution_end",
				toolCallId: "paused-grep",
				toolName: "grep",
				result: { content: result.content, details: {} },
				isError: false,
			});
			const secondStart = worker.emit({ type: "message_start", message: secondAssistant });
			const secondUpdate = worker.emit({
				type: "message_update",
				message: secondAssistant,
				assistantMessageEvent: {
					type: "text_delta",
					contentIndex: 0,
					delta: "SECOND_LIVE_TEXT [next](next.md)",
					partial: secondAssistant,
				},
			});

			linkGate.resolve(new Map([["guide.md", "file:///tmp/guide.md"]]));
			await Promise.all([firstEnd, toolStart, toolEnd, secondStart, secondUpdate]);

			const rendered = () => Bun.stripANSI(ctx.chatContainer.render(120).join("\n"));
			expect(rendered()).toContain("FIRST_LINK_TEXT");
			expect(rendered()).toContain("COMPLETED_MATCH");
			expect(rendered()).toContain("SECOND_LIVE_TEXT");
			expect(ctx.streamingMessage).toBe(secondAssistant);

			await worker.emit({
				type: "message_update",
				message: continuedSecond,
				assistantMessageEvent: {
					type: "text_delta",
					contentIndex: 0,
					delta: " CONTINUED",
					partial: continuedSecond,
				},
			});
			expect(rendered().match(/SECOND_LIVE_TEXT/g)).toHaveLength(1);
			expect(rendered()).toContain("CONTINUED");
			expect(ctx.streamingMessage).toBe(continuedSecond);

			linkStarted = Promise.withResolvers<void>();
			linkGate = Promise.withResolvers<ReadonlyMap<string, string>>();
			const secondEnd = worker.emit({ type: "message_end", message: continuedSecond });
			await linkStarted.promise;
			const thirdStart = worker.emit({ type: "message_start", message: thirdAssistant });
			const thirdUpdate = worker.emit({
				type: "message_update",
				message: thirdAssistant,
				assistantMessageEvent: {
					type: "text_delta",
					contentIndex: 0,
					delta: "STALE_THIRD_WORKER_TEXT",
					partial: thirdAssistant,
				},
			});

			const returning = focus.unfocus();
			linkGate.resolve(new Map());
			await Promise.all([returning, secondEnd, thirdStart, thirdUpdate]);

			expect(rendered()).toContain("MAIN_ACTIVE_STREAM");
			expect(rendered()).not.toContain("SECOND_LIVE_TEXT");
			expect(rendered()).not.toContain("STALE_THIRD_WORKER_TEXT");
			expect(ctx.streamingMessage).toBe(mainLive);
		} finally {
			focus.dispose();
			ctx.unsubscribe?.();
			ctx.eventController.dispose();
			for (const component of ctx.pendingTools.values()) component.seal();
		}
	});

	it("does not duplicate a message that arrives during attachment behind a slow link check", async () => {
		const arrivalMessage = {
			role: "user",
			content: [{ type: "text", text: "ARRIVAL_DURING_ATTACH" }],
			timestamp: 5,
		} as unknown as AgentMessage;
		const main = makeSession([arrivalMessage], false);
		const worker = makeSession([], true);
		const { ctx, focus } = createFixture(main, worker);
		ctx.settings = Settings.isolated({ "display.smoothStreaming": false });
		const workerAssistant: AssistantMessage = {
			...paused,
			content: [{ type: "text", text: "WORKER_LINK [x](x.md)" }],
			stopReason: "stop",
			timestamp: 1,
		};
		const linkStarted = Promise.withResolvers<void>();
		const linkGate = Promise.withResolvers<ReadonlyMap<string, string>>();
		ctx.resolveAssistantMessageLinkHrefs = async () => {
			linkStarted.resolve();
			return linkGate.promise;
		};
		try {
			await focus.focusAgent("Worker");
			await worker.emit({ type: "message_start", message: workerAssistant });
			const stuckEnd = worker.emit({ type: "message_end", message: workerAssistant });
			await linkStarted.promise;

			const renderInitialMessages = ctx.renderInitialMessages.bind(ctx);
			const mainRenderDone = Promise.withResolvers<void>();
			ctx.renderInitialMessages = async options => {
				await renderInitialMessages(options);
				mainRenderDone.resolve();
			};

			const returning = focus.unfocus();
			const arrival = main.emit({ type: "message_start", message: arrivalMessage });
			// Let attachment run as far as it can while the link check is held: the
			// uncoordinated path completes the rebuild (painting the arrival from the
			// snapshot) while its event is still queued; the coordinated path waits.
			await Promise.race([
				mainRenderDone.promise,
				(async () => {
					for (let i = 0; i < 50; i++) await Promise.resolve();
				})(),
			]);
			linkGate.resolve(new Map());
			await Promise.all([returning, arrival, stuckEnd]);

			const rendered = Bun.stripANSI(ctx.chatContainer.render(120).join("\n"));
			expect(rendered.match(/ARRIVAL_DURING_ATTACH/g)).toHaveLength(1);
		} finally {
			focus.dispose();
			ctx.unsubscribe?.();
			ctx.eventController.dispose();
			for (const component of ctx.pendingTools.values()) component.seal();
		}
	});

	/** Focus `Worker`, then hold its finished reply's link check so the switch back to `main` queues behind it. */
	async function focusBehindHeldLinkCheck(main: SessionStub) {
		const worker = makeSession([], true);
		const fixture = createFixture(main, worker);
		fixture.ctx.settings = Settings.isolated({ "display.smoothStreaming": false });
		const workerAssistant: AssistantMessage = {
			...paused,
			content: [{ type: "text", text: "WORKER_LINK [x](x.md)" }],
			timestamp: 1,
		};
		const linkStarted = Promise.withResolvers<void>();
		const linkGate = Promise.withResolvers<ReadonlyMap<string, string>>();
		fixture.ctx.resolveAssistantMessageLinkHrefs = async () => {
			linkStarted.resolve();
			return linkGate.promise;
		};
		await fixture.focus.focusAgent("Worker");
		await worker.emit({ type: "message_start", message: workerAssistant });
		const stuckEnd = worker.emit({ type: "message_end", message: workerAssistant });
		await linkStarted.promise;
		const dispose = () => {
			fixture.focus.dispose();
			fixture.ctx.unsubscribe?.();
			fixture.ctx.eventController.dispose();
			for (const component of fixture.ctx.pendingTools.values()) component.seal();
		};
		return { ...fixture, stuckEnd, release: () => linkGate.resolve(new Map()), dispose };
	}

	it("draws messages that arrive after the switch queued its rebuild once, replayed or not", async () => {
		const earlier: AssistantMessage = {
			...paused,
			content: [{ type: "text", text: "EARLIER_REPLY [b](b.md)" }],
			timestamp: 2,
		};
		const arrivedReply: AssistantMessage = {
			...paused,
			content: [{ type: "text", text: "ARRIVED_REPLY [a](a.md)" }],
			timestamp: 4,
		};
		const replayed = {
			role: "user",
			content: [{ type: "text", text: "REPLAYED_ARRIVAL" }],
			timestamp: 5,
		} as unknown as AgentMessage;
		const liveOnly = {
			role: "user",
			content: [{ type: "text", text: "LIVE_ONLY_ARRIVAL" }],
			timestamp: 6,
		} as unknown as AgentMessage;
		const mainMessages: AgentMessage[] = [earlier];
		const main = makeSession(mainMessages, false);
		const { ctx, focus, stuckEnd, release, dispose } = await focusBehindHeldLinkCheck(main);
		// The arrived reply's own link check (it alone asks for just `a.md`; the rebuild resolves every
		// replayed link at once) finishes only after the rebuild commits, so whatever is queued behind
		// that check is delivered after the commit.
		const committed = Promise.withResolvers<void>();
		const renderInitialMessages = ctx.renderInitialMessages.bind(ctx);
		ctx.renderInitialMessages = async options => {
			await renderInitialMessages(options);
			committed.resolve();
		};
		ctx.resolveAssistantMessageLinkHrefs = async hrefs => {
			if (hrefs.length === 1 && hrefs[0] === "a.md") await committed.promise;
			return new Map();
		};
		try {
			const returning = focus.unfocus();
			// Let the switch queue its own work behind the held link check before anything arrives.
			for (let i = 0; i < 20; i++) await Promise.resolve();
			// The reply and one prompt are persisted before the rebuild reads the transcript; one never is.
			mainMessages.push(arrivedReply, replayed);
			const arrivals = [arrivedReply, replayed, liveOnly].flatMap(message => [
				main.emit({ type: "message_start", message }),
				main.emit({ type: "message_end", message }),
			]);
			release();
			await Promise.all([returning, stuckEnd, ...arrivals]);

			const rendered = Bun.stripANSI(ctx.chatContainer.render(120).join("\n"));
			expect(rendered.match(/ARRIVED_REPLY/g)).toHaveLength(1);
			expect(rendered.match(/REPLAYED_ARRIVAL/g)).toHaveLength(1);
			expect(rendered.match(/LIVE_ONLY_ARRIVAL/g)).toHaveLength(1);
		} finally {
			dispose();
		}
	});

	it("keeps a reply that starts during the switch attached to the rebuilt transcript", async () => {
		const reply: AssistantMessage = {
			...paused,
			content: [{ type: "text", text: "REPLY_DURING_SWITCH" }],
			timestamp: 7,
		};
		const continued: AssistantMessage = {
			...reply,
			content: [{ type: "text", text: "REPLY_DURING_SWITCH AND_AFTER" }],
		};
		const main = makeSession([], true);
		const { ctx, focus, stuckEnd, release, dispose } = await focusBehindHeldLinkCheck(main);
		try {
			const returning = focus.unfocus();
			main.setLiveAssistant(reply, []);
			const started = [
				main.emit({ type: "message_start", message: reply }),
				main.emit({
					type: "message_update",
					message: reply,
					assistantMessageEvent: {
						type: "text_delta",
						contentIndex: 0,
						delta: "REPLY_DURING_SWITCH",
						partial: reply,
					},
				}),
			];
			release();
			await Promise.all([returning, stuckEnd, ...started]);

			main.setLiveAssistant(continued, []);
			await main.emit({
				type: "message_update",
				message: continued,
				assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: " AND_AFTER", partial: continued },
			});
			const rendered = () => Bun.stripANSI(ctx.chatContainer.render(120).join("\n"));
			expect(rendered()).toContain("AND_AFTER");
			await main.emit({ type: "message_end", message: continued });
			expect(rendered().match(/REPLY_DURING_SWITCH/g)).toHaveLength(1);
			expect(rendered()).toContain("AND_AFTER");
		} finally {
			dispose();
		}
	});

	it("draws an extension message persisted during the switch once, though its rebuilt copy is a new object", async () => {
		const note = {
			role: "custom",
			customType: "ext-note",
			content: "EXT_DURING_SWITCH",
			display: true,
			timestamp: 8,
		} as unknown as AgentMessage;
		const mainMessages: AgentMessage[] = [];
		const main = makeSession(mainMessages, false);
		const { ctx, focus, stuckEnd, release, dispose } = await focusBehindHeldLinkCheck(main);
		try {
			const returning = focus.unfocus();
			for (let i = 0; i < 20; i++) await Promise.resolve();
			// The session persists an idle display message before emitting it; the rebuild reads it back
			// from its entry as a new object.
			mainMessages.push({ ...note });
			const arrivals = [
				main.emit({ type: "message_start", message: note }),
				main.emit({ type: "message_end", message: note }),
			];
			release();
			await Promise.all([returning, stuckEnd, ...arrivals]);

			const rendered = Bun.stripANSI(ctx.chatContainer.render(120).join("\n"));
			expect(rendered.match(/EXT_DURING_SWITCH/g)).toHaveLength(1);
		} finally {
			dispose();
		}
	});

	it("draws a tool that finishes during the switch once, and still shows a retry after switching back", async () => {
		const call: AssistantMessage = {
			...paused,
			content: [{ type: "toolCall", id: "switch-grep", name: "grep", arguments: { pattern: "TOOL_DURING_SWITCH" } }],
			stopReason: "toolUse",
			timestamp: 9,
		};
		const finished: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "switch-grep",
			toolName: "grep",
			content: [{ type: "text", text: "SWITCH_MATCH" }],
			isError: true,
			timestamp: 10,
		};
		const mainMessages: AgentMessage[] = [call];
		const main = makeSession(mainMessages, true);
		const { ctx, focus, stuckEnd, release, dispose } = await focusBehindHeldLinkCheck(main);
		try {
			const returning = focus.unfocus();
			for (let i = 0; i < 20; i++) await Promise.resolve();
			// The tool runs and its result is persisted before the rebuild reads the transcript.
			mainMessages.push(finished);
			const tool = { toolCallId: "switch-grep", toolName: "grep" };
			const arrivals = [
				main.emit({ type: "tool_execution_start", ...tool, args: { pattern: "TOOL_DURING_SWITCH" } }),
				main.emit({ type: "tool_execution_end", ...tool, result: { content: finished.content }, isError: true }),
				main.emit({ type: "message_start", message: finished }),
				main.emit({ type: "message_end", message: finished }),
			];
			release();
			await Promise.all([returning, stuckEnd, ...arrivals]);

			const rendered = () => Bun.stripANSI(ctx.chatContainer.render(120).join("\n"));
			expect(rendered().match(/TOOL_DURING_SWITCH/g)).toHaveLength(1);

			// F5 retry after switching back re-runs the same toolCallId.
			await main.emit({ type: "agent_start" });
			await main.emit({ type: "tool_execution_start", ...tool, args: { pattern: "TOOL_DURING_SWITCH" } });
			expect(ctx.pendingTools.has("switch-grep")).toBe(true);
			await main.emit({
				type: "tool_execution_update",
				...tool,
				args: { pattern: "TOOL_DURING_SWITCH" },
				partialResult: { content: [{ type: "text", text: "RETRY_PROGRESS" }] },
			});
			expect(rendered()).toContain("RETRY_PROGRESS");
			await main.emit({
				type: "tool_execution_end",
				...tool,
				result: { content: [{ type: "text", text: "RETRY_MATCH" }] },
				isError: false,
			});
			expect(ctx.pendingTools.has("switch-grep")).toBe(false);
			expect(rendered()).toContain("RETRY_MATCH");
		} finally {
			dispose();
		}
	});

	it("draws an older reply that ends after the transcript is read before restoring the newer live reply", async () => {
		const older: AssistantMessage = { ...paused, content: [{ type: "text", text: "OLDER_REPLY" }], timestamp: 11 };
		const newer: AssistantMessage = { ...paused, content: [{ type: "text", text: "NEWER_REPLY" }], timestamp: 12 };
		const continued: AssistantMessage = { ...newer, content: [{ type: "text", text: "NEWER_REPLY AND_AFTER" }] };
		const main = makeSession([], true);
		main.setLiveAssistant(older, []);
		const { ctx, focus, stuckEnd, release, dispose } = await focusBehindHeldLinkCheck(main);
		// Right after the rebuild reads the transcript, the older reply ends and the newer one starts.
		const stub = main.session as unknown as { buildTranscriptSessionContext: () => SessionContext };
		const read = stub.buildTranscriptSessionContext.bind(stub);
		let raced: Promise<unknown> | undefined;
		stub.buildTranscriptSessionContext = () => {
			const context = read();
			raced ??= Promise.resolve().then(() => {
				const ended = main.emit({ type: "message_end", message: older });
				main.setLiveAssistant(newer, []);
				return Promise.all([ended, main.emit({ type: "message_start", message: newer })]);
			});
			return context;
		};
		try {
			const returning = focus.unfocus();
			release();
			await Promise.all([returning, stuckEnd]);
			await raced;
			const rendered = () => Bun.stripANSI(ctx.chatContainer.render(120).join("\n"));
			// Before the newer reply sends anything else, both are on screen, the older one first.
			const switched = rendered();
			expect(switched.match(/OLDER_REPLY/g)).toHaveLength(1);
			expect(switched.match(/NEWER_REPLY/g)).toHaveLength(1);
			expect(switched.indexOf("OLDER_REPLY")).toBeLessThan(switched.indexOf("NEWER_REPLY"));

			main.setLiveAssistant(continued, []);
			await main.emit({
				type: "message_update",
				message: continued,
				assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: " AND_AFTER", partial: continued },
			});
			await main.emit({ type: "message_end", message: continued });
			expect(rendered().match(/OLDER_REPLY/g)).toHaveLength(1);
			expect(rendered().match(/NEWER_REPLY/g)).toHaveLength(1);
			expect(rendered()).toContain("AND_AFTER");
		} finally {
			dispose();
		}
	});
	it("drops a tool-calling message update whose link check finishes after a focus switch", async () => {
		const mainPrompt = {
			role: "user",
			content: [{ type: "text", text: "MAIN_AFTER_SWITCH" }],
			timestamp: 20,
		} as unknown as AgentMessage;
		const main = makeSession([mainPrompt], false);
		const worker = makeSession([], true);
		const { ctx, focus } = createFixture(main, worker);
		ctx.settings = Settings.isolated({ "display.smoothStreaming": false });
		const started: AssistantMessage = {
			...paused,
			content: [{ type: "text", text: "WORKER_HEAD [h](head.md)" }],
			timestamp: 21,
		};
		const toolUpdate: AssistantMessage = {
			...paused,
			content: [
				{ type: "text", text: "WORKER_HEAD [h](head.md)" },
				{ type: "toolCall", id: "stale-grep", name: "grep", arguments: { pattern: "STALE_TOOL" } },
			],
			timestamp: 21,
		};
		const linkStarted = Promise.withResolvers<void>();
		const linkGate = Promise.withResolvers<ReadonlyMap<string, string>>();
		ctx.resolveAssistantMessageLinkHrefs = async () => {
			linkStarted.resolve();
			return linkGate.promise;
		};
		try {
			await focus.focusAgent("Worker");
			await worker.emit({ type: "message_start", message: started });
			// The update's first tool call makes `syncAssistantMessage` await link
			// resolution before finalizing the streaming block.
			const stuckUpdate = worker.emit({
				type: "message_update",
				message: toolUpdate,
				assistantMessageEvent: {
					type: "toolcall_end",
					contentIndex: 1,
					toolCall: { type: "toolCall", id: "stale-grep", name: "grep", arguments: { pattern: "STALE_TOOL" } },
					partial: toolUpdate,
				},
			});
			await linkStarted.promise;

			// The switch resets the streaming state synchronously, then queues its
			// rebuild behind this in-flight update.
			const returning = focus.unfocus();
			linkGate.resolve(new Map());
			await Promise.all([returning, stuckUpdate]);

			const rendered = Bun.stripANSI(ctx.chatContainer.render(120).join("\n"));
			expect(rendered).toContain("MAIN_AFTER_SWITCH");
			expect(rendered).not.toContain("WORKER_HEAD");
			expect(rendered).not.toContain("STALE_TOOL");
			expect(ctx.pendingTools.has("stale-grep")).toBe(false);
			expect(ctx.streamingMessage).toBeUndefined();
		} finally {
			focus.dispose();
			ctx.unsubscribe?.();
			ctx.eventController.dispose();
			for (const component of ctx.pendingTools.values()) component.seal();
		}
	});

	it("drops a post-tool segment whose link check finishes after a focus switch", async () => {
		const mainPrompt = {
			role: "user",
			content: [{ type: "text", text: "MAIN_SEGMENT_HOME" }],
			timestamp: 22,
		} as unknown as AgentMessage;
		const main = makeSession([mainPrompt], false);
		const worker = makeSession([], true);
		const { ctx, focus } = createFixture(main, worker);
		ctx.settings = Settings.isolated({ "display.smoothStreaming": false });
		const started: AssistantMessage = {
			...paused,
			content: [{ type: "text", text: "WORKER_SEG_HEAD [h](head.md)" }],
			timestamp: 23,
		};
		const toolUpdate: AssistantMessage = {
			...paused,
			content: [
				{ type: "text", text: "WORKER_SEG_HEAD [h](head.md)" },
				{ type: "toolCall", id: "seg-grep-1", name: "grep", arguments: { pattern: "SEG_ONE" } },
				{ type: "text", text: "STALE_SEGMENT [s](segment.md)" },
				{ type: "toolCall", id: "seg-grep-2", name: "grep", arguments: { pattern: "SEG_TWO" } },
			],
			timestamp: 23,
		};
		const segmentStarted = Promise.withResolvers<void>();
		const segmentGate = Promise.withResolvers<ReadonlyMap<string, string>>();
		ctx.resolveAssistantMessageLinkHrefs = async hrefs => {
			// Only the closed post-tool segment's own link check is held; the
			// before-tools check ahead of it resolves immediately.
			if (hrefs.includes("segment.md")) {
				segmentStarted.resolve();
				return segmentGate.promise;
			}
			return new Map();
		};
		try {
			await focus.focusAgent("Worker");
			await worker.emit({ type: "message_start", message: started });
			const stuckUpdate = worker.emit({
				type: "message_update",
				message: toolUpdate,
				assistantMessageEvent: {
					type: "toolcall_end",
					contentIndex: 3,
					toolCall: { type: "toolCall", id: "seg-grep-2", name: "grep", arguments: { pattern: "SEG_TWO" } },
					partial: toolUpdate,
				},
			});
			await segmentStarted.promise;

			const returning = focus.unfocus();
			segmentGate.resolve(new Map());
			await Promise.all([returning, stuckUpdate]);

			const rendered = Bun.stripANSI(ctx.chatContainer.render(120).join("\n"));
			expect(rendered).toContain("MAIN_SEGMENT_HOME");
			expect(rendered).not.toContain("STALE_SEGMENT");
			expect(ctx.pendingTools.has("seg-grep-1")).toBe(false);
			expect(ctx.pendingTools.has("seg-grep-2")).toBe(false);
			expect(ctx.streamingMessage).toBeUndefined();
		} finally {
			focus.dispose();
			ctx.unsubscribe?.();
			ctx.eventController.dispose();
			for (const component of ctx.pendingTools.values()) component.seal();
		}
	});

	it("draws a later message that only collides with a replayed one on its timestamp key", async () => {
		const firstNote = {
			role: "custom",
			customType: "ext-note",
			content: "FIRST_NOTE",
			display: true,
			timestamp: 30,
		} as unknown as AgentMessage;
		const firstPrompt = {
			role: "user",
			content: [{ type: "text", text: "FIRST_PROMPT" }],
			timestamp: 31,
		} as unknown as AgentMessage;
		const main = makeSession([firstNote, firstPrompt], false);
		const worker = makeSession([], false);
		const { ctx, focus } = createFixture(main, worker);
		try {
			await focus.focusAgent("Worker");
			await focus.unfocus();

			// Same custom type and timestamp as the replayed note, and same
			// timestamp/attribution as the replayed prompt — the cheap identity
			// keys collide, but these are different messages.
			const secondNote = {
				role: "custom",
				customType: "ext-note",
				content: "SECOND_NOTE",
				display: true,
				timestamp: 30,
			} as unknown as AgentMessage;
			const secondPrompt = {
				role: "user",
				content: [{ type: "text", text: "SECOND_PROMPT" }],
				timestamp: 31,
			} as unknown as AgentMessage;
			for (const message of [secondNote, secondPrompt]) {
				await main.emit({ type: "message_start", message });
				await main.emit({ type: "message_end", message });
			}

			const rendered = Bun.stripANSI(ctx.chatContainer.render(120).join("\n"));
			expect(rendered.match(/FIRST_NOTE/g)).toHaveLength(1);
			expect(rendered.match(/SECOND_NOTE/g)).toHaveLength(1);
			expect(rendered.match(/FIRST_PROMPT/g)).toHaveLength(1);
			expect(rendered.match(/SECOND_PROMPT/g)).toHaveLength(1);
		} finally {
			focus.dispose();
			ctx.unsubscribe?.();
			ctx.eventController.dispose();
			for (const component of ctx.pendingTools.values()) component.seal();
		}
	});
});
