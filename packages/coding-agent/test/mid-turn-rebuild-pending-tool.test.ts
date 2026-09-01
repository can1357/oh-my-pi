/**
 * A transcript rebuild while a tool is still executing (subagent focus
 * attach/unfocus, overlay close) must not hide the in-flight call: the
 * assistant turn is persisted at message_end but its toolResult is not, so a
 * rebuild used to strip the dangling toolCall and the agent looked idle while
 * still waiting on the tool.
 *
 * Contracts under test:
 *  - renderSessionContext renders a dangling toolCall as a pending block and,
 *    while the viewed session streams, keeps it tracked in `pendingTools` so
 *    the live event stream lands the result in the SAME component.
 *  - Idle rebuilds seal leftover danglers instead of pinning the transcript
 *    live region with a spinner that can never resolve.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ToolExecutionComponent } from "@oh-my-pi/pi-coding-agent/modes/components/tool-execution";
import { TranscriptContainer } from "@oh-my-pi/pi-coding-agent/modes/components/transcript-container";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { UiHelpers } from "@oh-my-pi/pi-coding-agent/modes/utils/ui-helpers";
import type { SessionContext } from "@oh-my-pi/pi-coding-agent/session/session-context";

const usage = {
	input: 1,
	output: 1,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 2,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/** Assistant turn persisted mid-execution: toolCall present, no toolResult. */
const danglingAssistant = {
	role: "assistant",
	content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "sleep 60" } }],
	api: "anthropic-messages",
	provider: "anthropic",
	model: "claude-sonnet-4-5",
	stopReason: "toolUse",
	usage,
	timestamp: Date.now(),
} as unknown as AgentMessage;

function createFixture(opts: { isStreaming: boolean }) {
	const chatContainer = new TranscriptContainer();
	const session = {
		retryAttempt: 0,
		getToolByName: () => undefined,
		hasBuiltInTool: () => true,
		sessionManager: { getCwd: () => process.cwd() },
		isStreaming: opts.isStreaming,
	};
	const ctx = {
		isInitialized: true,
		init: vi.fn(async () => {}),
		chatContainer,
		transcriptMessageComponents: new WeakMap(),
		pendingTools: new Map(),
		ui: { requestRender: vi.fn() },
		statusLine: { invalidate: vi.fn() },
		updateEditorBorderColor: vi.fn(),
		settings: { get: () => false },
		addMessageToChat: (message: AgentMessage) => helpers.addMessageToChat(message),
		session,
		viewSession: session,
		toolOutputExpanded: false,
		hideThinkingBlock: false,
		lastAssistantUsage: undefined,
		clearTransientSessionUi: () => {},
		ensureLoadingAnimation: vi.fn(),
		loadingAnimation: undefined,
		autoCompactionLoader: undefined,
		retryLoader: undefined,
		setTodos: vi.fn(),
		showWarning: vi.fn(),
	} as unknown as InteractiveModeContext;
	const helpers = new UiHelpers(ctx);
	return { ctx, helpers, chatContainer };
}

function pendingComponents(chatContainer: TranscriptContainer): ToolExecutionComponent[] {
	return chatContainer.children.filter(
		(child): child is ToolExecutionComponent => child instanceof ToolExecutionComponent,
	);
}

describe("mid-turn transcript rebuild keeps in-flight tool calls", () => {
	const created: ToolExecutionComponent[] = [];

	beforeAll(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
		await initTheme();
	});

	afterEach(() => {
		for (const component of created.splice(0)) component.seal();
		vi.restoreAllMocks();
	});

	it("renders a dangling toolCall as pending, tracks it, and routes the live result into it", async () => {
		const { ctx, helpers, chatContainer } = createFixture({ isStreaming: true });

		helpers.renderSessionContext({ messages: [danglingAssistant] } as SessionContext);

		const [component] = pendingComponents(chatContainer);
		expect(component).toBeDefined();
		created.push(component);
		// Still awaiting its result: the block stays in the live region and the
		// map keeps routing events into it after the rebuild.
		expect(component.isTranscriptBlockFinalized()).toBe(false);
		expect(ctx.pendingTools.get("call-1")).toBe(component);

		// The tool finishes after the rebuild: the result must land in the same
		// rebuilt component instead of being dropped.
		const controller = new EventController(ctx);
		await controller.handleEvent({
			type: "tool_execution_end",
			toolCallId: "call-1",
			toolName: "bash",
			result: { content: [{ type: "text", text: "done" }], details: {} },
			isError: false,
		});

		expect(component.isTranscriptBlockFinalized()).toBe(true);
		expect(ctx.pendingTools.size).toBe(0);
	});

	it("seals dangling toolCalls on idle rebuilds instead of leaving a live spinner", () => {
		const { ctx, helpers, chatContainer } = createFixture({ isStreaming: false });

		helpers.renderSessionContext({ messages: [danglingAssistant] } as SessionContext);

		const [component] = pendingComponents(chatContainer);
		expect(component).toBeDefined();
		created.push(component);
		// No result is coming: the block freezes as history and live tracking
		// stays empty so historical components never receive live events.
		expect(component.isTranscriptBlockFinalized()).toBe(true);
		expect(ctx.pendingTools.size).toBe(0);
	});
});
