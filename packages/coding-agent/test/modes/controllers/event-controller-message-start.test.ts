import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import type { TextContent, UserMessage } from "@oh-my-pi/pi-ai";
import { TranscriptContainer } from "@oh-my-pi/pi-coding-agent/modes/components/transcript-container";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { UiHelpers } from "@oh-my-pi/pi-coding-agent/modes/utils/ui-helpers";
import type { CustomMessage } from "@oh-my-pi/pi-coding-agent/session/messages";
import type { Component } from "@oh-my-pi/pi-tui";

beforeAll(() => {
	initTheme();
});

function createUserMessage(text: string): UserMessage {
	return {
		role: "user",
		content: [{ type: "text", text }],
		attribution: "user",
		timestamp: Date.now(),
	};
}

function createContext(options: {
	editorText: string;
	optimisticSignature?: string;
	locallySubmittedSignatures?: string[];
}) {
	let currentEditorText = options.editorText;
	const setText = vi.fn((text: string) => {
		currentEditorText = text;
	});
	const editor = {
		setText,
		getText: () => currentEditorText,
	};
	const addMessageToChat = vi.fn();
	const updatePendingMessagesDisplay = vi.fn();
	const clearOptimisticUserMessage = vi.fn(() => {
		ctx.optimisticUserMessageSignature = undefined;
	});
	const replaceOptimisticUserMessage = vi.fn(() => {
		ctx.optimisticUserMessageSignature = undefined;
	});
	const ctx = {
		isInitialized: true,
		statusLine: { invalidate: vi.fn() },
		updateEditorTopBorder: vi.fn(),
		ui: { requestRender: vi.fn() },
		editor,
		addMessageToChat,
		updatePendingMessagesDisplay,
		getUserMessageText: (message: UserMessage) =>
			typeof message.content === "string"
				? message.content
				: message.content
						.filter((c): c is TextContent => c.type === "text")
						.map(c => c.text)
						.join(""),
		optimisticUserMessageSignature: options.optimisticSignature,
		locallySubmittedUserSignatures: new Set<string>(options.locallySubmittedSignatures ?? []),
		clearOptimisticUserMessage,
		replaceOptimisticUserMessage,
		transcriptMessageComponents: new WeakMap(),
		pendingTools: new Map(),
		viewSession: { isStreaming: false },
	} as unknown as InteractiveModeContext;
	return {
		ctx,
		editor,
		setText,
		addMessageToChat,
		updatePendingMessagesDisplay,
		clearOptimisticUserMessage,
		replaceOptimisticUserMessage,
	};
}

describe("EventController message_start (user role)", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("preserves an in-progress editor draft when delivering a queued submission", async () => {
		// Reproduces the bug: user sends a message during streaming (queued) and then
		// types a follow-up draft. When the queue drains and message_start fires,
		// the editor MUST keep the draft.
		const message = createUserMessage("queued during streaming");
		const signature = "queued during streaming\u00000";
		const { ctx, editor, setText, addMessageToChat, updatePendingMessagesDisplay } = createContext({
			editorText: "draft typed after queuing",
			locallySubmittedSignatures: [signature],
		});
		const controller = new EventController(ctx);

		await controller.handleEvent({ type: "message_start", message });

		expect(setText).not.toHaveBeenCalled();
		expect(editor.getText()).toBe("draft typed after queuing");
		// Queued message was not optimistically rendered, so it must still land in chat.
		expect(addMessageToChat).toHaveBeenCalledWith(message);
		// Pending list always refreshes so the dequeued entry disappears.
		expect(updatePendingMessagesDisplay).toHaveBeenCalledTimes(1);
		// Signature is consumed so a future external message with the same shape still clears.
		expect(ctx.locallySubmittedUserSignatures.has(signature)).toBe(false);
	});

	it("clears the editor for user messages that did not originate from this session", async () => {
		// Counter-case: an external/programmatic user message must still trigger the
		// defensive editor reset so the next prompt starts clean.
		const message = createUserMessage("external prompt");
		const { ctx, setText, addMessageToChat } = createContext({
			editorText: "stale text",
		});
		const controller = new EventController(ctx);

		await controller.handleEvent({ type: "message_start", message });

		expect(setText).toHaveBeenCalledWith("");
		expect(addMessageToChat).toHaveBeenCalledWith(message);
	});

	it("preserves the editor for an optimistic submission and skips the duplicate chat add", async () => {
		// Optimistic path already added the user message to chat and cleared the
		// editor at submit time. message_start must not re-add or re-clear.
		const message = createUserMessage("optimistic send");
		const signature = "optimistic send\u00000";
		const { ctx, setText, addMessageToChat } = createContext({
			editorText: "",
			optimisticSignature: signature,
			locallySubmittedSignatures: [signature],
		});
		const controller = new EventController(ctx);

		await controller.handleEvent({ type: "message_start", message });

		expect(addMessageToChat).not.toHaveBeenCalled();
		expect(setText).not.toHaveBeenCalled();
		expect(ctx.optimisticUserMessageSignature).toBeUndefined();
	});

	it("appends a queued image submission synchronously so later events cannot reorder it", async () => {
		// Regression (da636e3f5): AgentSession.#emit dispatches listeners fire-and-forget,
		// so an await between the user message_start and addMessageToChat lets the next
		// synchronously-handled events (assistant message_start, tool execution start/end)
		// append their components first — dropping the user bubble *below* the very tool
		// output it was sent to steer. The append must happen before the handler settles.
		const message: UserMessage = {
			role: "user",
			content: [
				{ type: "text", text: "steer mid-stream" },
				{ type: "image", data: "AAAA", mimeType: "image/png" },
			],
			attribution: "user",
			timestamp: Date.now(),
		};
		const signature = "steer mid-stream\u00001";
		const { ctx, addMessageToChat } = createContext({
			editorText: "",
			locallySubmittedSignatures: [signature],
		});
		const controller = new EventController(ctx);

		// Fire WITHOUT awaiting: the bubble must already be appended synchronously.
		const pending = controller.handleEvent({ type: "message_start", message }).catch(() => {});
		expect(addMessageToChat).toHaveBeenCalledTimes(1);
		expect(addMessageToChat).toHaveBeenCalledWith(message);
		await pending;
	});
});

function createIrcMessage(timestamp: number): CustomMessage<{ from: string; message: string }> {
	return {
		role: "custom",
		customType: "irc:incoming",
		content: "Ready",
		display: true,
		details: { from: "0-Main", message: `Ready ${timestamp}` },
		timestamp,
	};
}

function createIrcContext(options: { liveBlockAbove?: boolean } = {}) {
	const chatContainer = new TranscriptContainer();
	if (options.liveBlockAbove) {
		// A still-running tool above the cards: they sit in the live region,
		// where their rows cannot have committed to native scrollback.
		chatContainer.addChild({
			render: () => ["running tool"],
			invalidate: () => {},
			isTranscriptBlockFinalized: () => false,
		} as Component);
	}
	const requestRender = vi.fn();
	const ctx = {
		isInitialized: true,
		statusLine: { invalidate: vi.fn() },
		updateEditorTopBorder: vi.fn(),
		ui: { requestRender },
		chatContainer,
		session: {},
	} as unknown as InteractiveModeContext;
	const helpers = new UiHelpers(ctx);
	const addMessageToChat: InteractiveModeContext["addMessageToChat"] = vi.fn((message, options) =>
		helpers.addMessageToChat(message, options),
	);
	ctx.addMessageToChat = addMessageToChat;
	return { ctx, chatContainer, requestRender, addMessageToChat };
}

describe("EventController IRC expiry", () => {
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("renders IRC messages immediately and removes live-region cards after the TTL", async () => {
		vi.useFakeTimers();
		const message = createIrcMessage(1);
		const { ctx, chatContainer, requestRender } = createIrcContext({ liveBlockAbove: true });
		const controller = new EventController(ctx);

		await controller.handleEvent({ type: "irc_message", message });

		expect(chatContainer.children).toHaveLength(2);
		// One requestRender from the IRC handler mounting the card. The blanket
		// pre-render that `handleEvent` used to fire before every dispatch was
		// removed in #4353 (it doubled the paint rate during streaming and did no
		// visible work beyond what the handlers already trigger).
		expect(requestRender).toHaveBeenCalledTimes(1);

		vi.advanceTimersByTime(9_999);
		expect(chatContainer.children).toHaveLength(2);

		vi.advanceTimersByTime(1);
		expect(chatContainer.children).toHaveLength(1);
		expect(requestRender).toHaveBeenCalledTimes(2);
	});

	it("evicts the oldest live-region card beyond the cap", async () => {
		vi.useFakeTimers();
		const { ctx, chatContainer } = createIrcContext({ liveBlockAbove: true });
		const controller = new EventController(ctx);

		for (let i = 0; i < 5; i++) {
			await controller.handleEvent({ type: "irc_message", message: createIrcMessage(100 + i) });
		}
		// live block + MAX_LIVE_IRC_CARDS (4): the 5th card evicted the 1st.
		expect(chatContainer.children).toHaveLength(5);
		const rendered = chatContainer.children.map(child => child.render(80).join("\n"));
		expect(rendered.some(text => text.includes("100"))).toBe(false);
		expect(rendered.some(text => text.includes("104"))).toBe(true);
	});

	it("does not schedule duplicate expiry for duplicate IRC events", async () => {
		vi.useFakeTimers();
		const message = createIrcMessage(2);
		const { ctx, chatContainer, addMessageToChat } = createIrcContext({ liveBlockAbove: true });
		const controller = new EventController(ctx);

		await controller.handleEvent({ type: "irc_message", message });
		await controller.handleEvent({ type: "irc_message", message });

		expect(addMessageToChat).toHaveBeenCalledTimes(1);
		expect(chatContainer.children).toHaveLength(2);
		vi.advanceTimersByTime(10_000);
		expect(chatContainer.children).toHaveLength(1);
	});

	it("clears pending IRC expiry timers on dispose", async () => {
		vi.useFakeTimers();
		const message = createIrcMessage(3);
		const { ctx, chatContainer, requestRender } = createIrcContext();
		const controller = new EventController(ctx);

		await controller.handleEvent({ type: "irc_message", message });
		controller.dispose();
		vi.advanceTimersByTime(10_000);

		expect(chatContainer.children).toHaveLength(1);
		expect(requestRender).toHaveBeenCalledTimes(1);
	});
});
