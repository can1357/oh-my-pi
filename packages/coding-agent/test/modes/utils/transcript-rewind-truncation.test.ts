/**
 * History rewinds (esc-esc branch, /tree navigation to an ancestor) drop the
 * rendered transcript tail in place. Covers the fast-path gates
 * in UiHelpers.truncateTranscriptFromMessage.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { PendingTool } from "@oh-my-pi/pi-coding-agent/modes/types";
import { UiHelpers } from "@oh-my-pi/pi-coding-agent/modes/utils/ui-helpers";
import type { SessionContext } from "@oh-my-pi/pi-coding-agent/session/session-context";
import { createInteractiveModeContext } from "../../helpers/interactive-mode-context";
import { currentTheme, setCurrentTheme } from "@oh-my-pi/pi-tui/theme/runtime";

const restoreTheme = currentTheme();
afterAll(() => setCurrentTheme(restoreTheme));

beforeEach(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
});

afterEach(() => {
	resetSettingsForTest();
});

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

/** Transcript user1, assistant1, user2, assistant2; the session was rewound to before user2. */
function createHarness() {
	const user1 = userMessage("first question");
	const assistant1 = assistantMessage("first answer", 42);
	const user2 = userMessage("second question");
	const assistant2 = assistantMessage("second answer", 99);
	// Messages the view session reports AFTER the rewind.
	const remainingMessages: AgentMessage[] = [user1, assistant1];
	const ctx = createInteractiveModeContext({
		session: {
			buildTranscriptSessionContext: () => ({ messages: remainingMessages }) as unknown as SessionContext,
		},
	});
	const session = ctx.viewSession as { isStreaming: boolean };
	Object.defineProperty(session, "isStreaming", { value: false, writable: true, configurable: true });
	for (const message of [user1, assistant1, user2, assistant2]) {
		const block = message.role === "assistant" ? ctx.presentAssistant(message).block : ctx.presentMessage(message);
		if (block) ctx.transcriptBlocks.set(message, block);
	}
	return { ctx, session, messages: { user1, assistant1, user2, assistant2 }, helpers: new UiHelpers(ctx) };
}

describe("UiHelpers.truncateTranscriptFromMessage", () => {
	it("falls back while the view session is streaming or has in-flight tools", () => {
		const streaming = createHarness();
		streaming.session.isStreaming = true;
		expect(streaming.helpers.truncateTranscriptFromMessage(streaming.messages.user2)).toBe(false);

		const pending = createHarness();
		pending.ctx.pendingTools.set("call-1", {} as PendingTool);
		expect(pending.helpers.truncateTranscriptFromMessage(pending.messages.user2)).toBe(false);
		expect(pending.ctx.shell.transcript.blocks()).toHaveLength(4);
	});

	it("drops the rewound tail in place and reseeds the usage baseline from the survivors", () => {
		const { ctx, helpers, messages } = createHarness();
		expect(helpers.truncateTranscriptFromMessage(messages.user2)).toBe(true);
		const blocks = ctx.shell.transcript.blocks();
		expect(blocks).toHaveLength(2);
		expect(blocks).toContain(ctx.transcriptBlocks.get(messages.assistant1)!);
		expect(ctx.lastAssistantUsage?.input).toBe(42);
	});

	it("falls back when the session still holds the cut message", () => {
		const { helpers, messages } = createHarness();
		expect(helpers.truncateTranscriptFromMessage(messages.user1)).toBe(false);
	});
});
