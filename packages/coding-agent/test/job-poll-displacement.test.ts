/**
 * Repeated `job` polls must not stack "waiting on N jobs" frames in the
 * transcript: a poll whose watched jobs are all still running stays live
 * (displaceable) and the next `job` call replaces it — one persistent poll.
 *
 * Contracts under test:
 *  - ToolExecutionComponent: a waiting-poll result keeps the block
 *    un-finalized and displaceable; a settled/cancelled/error result
 *    finalizes normally; seal() always freezes.
 *  - EventController: a follow-up `job` call removes the tracked waiting
 *    poll from the transcript; any other tool seals it in place.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import type { AgentMessage } from "@pk-nerdsaver-ai/pi-agent-core";
import { resetSettingsForTest, Settings } from "@pk-nerdsaver-ai/pi-coding-agent/config/settings";
import { ToolExecutionComponent } from "@pk-nerdsaver-ai/pi-coding-agent/modes/components/tool-execution";
import { EventController } from "@pk-nerdsaver-ai/pi-coding-agent/modes/controllers/event-controller";
import { initTheme } from "@pk-nerdsaver-ai/pi-coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@pk-nerdsaver-ai/pi-coding-agent/modes/types";
import { UiHelpers } from "@pk-nerdsaver-ai/pi-coding-agent/modes/utils/ui-helpers";
import type { SessionContext } from "@pk-nerdsaver-ai/pi-coding-agent/session/session-context";
import { type Component, Container, type TUI } from "@pk-nerdsaver-ai/pi-tui";

const uiStub = { requestRender() {} } as unknown as TUI;

type JobStatus = "running" | "completed" | "failed" | "cancelled";

function pollResult(statuses: JobStatus[], extra: { cancelled?: boolean; isError?: boolean } = {}) {
	return {
		content: [{ type: "text" as const, text: "" }],
		isError: extra.isError,
		details: {
			jobs: statuses.map((status, i) => ({
				id: `j${i}`,
				type: "task" as const,
				status,
				label: `job ${i}`,
				durationMs: 1_000,
			})),
			...(extra.cancelled ? { cancelled: [{ id: "j0", status: "cancelled" as const }] } : {}),
		},
	};
}

function todoResult(items = ["investigate", "fix"]) {
	return {
		content: [{ type: "text" as const, text: "" }],
		details: {
			phases: [
				{
					name: "Workflow",
					tasks: items.map((content, index) => ({
						content,
						status: index === 0 ? ("in_progress" as const) : ("pending" as const),
					})),
				},
			],
			storage: "memory" as const,
		},
	};
}

function trackComponent(components: ToolExecutionComponent[], component: ToolExecutionComponent) {
	components.push(component);
	return component;
}

describe("job waiting-poll block lifecycle", () => {
	const created: ToolExecutionComponent[] = [];

	beforeEach(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
		await initTheme();
	});

	afterEach(() => {
		// Seal everything so displaceable blocks' spinner intervals never leak
		// into later test files.
		for (const component of created.splice(0)) component.seal();
		vi.restoreAllMocks();
		resetSettingsForTest();
	});

	function makeJobComponent() {
		return trackComponent(created, new ToolExecutionComponent("job", { poll: ["j0", "j1"] }, {}, undefined, uiStub));
	}

	it("keeps an all-running poll live and displaceable until sealed", () => {
		const component = makeJobComponent();
		component.updateResult(pollResult(["running", "running"]), false);

		expect(component.isDisplaceableBlock()).toBe(true);
		expect(component.isTranscriptBlockFinalized()).toBe(false);

		component.seal();
		expect(component.isDisplaceableBlock()).toBe(false);
		expect(component.isTranscriptBlockFinalized()).toBe(true);
	});

	it("finalizes a poll that observed a settled job", () => {
		const component = makeJobComponent();
		component.updateResult(pollResult(["completed", "running"]), false);

		expect(component.isDisplaceableBlock()).toBe(false);
		expect(component.isTranscriptBlockFinalized()).toBe(true);
	});

	it("finalizes a poll that carried cancel outcomes or an error", () => {
		const cancelled = makeJobComponent();
		cancelled.updateResult(pollResult(["running"], { cancelled: true }), false);
		expect(cancelled.isDisplaceableBlock()).toBe(false);

		const errored = makeJobComponent();
		errored.updateResult(pollResult(["running"], { isError: true }), false);
		expect(errored.isDisplaceableBlock()).toBe(false);
		expect(errored.isTranscriptBlockFinalized()).toBe(true);
	});

	it("keeps successful todo snapshots live for replacement", () => {
		const component = trackComponent(
			created,
			new ToolExecutionComponent("todo", { op: "view" }, {}, undefined, uiStub),
		);
		component.updateResult(todoResult(), false);

		expect(component.isDisplaceableBlock()).toBe(true);
		expect(component.isTranscriptBlockFinalized()).toBe(false);

		component.seal();
		expect(component.isDisplaceableBlock()).toBe(false);
		expect(component.isTranscriptBlockFinalized()).toBe(true);
	});

	it("never marks ordinary non-refresh tools displaceable", () => {
		const component = trackComponent(
			created,
			new ToolExecutionComponent("bash", { command: "ls" }, {}, undefined, uiStub),
		);
		component.updateResult(pollResult(["running"]), false);
		expect(component.isDisplaceableBlock()).toBe(false);
	});
});

describe("EventController displaces consecutive waiting polls", () => {
	const created: ToolExecutionComponent[] = [];

	beforeEach(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
		await initTheme();
	});

	afterEach(() => {
		for (const component of created.splice(0)) component.seal();
		vi.restoreAllMocks();
		resetSettingsForTest();
	});

	function createFixture() {
		const children: Component[] = [];
		const pendingTools = new Map();
		const ctx = {
			isInitialized: true,
			init: vi.fn(async () => {}),
			ui: { requestRender: vi.fn() },
			statusLine: { invalidate: vi.fn() },
			updateEditorTopBorder: vi.fn(),
			toolOutputExpanded: false,
			pendingTools,
			chatContainer: {
				children,
				addChild: (component: Component) => {
					children.push(component);
				},
				removeChild: (component: Component) => {
					const index = children.indexOf(component);
					if (index !== -1) children.splice(index, 1);
				},
			},
			session: { getToolByName: () => undefined },
			showWarning: vi.fn(),
			viewSession: { getToolByName: () => undefined },
			sessionManager: { getCwd: () => process.cwd() },
			setTodos: vi.fn(),
		} as unknown as InteractiveModeContext;
		return { controller: new EventController(ctx), children, pendingTools };
	}

	async function runPoll(controller: EventController, children: Component[], toolCallId: string) {
		await controller.handleEvent({
			type: "tool_execution_start",
			toolCallId,
			toolName: "job",
			args: { poll: ["j0"] },
		});
		const component = children[children.length - 1] as ToolExecutionComponent;
		trackComponent(created, component);
		await controller.handleEvent({
			type: "tool_execution_end",
			toolCallId,
			toolName: "job",
			result: pollResult(["running", "running"]),
			isError: false,
		});
		return component;
	}

	async function runTodo(controller: EventController, children: Component[], toolCallId: string, items?: string[]) {
		await controller.handleEvent({
			type: "tool_execution_start",
			toolCallId,
			toolName: "todo",
			args: { op: "view" },
		});
		const component = children[children.length - 1] as ToolExecutionComponent;
		trackComponent(created, component);
		await controller.handleEvent({
			type: "tool_execution_end",
			toolCallId,
			toolName: "todo",
			result: todoResult(items),
			isError: false,
		});
		return component;
	}

	it("removes the previous waiting poll when the next job call starts", async () => {
		const { controller, children } = createFixture();

		const first = await runPoll(controller, children, "t1");
		expect(children).toContain(first);

		const second = await runPoll(controller, children, "t2");

		// The stale "waiting" frame is gone; only the fresh poll remains.
		expect(children).not.toContain(first);
		expect(children).toContain(second);
		// The displaced block is sealed so its spinner interval is stopped.
		expect(first.isTranscriptBlockFinalized()).toBe(true);
	});

	it("seals the waiting poll in place when a different tool runs next", async () => {
		const { controller, children } = createFixture();

		const poll = await runPoll(controller, children, "t1");
		expect(poll.isTranscriptBlockFinalized()).toBe(false);

		await controller.handleEvent({
			type: "tool_execution_start",
			toolCallId: "t2",
			toolName: "bash",
			args: { command: "ls" },
		});
		trackComponent(created, children[children.length - 1] as ToolExecutionComponent);

		// The poll frame stays — it is final history now, not displaceable.
		expect(children).toContain(poll);
		expect(poll.isTranscriptBlockFinalized()).toBe(true);
		expect(poll.isDisplaceableBlock()).toBe(false);
	});

	it("removes the previous todo snapshot when a later todo update lands in the same turn", async () => {
		const { controller, children } = createFixture();

		const first = await runTodo(controller, children, "todo-1", ["plan", "read"]);
		expect(children).toContain(first);
		expect(first.isTranscriptBlockFinalized()).toBe(false);

		await controller.handleEvent({
			type: "tool_execution_start",
			toolCallId: "bash-1",
			toolName: "bash",
			args: { command: "true" },
		});
		const bash = trackComponent(created, children[children.length - 1] as ToolExecutionComponent);
		expect(children).toContain(first);
		expect(children).toContain(bash);

		const second = await runTodo(controller, children, "todo-2", ["fix", "test"]);

		expect(children).not.toContain(first);
		expect(children).toContain(bash);
		expect(children).toContain(second);
		expect(first.isTranscriptBlockFinalized()).toBe(true);
	});

	it("displaces a prior todo snapshot when a streamed second todo lands a successful result", async () => {
		const { controller, children, pendingTools } = createFixture();

		await controller.handleEvent({
			type: "tool_execution_start",
			toolCallId: "todo-1",
			toolName: "todo",
			args: { op: "view" },
		});
		const first = trackComponent(created, children[children.length - 1] as ToolExecutionComponent);

		const second = trackComponent(created, new ToolExecutionComponent("todo", { op: "view" }, {}, undefined, uiStub));
		children.push(second);
		pendingTools.set("todo-2", second);

		await controller.handleEvent({
			type: "tool_execution_end",
			toolCallId: "todo-1",
			toolName: "todo",
			result: todoResult(["plan", "read"]),
			isError: false,
		});
		expect(first.isTranscriptBlockFinalized()).toBe(false);

		await controller.handleEvent({
			type: "tool_execution_start",
			toolCallId: "bash-1",
			toolName: "bash",
			args: { command: "true" },
		});
		const bash = trackComponent(created, children[children.length - 1] as ToolExecutionComponent);
		expect(children).toContain(first);
		expect(children).toContain(second);
		expect(children).toContain(bash);

		await controller.handleEvent({
			type: "tool_execution_start",
			toolCallId: "todo-2",
			toolName: "todo",
			args: { op: "view" },
		});

		// Start alone is no longer enough — the prior snapshot stays so a failed
		// follow-up cannot strand the user without a current todo panel.
		expect(children).toContain(first);
		expect(first.isTranscriptBlockFinalized()).toBe(false);

		await controller.handleEvent({
			type: "tool_execution_end",
			toolCallId: "todo-2",
			toolName: "todo",
			result: todoResult(["fix", "test"]),
			isError: false,
		});

		expect(children).not.toContain(first);
		expect(children).toContain(second);
		expect(children).toContain(bash);
		expect(first.isTranscriptBlockFinalized()).toBe(true);
	});

	it("keeps the prior todo snapshot when a follow-up todo errors", async () => {
		const { controller, children } = createFixture();

		const first = await runTodo(controller, children, "todo-1", ["plan", "read"]);
		expect(children).toContain(first);
		expect(first.isTranscriptBlockFinalized()).toBe(false);

		await controller.handleEvent({
			type: "tool_execution_start",
			toolCallId: "todo-2",
			toolName: "todo",
			args: { op: "view" },
		});
		const errored = trackComponent(created, children[children.length - 1] as ToolExecutionComponent);

		await controller.handleEvent({
			type: "tool_execution_end",
			toolCallId: "todo-2",
			toolName: "todo",
			result: { content: [{ type: "text", text: "Phase missing" }], details: undefined, isError: true },
			isError: true,
		});

		expect(children).toContain(first);
		expect(children).toContain(errored);
		expect(first.isTranscriptBlockFinalized()).toBe(false);
	});

	it("does not displace a poll that observed completions", async () => {
		const { controller, children } = createFixture();

		await controller.handleEvent({
			type: "tool_execution_start",
			toolCallId: "t1",
			toolName: "job",
			args: { poll: ["j0"] },
		});
		const settled = trackComponent(created, children[children.length - 1] as ToolExecutionComponent);
		await controller.handleEvent({
			type: "tool_execution_end",
			toolCallId: "t1",
			toolName: "job",
			result: pollResult(["completed", "running"]),
			isError: false,
		});

		const next = await runPoll(controller, children, "t2");

		// A poll that carried real results is kept as history.
		expect(children).toContain(settled);
		expect(children).toContain(next);
	});
});

describe("UiHelpers.renderSessionContext collapses repeated todo snapshots", () => {
	beforeAll(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
		await initTheme();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("removes the earlier todo snapshot when an assistant message replays two todo calls", () => {
		const chatContainer = new Container();
		let helpers!: UiHelpers;
		const ctx = {
			chatContainer,
			pendingTools: new Map(),
			ui: { requestRender: vi.fn() },
			statusLine: { invalidate: vi.fn() },
			updateEditorBorderColor: vi.fn(),
			settings: { get: () => false },
			addMessageToChat: (message: AgentMessage) => helpers.addMessageToChat(message),
			session: {
				retryAttempt: 0,
				getToolByName: () => undefined,
				sessionManager: { getCwd: () => process.cwd() },
			},
			get viewSession() {
				return (this as { session: unknown }).session;
			},
			toolOutputExpanded: false,
			hideThinkingBlock: false,
			lastAssistantUsage: undefined,
			clearTransientSessionUi: () => {},
		} as unknown as InteractiveModeContext;
		helpers = new UiHelpers(ctx);

		const usage = {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		const assistant = {
			role: "assistant",
			content: [
				{ type: "toolCall", id: "todo-1", name: "todo", arguments: { op: "view" } },
				{ type: "toolCall", id: "todo-2", name: "todo", arguments: { op: "view" } },
			],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			stopReason: "stop",
			usage,
			timestamp: Date.now(),
		} as unknown as AgentMessage;
		const firstResult = {
			role: "toolResult",
			toolCallId: "todo-1",
			toolName: "todo",
			content: [{ type: "text", text: "" }],
			details: todoResult(["plan", "read"]).details,
			timestamp: Date.now(),
		} as unknown as AgentMessage;
		const secondResult = {
			role: "toolResult",
			toolCallId: "todo-2",
			toolName: "todo",
			content: [{ type: "text", text: "" }],
			details: todoResult(["fix", "test"]).details,
			timestamp: Date.now(),
		} as unknown as AgentMessage;

		helpers.renderSessionContext({ messages: [assistant, firstResult, secondResult] } as SessionContext);

		const todos = chatContainer.children.filter(
			(child): child is ToolExecutionComponent => child instanceof ToolExecutionComponent,
		);
		// Only the latest todo snapshot survives the rebuild; the trailing one is
		// sealed as final history by the end-of-rebuild flush.
		expect(todos).toHaveLength(1);
		expect(todos[0].isTranscriptBlockFinalized()).toBe(true);
	});

	it("hands the trailing todo snapshot to the controller during mid-turn rebuild", () => {
		const chatContainer = new Container();
		const inheritDisplaceableTodo = vi.fn();
		let helpers!: UiHelpers;
		const ctx = {
			chatContainer,
			pendingTools: new Map(),
			ui: { requestRender: vi.fn() },
			statusLine: { invalidate: vi.fn() },
			updateEditorBorderColor: vi.fn(),
			settings: { get: () => false },
			addMessageToChat: (message: AgentMessage) => helpers.addMessageToChat(message),
			session: {
				retryAttempt: 0,
				getToolByName: () => undefined,
				sessionManager: { getCwd: () => process.cwd() },
				isStreaming: true,
			},
			get viewSession() {
				return (this as { session: unknown }).session;
			},
			eventController: { inheritDisplaceableTodo },
			toolOutputExpanded: false,
			hideThinkingBlock: false,
			lastAssistantUsage: undefined,
			clearTransientSessionUi: () => {},
		} as unknown as InteractiveModeContext;
		helpers = new UiHelpers(ctx);

		const usage = {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		const assistant = {
			role: "assistant",
			content: [{ type: "toolCall", id: "todo-1", name: "todo", arguments: { op: "view" } }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			stopReason: "stop",
			usage,
			timestamp: Date.now(),
		} as unknown as AgentMessage;
		const result = {
			role: "toolResult",
			toolCallId: "todo-1",
			toolName: "todo",
			content: [{ type: "text", text: "" }],
			details: todoResult(["plan", "read"]).details,
			timestamp: Date.now(),
		} as unknown as AgentMessage;

		helpers.renderSessionContext({ messages: [assistant, result] } as SessionContext);

		const todos = chatContainer.children.filter(
			(child): child is ToolExecutionComponent => child instanceof ToolExecutionComponent,
		);
		expect(todos).toHaveLength(1);
		// Mid-turn rebuild hands the live tail back to the controller — the
		// snapshot stays displaceable so a follow-up `todo` event replaces it
		// instead of stacking another panel.
		expect(inheritDisplaceableTodo).toHaveBeenCalledTimes(1);
		expect(inheritDisplaceableTodo).toHaveBeenCalledWith(todos[0]);
		expect(todos[0].canBeDisplacedBy("todo")).toBe(true);
		expect(todos[0].isTranscriptBlockFinalized()).toBe(false);
	});
});
