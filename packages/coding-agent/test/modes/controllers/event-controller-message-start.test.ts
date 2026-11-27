import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { Agent, type AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, ImageContent, UserMessage } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { recapBlock } from "../../../src/modes/controllers/event-blocks";
import { initTheme } from "../../../src/ui/theme/service";
import type { CustomMessage } from "@oh-my-pi/pi-coding-agent/session/messages";
import { isSettled } from "@oh-my-pi/pi-tui";
import type { PendingTool } from "@oh-my-pi/pi-coding-agent/modes/types";
import { createInMemoryAuthStorage } from "../../helpers/agent-session-setup";
import { createInteractiveModeContext } from "../../helpers/interactive-mode-context";
import { createModeTerminal } from "../../helpers/mode-terminal";
import { blockText } from "../../helpers/transcript-text";

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
	pendingImages?: ImageContent[];
}) {
	const ctx = createInteractiveModeContext({
		optimisticUserMessageSignature: options.optimisticSignature,
		locallySubmittedUserSignatures: new Set<string>(options.locallySubmittedSignatures ?? []),
	});
	const clearOptimisticUserMessage = vi.fn(() => {
		ctx.optimisticUserMessageSignature = undefined;
	});
	const replaceOptimisticUserMessage = vi.fn(() => {
		ctx.optimisticUserMessageSignature = undefined;
	});
	ctx.clearOptimisticUserMessage = clearOptimisticUserMessage;
	ctx.replaceOptimisticUserMessage = replaceOptimisticUserMessage;
	const composer = ctx.composer;
	composer.setText(options.editorText);
	for (const image of options.pendingImages ?? []) {
		composer.pendingImages.push({ type: "image", data: image.data, mimeType: image.mimeType });
	}
	const setText = vi.spyOn(composer, "setText");
	const editor = {
		getText: () => composer.text(),
		get pendingImages() {
			return composer.pendingImages.map(image => ({ type: "image", data: image.data, mimeType: image.mimeType }));
		},
	};
	return {
		ctx,
		editor,
		setText,
		addMessageToChat: ctx.addMessageToChat,
		updatePendingMessagesDisplay: ctx.updatePendingMessagesDisplay,
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
		// Signature is consumed so a future external message with the same shape is
		// not matched to this local submission again. The composer is never cleared
		// on message_start, so consumption no longer affects the draft.
		expect(ctx.locallySubmittedUserSignatures.has(signature)).toBe(false);
	});

	it("preserves the in-progress draft for a user message from an extension", async () => {
		// Regression: a user message this session never submitted locally is a real,
		// non-synthetic prompt (an extension delivering `sendUserMessage`, e.g. HCOM).
		// "Not local" must not mean "reset the editor": the draft being typed — text
		// and pasted images — has to survive the delivery.
		const message = createUserMessage("inbound from an extension");
		const draftImage: ImageContent = { type: "image", data: "AAAA", mimeType: "image/png" };
		const { ctx, editor, setText, addMessageToChat, updatePendingMessagesDisplay } = createContext({
			editorText: "hello",
			pendingImages: [draftImage],
		});
		const controller = new EventController(ctx);

		await controller.handleEvent({ type: "message_start", message });

		expect(setText).not.toHaveBeenCalled();
		expect(editor.getText()).toBe("hello");
		expect(editor.pendingImages).toEqual([draftImage]);
		// The inbound message still reaches the transcript.
		expect(addMessageToChat).toHaveBeenCalledWith(message);
		// The pending list still refreshes.
		expect(updatePendingMessagesDisplay).toHaveBeenCalledTimes(1);
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

/** The text of every user message the `addMessageToChat` calls received, in call order. */
function renderedUserTexts(calls: ReadonlyArray<readonly [AgentMessage, ...unknown[]]>): string[] {
	return calls.map(([message]) => {
		if (message.role !== "user") throw new Error(`Expected user message, got ${message.role}`);
		return typeof message.content === "string"
			? message.content
			: message.content
					.filter(content => content.type === "text")
					.map(content => content.text)
					.join("\n");
	});
}

describe("EventController message_start (optimistic submission on InteractiveMode)", () => {
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let mode: InteractiveMode;
	let session: AgentSession;
	let tempDir: TempDir;

	beforeAll(async () => {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-message-start-optimistic-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		authStorage = createInMemoryAuthStorage();
		modelRegistry = new ModelRegistry(authStorage);
	});

	beforeEach(() => {
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 test model");
		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated(),
			modelRegistry,
		});
		mode = new InteractiveMode(
			session,
			"test",
			undefined,
			undefined,
			undefined,
			undefined,
			createModeTerminal().frame,
		);
		mode.isInitialized = true;
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		mode?.stop();
		await session?.dispose();
	});

	afterAll(() => {
		authStorage.close();
		tempDir.removeSync();
		resetSettingsForTest();
	});

	it("replaces raw slash optimistic text when message_start carries expanded content", async () => {
		const controller = new EventController(mode);
		const addMessageSpy = vi.spyOn(mode, "addMessageToChat");

		mode.startPendingSubmission({ text: "/jira-task" });
		mode.rebuildChatFromMessages();
		await controller.handleEvent({
			type: "message_start",
			message: {
				role: "user",
				content: [{ type: "text", text: "Expanded Jira task prompt" }],
				attribution: "user",
				timestamp: Date.now(),
			},
		});

		expect(renderedUserTexts(addMessageSpy.mock.calls)).toEqual([
			"/jira-task",
			"/jira-task",
			"Expanded Jira task prompt",
		]);
		expect(mode.shell.transcript.blocks()).toHaveLength(1);
		expect(mode.optimisticUserMessageSignature).toBeUndefined();
		expect(mode.locallySubmittedUserSignatures.has("/jira-task\u00000")).toBe(false);
	});

	it("does not replace a pending optimistic prompt with another local user event", async () => {
		const controller = new EventController(mode);
		const addMessageSpy = vi.spyOn(mode, "addMessageToChat");

		mode.startPendingSubmission({ text: "/jira-task" });
		mode.locallySubmittedUserSignatures.add("queued before prompt\u00000");

		await controller.handleEvent({
			type: "message_start",
			message: {
				role: "user",
				content: [{ type: "text", text: "queued before prompt" }],
				attribution: "user",
				timestamp: Date.now(),
			},
		});

		expect(mode.optimisticUserMessageSignature).toBe("/jira-task\u00000");
		expect(mode.shell.transcript.blocks()).toHaveLength(2);
		expect(mode.locallySubmittedUserSignatures.has("queued before prompt\u00000")).toBe(false);

		await controller.handleEvent({
			type: "message_start",
			message: {
				role: "user",
				content: [{ type: "text", text: "Expanded Jira task prompt" }],
				attribution: "user",
				timestamp: Date.now(),
			},
		});

		expect(renderedUserTexts(addMessageSpy.mock.calls)).toEqual([
			"/jira-task",
			"queued before prompt",
			"Expanded Jira task prompt",
		]);
		expect(mode.shell.transcript.blocks()).toHaveLength(2);
		expect(mode.optimisticUserMessageSignature).toBeUndefined();
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
	const ctx = createInteractiveModeContext();
	if (options.liveBlockAbove) {
		// A still-running tool above the cards: they sit in the live region,
		// where their rows cannot have reached terminal scrollback.
		ctx.present(() => recapBlock("running tool"), { live: true });
	}
	// The card a delivered IRC message draws: its text in one block.
	ctx.addMessageToChat = vi.fn(message => {
		const details = (message as CustomMessage<{ message: string }>).details;
		return [ctx.present(() => recapBlock(details?.message ?? ""))];
	});
	return { ctx, transcript: ctx.shell.transcript, addMessageToChat: ctx.addMessageToChat };
}

describe("EventController IRC expiry", () => {
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("renders IRC messages immediately and removes live-region cards after the TTL", async () => {
		vi.useFakeTimers();
		const message = createIrcMessage(1);
		const { ctx, transcript } = createIrcContext({ liveBlockAbove: true });
		const controller = new EventController(ctx);

		await controller.handleEvent({ type: "irc_message", message });

		expect(transcript.blocks()).toHaveLength(2);

		vi.advanceTimersByTime(9_999);
		expect(transcript.blocks()).toHaveLength(2);

		vi.advanceTimersByTime(1);
		expect(transcript.blocks()).toHaveLength(1);
	});

	it("evicts the oldest live-region card beyond the cap", async () => {
		vi.useFakeTimers();
		const { ctx, transcript } = createIrcContext({ liveBlockAbove: true });
		const controller = new EventController(ctx);

		for (let i = 0; i < 5; i++) {
			await controller.handleEvent({ type: "irc_message", message: createIrcMessage(100 + i) });
		}
		// live block + MAX_LIVE_IRC_CARDS (4): the 5th card evicted the 1st.
		expect(transcript.blocks()).toHaveLength(5);
		const rendered = transcript.blocks().map(block => blockText(block, 80));
		expect(rendered.some(text => text.includes("100"))).toBe(false);
		expect(rendered.some(text => text.includes("104"))).toBe(true);
	});

	it("does not schedule duplicate expiry for duplicate IRC events", async () => {
		vi.useFakeTimers();
		const message = createIrcMessage(2);
		const { ctx, transcript, addMessageToChat } = createIrcContext({ liveBlockAbove: true });
		const controller = new EventController(ctx);

		await controller.handleEvent({ type: "irc_message", message });
		await controller.handleEvent({ type: "irc_message", message });

		expect(addMessageToChat).toHaveBeenCalledTimes(1);
		expect(transcript.blocks()).toHaveLength(2);
		vi.advanceTimersByTime(10_000);
		expect(transcript.blocks()).toHaveLength(1);
	});

	it("clears pending IRC expiry timers on dispose", async () => {
		vi.useFakeTimers();
		const message = createIrcMessage(3);
		const { ctx, transcript } = createIrcContext();
		const controller = new EventController(ctx);

		await controller.handleEvent({ type: "irc_message", message });
		controller.dispose();
		vi.advanceTimersByTime(10_000);

		expect(transcript.blocks()).toHaveLength(1);
	});
});

describe("EventController message_start (assistant role)", () => {
	const opening: AssistantMessage = {
		role: "assistant",
		content: [],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		stopReason: "stop",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: 1,
	};

	it("seals tool cards no result can reach, so they cannot block transcript retirement, and leaves a running call alone", async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true, cwd: process.cwd() });
		const pendingTools = new Map<string, PendingTool>();
		const ctx = createInteractiveModeContext({ pendingTools });
		const controller = new EventController(ctx);
		const card = (id: string) =>
			ctx.presentToolCall({ name: "bash", args: { command: "echo hi" }, tool: undefined, id, cwd: process.cwd() });
		// No call id routes to it: a preview left behind by a stream that never ended.
		const untracked = card("gone");
		// Streamed by an earlier message, never started.
		const stale = card("stale");
		pendingTools.set("stale", stale);
		await controller.handleEvent({ type: "tool_execution_start", toolCallId: "run", toolName: "bash", args: {} });
		const running = pendingTools.get("run")!;

		await controller.handleEvent({ type: "message_start", message: opening });

		expect(isSettled(untracked.block.node)).toBe(true);
		expect(isSettled(stale.block.node)).toBe(true);
		expect(pendingTools.has("stale")).toBe(false);
		expect(isSettled(running.block.node)).toBe(false);
		expect(pendingTools.get("run")).toBe(running);
		running.seal();
		resetSettingsForTest();
	});

	it("leaves a finished todo snapshot displaceable, so the next todo update replaces its card", async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true, cwd: process.cwd() });
		const ctx = createInteractiveModeContext();
		const controller = new EventController(ctx);
		const todo = async (id: string, status: string) => {
			const call = { type: "toolCall" as const, id, name: "todo", arguments: { op: "update" } };
			await controller.handleEvent({ type: "message_start", message: { ...opening, content: [] } });
			await controller.handleEvent({ type: "message_end", message: { ...opening, content: [call] } });
			await controller.handleEvent({ type: "tool_execution_start", toolCallId: id, toolName: "todo", args: {} });
			await controller.handleEvent({
				type: "tool_execution_end",
				toolCallId: id,
				toolName: "todo",
				result: {
					content: [{ type: "text", text: "ok" }],
					details: { phases: [{ name: "Work", tasks: [{ content: "task", status }] }] },
				},
				isError: false,
			});
		};
		const todoCards = () =>
			ctx.shell.transcript
				.blocks()
				.map(block => ctx.transcriptEntry(block))
				.filter(entry => entry?.kind === "tool" && entry.tool.call?.name === "todo");

		await todo("todo-1", "pending");
		// The next assistant message opens: the finished snapshot is not an orphan to seal.
		await todo("todo-2", "in_progress");

		expect(todoCards()).toHaveLength(1);
		controller.dispose();
		resetSettingsForTest();
	});
});
