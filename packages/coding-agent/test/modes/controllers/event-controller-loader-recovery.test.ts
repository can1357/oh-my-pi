import { afterEach, beforeAll, beforeEach, describe, expect, it, type Mock, vi } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";

interface FakeWorkingLoader {
	stop: Mock<() => void>;
	kind: "working";
}

/**
 * Faithful model of the shared `statusContainer` + working-loader invariant that
 * InteractiveMode owns:
 *  - `agent_start` → `ensureLoadingAnimation()` only creates+attaches the loader
 *    when `loadingAnimation` is unset (the real `if (!this.loadingAnimation)`
 *    guard), so a stale, still-referenced loader makes it a no-op.
 *  - A transient overlay (auto-compaction / auto-retry) takes over the container.
 *
 * The regression: the overlay handlers cleared the container (detaching the
 * working loader) but left `loadingAnimation` set, so the resumed turn's
 * `agent_start` skipped re-attaching it — "Working…" vanished while the agent
 * kept streaming. The fix tears the working loader down (stop + dereference) so
 * the next `agent_start` recreates and re-attaches it.
 */
function createContext(options: { terminalProgress?: boolean } = {}) {
	const streamState = { isStreaming: false };
	const children: unknown[] = [];
	const statusContainer = {
		children,
		clear() {
			children.length = 0;
		},
		disposeChildren() {
			children.length = 0;
		},
		addChild(child: unknown) {
			children.push(child);
		},
		removeChild(child: unknown) {
			const index = children.indexOf(child);
			if (index !== -1) children.splice(index, 1);
		},
	};
	const workingLoaders: FakeWorkingLoader[] = [];
	const setProgress = vi.fn();
	const ctx = {
		isInitialized: true,
		settings: {
			get: (path: string) => path === "terminal.showProgress" && options.terminalProgress === true,
		},
		statusLine: { invalidate: vi.fn(), markActivityStart: vi.fn(), markActivityEnd: vi.fn() },
		updateEditorTopBorder: vi.fn(),
		flushPendingCommandOutput: vi.fn(),
		syncRetryHintRow: vi.fn(),
		transcriptMessageComponents: new WeakMap(),
		pendingTools: new Map<string, unknown>(),
		hideThinkingBlock: false,
		setWorkingMessage: vi.fn(),
		clearPinnedError: vi.fn(),
		loadingAnimation: undefined,
		autoCompactionLoader: undefined,
		retryLoader: undefined,
		streamingComponent: undefined,
		streamingMessage: undefined,
		statusContainer,
		chatContainer: { removeChild: vi.fn(), clear: vi.fn() },
		flushPendingModelSwitch: vi.fn(async () => {}),
		flushCompactionQueue: vi.fn(async () => {}),
		rebuildChatFromMessages: vi.fn(),
		reloadTodos: vi.fn(async () => {}),
		showStatus: vi.fn(),
		showWarning: vi.fn(),
		showError: vi.fn(),
		editor: { getText: () => "" },
		sessionManager: { getSessionName: () => "test-session" },
		ui: { requestRender: vi.fn(), requestComponentRender: vi.fn(), terminal: { setProgress } },
		viewSession: {
			isCompacting: false,
			getLastAssistantMessage: () => undefined,
			get isStreaming() {
				return streamState.isStreaming;
			},
		},
		session: {
			get isStreaming() {
				return streamState.isStreaming;
			},
			getToolByName: () => undefined,
		},
	} as unknown as InteractiveModeContext;
	ctx.ensureLoadingAnimation = vi.fn(() => {
		if (ctx.loadingAnimation) return;
		statusContainer.clear();
		const working: FakeWorkingLoader = { stop: vi.fn(), kind: "working" };
		workingLoaders.push(working);
		ctx.loadingAnimation = working as unknown as typeof ctx.loadingAnimation;
		statusContainer.addChild(ctx.loadingAnimation);
	});
	return { ctx, streamState, statusContainer, workingLoaders, setProgress };
}

const AGENT_START = { type: "agent_start" } as unknown as AgentSessionEvent;
const AGENT_END = { type: "agent_end", messages: [] } as unknown as AgentSessionEvent;
const COMPACTION_START = {
	type: "auto_compaction_start",
	reason: "overflow",
	action: "context-full",
} as unknown as AgentSessionEvent;
const COMPACTION_END = {
	type: "auto_compaction_end",
	action: "context-full",
	result: { summary: "s", shortSummary: "s", tokensBefore: 10, details: {}, firstKeptEntryId: undefined },
	willRetry: true,
} as unknown as AgentSessionEvent;
const RETRY_START = {
	type: "auto_retry_start",
	attempt: 1,
	maxAttempts: 3,
	delayMs: 1000,
	errorMessage: "overloaded",
} as unknown as AgentSessionEvent;
const TASK_TOOL_EXECUTION_END = {
	type: "tool_execution_end",
	toolCallId: "call-task-1",
	toolName: "task",
	args: {},
	result: { content: [], details: {} },
	isError: false,
} as unknown as AgentSessionEvent;

describe("EventController loader recovery after overflow maintenance", () => {
	beforeAll(async () => {
		await initTheme(false);
	});

	beforeEach(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		resetSettingsForTest();
	});

	it("re-shows the Working… loader after auto-compaction recovers and streams a new turn", async () => {
		const { ctx, streamState, statusContainer, workingLoaders } = createContext();
		const controller = new EventController(ctx);

		// Turn 1 begins: the working loader is created and attached.
		await controller.handleEvent(AGENT_START);
		const firstWorking = workingLoaders[0];
		expect(firstWorking).toBeDefined();
		expect(statusContainer.children).toContain(ctx.loadingAnimation);

		// Overflow recovery hands the status container to the auto-compaction loader.
		// The original turn's agent_end is held while the prompt is in flight, so the
		// session keeps reporting streaming throughout.
		streamState.isStreaming = true;
		await controller.handleEvent(COMPACTION_START);

		// The working loader must be fully torn down — not detached-but-referenced —
		// so the upcoming agent_start can recreate it.
		expect(firstWorking?.stop).toHaveBeenCalled();
		expect(ctx.loadingAnimation).toBeUndefined();
		expect(statusContainer.children).not.toContain(firstWorking);

		await controller.handleEvent(COMPACTION_END);

		// The retry continuation starts a fresh turn: the loader must reappear in the
		// status container so streaming shows "Working…" again (issue: it stayed gone).
		await controller.handleEvent(AGENT_START);
		expect(ctx.loadingAnimation).toBeDefined();
		expect(statusContainer.children).toContain(ctx.loadingAnimation);
		expect(workingLoaders).toHaveLength(2);
	});

	it("re-shows the Working… loader after an auto-retry resumes the turn", async () => {
		const { ctx, streamState, statusContainer, workingLoaders } = createContext();
		const controller = new EventController(ctx);

		await controller.handleEvent(AGENT_START);
		const firstWorking = workingLoaders[0];
		expect(statusContainer.children).toContain(ctx.loadingAnimation);

		// A transient error: the retry loader takes over the status container.
		streamState.isStreaming = true;
		await controller.handleEvent(RETRY_START);
		expect(firstWorking?.stop).toHaveBeenCalled();
		expect(ctx.loadingAnimation).toBeUndefined();

		// The retry attempt re-enters the agent loop, emitting a fresh agent_start.
		await controller.handleEvent(AGENT_START);
		expect(ctx.loadingAnimation).toBeDefined();
		expect(statusContainer.children).toContain(ctx.loadingAnimation);
	});

	it("ticks the auto-retry countdown down on spinner ticks instead of freezing", async () => {
		const { ctx, streamState } = createContext();
		const controller = new EventController(ctx);
		const visible = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

		streamState.isStreaming = true;
		await controller.handleEvent(RETRY_START);
		expect(ctx.retryLoader).toBeDefined();

		// Initial paint shows the full delay: RETRY_START carries delayMs 1000.
		const first = visible(ctx.retryLoader!.render(80).join("\n"));
		expect(first).toContain("Retrying (1/3) in 1.0s");

		// 400ms of spinner ticks re-evaluate the closure: 600ms remain. A
		// static label (the pre-fix banner) would still read "1.0s" here.
		vi.advanceTimersByTime(400);
		const second = visible(ctx.retryLoader!.render(80).join("\n"));
		expect(second).toContain("in 600ms");
		expect(second).not.toContain("in 1.0s");

		// Past the deadline the remaining wait clamps at zero.
		vi.advanceTimersByTime(2_000);
		const third = visible(ctx.retryLoader!.render(80).join("\n"));
		expect(third).toContain("in 0ms");

		ctx.retryLoader!.stop();
	});

	it("re-shows the Working… loader after a subagent task completes while the session keeps streaming", async () => {
		const { ctx, streamState, statusContainer, workingLoaders } = createContext();
		const controller = new EventController(ctx);

		// Turn begins: the working loader is created and attached.
		await controller.handleEvent(AGENT_START);
		const firstWorking = workingLoaders[0];
		expect(firstWorking).toBeDefined();

		// A transient overlay (auto-retry / auto-compaction) tore the loader down
		// mid-tool; the session is still streaming when the subagent's task
		// completes. Before the fix, `tool_execution_end` (unlike `_update`) did
		// not re-arm the loader, so the UI looked idle while the agent kept going.
		streamState.isStreaming = true;
		ctx.loadingAnimation?.stop();
		ctx.loadingAnimation = undefined;
		statusContainer.clear();

		await controller.handleEvent(TASK_TOOL_EXECUTION_END);

		expect(ctx.loadingAnimation).toBeDefined();
		expect(statusContainer.children).toContain(ctx.loadingAnimation);
		expect(workingLoaders).toHaveLength(2);
	});

	it("does not re-arm the Working… loader on tool_execution_end once the session has stopped streaming", async () => {
		const { ctx, streamState, statusContainer } = createContext();
		const controller = new EventController(ctx);

		await controller.handleEvent(AGENT_START);
		ctx.loadingAnimation?.stop();
		ctx.loadingAnimation = undefined;
		statusContainer.clear();
		streamState.isStreaming = false;

		await controller.handleEvent(TASK_TOOL_EXECUTION_END);

		// No streaming → reconciler must stay a no-op; the spinner is not the
		// post-turn idle state.
		expect(ctx.loadingAnimation).toBeUndefined();
		expect(statusContainer.children).toHaveLength(0);
	});

	it("mirrors agent and auto-compaction activity to OSC 9;4 when enabled", async () => {
		const { ctx, setProgress } = createContext({ terminalProgress: true });
		const controller = new EventController(ctx);

		await controller.handleEvent(AGENT_START);
		expect(setProgress).toHaveBeenCalledTimes(1);
		expect(setProgress).toHaveBeenLastCalledWith(true);

		await controller.handleEvent(COMPACTION_START);
		expect(setProgress).toHaveBeenCalledTimes(1);

		await controller.handleEvent(COMPACTION_END);
		expect(setProgress).toHaveBeenCalledTimes(2);
		expect(setProgress).toHaveBeenLastCalledWith(false);

		await controller.handleEvent(AGENT_START);
		await controller.handleEvent(AGENT_END);
		expect(setProgress.mock.calls.map(call => call[0])).toEqual([true, false, true, false]);
	});
});
