/**
 * History rewinds (esc-esc branch, /tree navigation to an ancestor) drop the
 * rendered transcript tail in place. Covers the fast-path gates
 * in UiHelpers.truncateTranscriptFromMessage.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { TranscriptContainer } from "@oh-my-pi/pi-coding-agent/modes/components/transcript-container";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { UiHelpers } from "@oh-my-pi/pi-coding-agent/modes/utils/ui-helpers";
import type { Component } from "@oh-my-pi/pi-tui";

beforeEach(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
});

afterEach(() => {
	resetSettingsForTest();
});

class Block implements Component {
	disposed = false;
	constructor(private line: string) {}
	invalidate(): void {}
	render(_width: number): string[] {
		return [this.line];
	}
	dispose(): void {
		this.disposed = true;
	}
}

function userMessage(text: string): AgentMessage {
	return {
		role: "user",
		content: [{ type: "text", text }],
		timestamp: Date.now(),
	} as AgentMessage;
}

function assistantMessage(text: string, input: number): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		usage: { input, output: 1, cacheRead: 0, cacheWrite: 0 },
		timestamp: Date.now(),
	} as unknown as AssistantMessage;
}

/**
 * Rendered transcript: user1, assistant1, user2, assistant2 — one row each,
 * separated by blank rows (rows 0..6). The rewind boundary is user2 (row 4).
 */
function createHarness() {
	const user1 = userMessage("first question");
	const assistant1 = assistantMessage("first answer", 42);
	const user2 = userMessage("second question");
	const assistant2 = assistantMessage("second answer", 99);

	const chat = new TranscriptContainer();
	const blocks = [new Block("user-1"), new Block("assistant-1"), new Block("user-2"), new Block("assistant-2")];
	for (const block of blocks) chat.addChild(block);

	const transcriptMessageComponents = new WeakMap<AgentMessage, Component>();
	transcriptMessageComponents.set(user1, blocks[0]!);
	transcriptMessageComponents.set(assistant1, blocks[1]!);
	transcriptMessageComponents.set(user2, blocks[2]!);
	transcriptMessageComponents.set(assistant2, blocks[3]!);

	// Messages the view session reports AFTER the rewind; tests mutate this to
	// model a session that was (or was not) actually rewound.
	const remainingMessages: AgentMessage[] = [user1, assistant1];
	const viewSession = {
		isStreaming: false,
		buildTranscriptSessionContext: () => ({ messages: remainingMessages }),
	};

	const ctx = {
		initialChatRendered: true,
		focusedAgentId: undefined,
		viewSession,
		pendingTools: new Map<string, unknown>(),
		pendingBashComponents: [],
		pendingPythonComponents: [],
		chatContainer: chat,
		transcriptMessageComponents,
		lastAssistantUsage: undefined,
		statusLine: { invalidate: vi.fn() },
		updateEditorBorderColor: vi.fn(),
		ui: { requestRender: vi.fn() },
	} as unknown as InteractiveModeContext;

	return {
		ctx,
		chat,
		blocks,
		remainingMessages,
		viewSession,
		messages: { user1, assistant1, user2, assistant2 },
		helpers: new UiHelpers(ctx),
	};
}

describe("UiHelpers.truncateTranscriptFromMessage", () => {
	it("falls back while the view session is streaming or has in-flight tools", () => {
		const streaming = createHarness();
		streaming.viewSession.isStreaming = true;
		expect(streaming.helpers.truncateTranscriptFromMessage(streaming.messages.user2)).toBe(false);

		const pending = createHarness();
		pending.ctx.pendingTools.set("call-1", {} as never);
		expect(pending.helpers.truncateTranscriptFromMessage(pending.messages.user2)).toBe(false);
		expect(pending.chat.children).toHaveLength(4);
	});
});
