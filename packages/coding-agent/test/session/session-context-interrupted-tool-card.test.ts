/**
 * A v4-journaled dangling toolCall renders as a real interrupted
 * tool card through `renderSessionContext`, not the "N tool calls elided"
 * placeholder — end to end through real `SessionManager` production code and
 * the real `UiHelpers.renderSessionContext` render path (not just the
 * `session-context.ts` marker shape unit tests in
 * `test/session/session-context.test.ts`).
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { toolExecutionId } from "@oh-my-pi/pi-agent-core/presentation";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ToolExecutionComponent } from "@oh-my-pi/pi-coding-agent/modes/components/tool-execution";
import { TranscriptContainer } from "@oh-my-pi/pi-coding-agent/modes/components/transcript-container";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { UiHelpers } from "@oh-my-pi/pi-coding-agent/modes/utils/ui-helpers";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";

const BASH_COMMAND_MARKER = "echo SCTX_CARD_MARKER_9F3Q";

function createFixture() {
	const chatContainer = new TranscriptContainer();
	const sessionManager = SessionManager.inMemory("/repo");
	let helpers!: UiHelpers;
	const ctx = {
		chatContainer,
		transcriptMessageComponents: new WeakMap(),
		pendingTools: new Map(),
		ui: { requestRender: vi.fn() },
		settings: { get: () => false },
		toolOutputExpanded: false,
		hideThinkingBlock: false,
		lastAssistantUsage: undefined,
		viewSession: {
			retryAttempt: 0,
			getToolByName: () => undefined,
			sessionManager,
			isStreaming: false,
		},
		showWarning: vi.fn(),
		setTodos: vi.fn(),
		addMessageToChat: (message: Parameters<UiHelpers["addMessageToChat"]>[0]) => helpers.addMessageToChat(message),
	} as unknown as InteractiveModeContext;
	helpers = new UiHelpers(ctx);
	return { sessionManager, helpers, chatContainer };
}

function toolExecutionComponents(chatContainer: TranscriptContainer): ToolExecutionComponent[] {
	return chatContainer.children.filter(
		(child): child is ToolExecutionComponent => child instanceof ToolExecutionComponent,
	);
}

describe("renderSessionContext renders a v4-journaled dangling toolCall as an interrupted card", () => {
	beforeAll(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
		await initTheme();
	});

	afterEach(() => {
		resetSettingsForTest();
		vi.restoreAllMocks();
	});

	it("renders the journaled title/command and the interruption reason instead of an elision placeholder", () => {
		const { sessionManager, helpers, chatContainer } = createFixture();

		sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: BASH_COMMAND_MARKER } }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: 2,
		});
		sessionManager.appendToolExecutionStarted({
			recordVersion: 1,
			executionId: toolExecutionId("exec-SCTX-CARD-0001"),
			call: {
				toolCallId: "call-1",
				toolName: "bash",
				title: "Run SCTX_CARD_MARKER_9F3Q",
				kind: "execute",
				rawInput: { command: BASH_COMMAND_MARKER },
			},
			presentation: { version: 1, facts: [] },
		});

		const context = sessionManager.buildSessionContext({ transcript: true });
		helpers.renderSessionContext(context);

		const rendered = Bun.stripANSI(chatContainer.render(120).join("\n"));
		expect(rendered).not.toContain("elided");
		expect(rendered).toContain(BASH_COMMAND_MARKER);
		expect(rendered).toContain("Interrupted");
		const [component] = toolExecutionComponents(chatContainer);
		expect(component).toBeDefined();
		expect(component?.isTranscriptBlockFinalized()).toBe(true);
	});

	it("still renders the plain elision placeholder for a pre-v4/legacy_snapshot dangling call", () => {
		const { sessionManager, helpers, chatContainer } = createFixture();

		sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: BASH_COMMAND_MARKER } }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: 2,
		});
		// No journal entry at all — the universal legacy case.

		const context = sessionManager.buildSessionContext({ transcript: true });
		helpers.renderSessionContext(context);

		const rendered = Bun.stripANSI(chatContainer.render(120).join("\n"));
		expect(rendered).toContain("1 tool call elided — no result on this branch");
		expect(rendered).not.toContain(BASH_COMMAND_MARKER);
		expect(toolExecutionComponents(chatContainer)).toHaveLength(0);
	});
});
