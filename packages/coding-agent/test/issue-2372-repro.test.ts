import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

/**
 * Regression for issue #2372 — pressing Ctrl+T (or any other rebuild path)
 * during the pre-streaming window after a user submission must not erase the
 * optimistically-rendered user message. `startPendingSubmission` paints the
 * user's message before `session.prompt(...)` has appended it to session
 * entries; a `rebuildChatFromMessages()` in that window used to wipe it
 * because `buildTranscriptSessionContext()` has no record of it yet.
 */
describe("issue #2372 pre-streaming chat rebuild preserves optimistic submission", () => {
	let authStorage: AuthStorage;
	let mode: InteractiveMode;
	let session: AgentSession;
	let tempDir: TempDir;

	beforeAll(async () => {
		initTheme();
		vi.spyOn(process.stdout, "write").mockReturnValue(true);
		vi.spyOn(process.stdin, "resume").mockReturnValue(process.stdin);
		vi.spyOn(process.stdin, "pause").mockReturnValue(process.stdin);
		vi.spyOn(process.stdin, "setEncoding").mockReturnValue(process.stdin);
		if (typeof process.stdin.setRawMode === "function") {
			vi.spyOn(process.stdin, "setRawMode").mockReturnValue(process.stdin);
		}

		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-issue-2372-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		authStorage = createInMemoryAuthStorage();
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 test model");

		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated(),
			modelRegistry,
		});
		mode = new InteractiveMode(session, "test");
		mode.ui.requestRender = vi.fn();
	});

	beforeEach(() => {
		mode.clearOptimisticUserMessage();
		mode.chatContainer.clear();
		mode.locallySubmittedUserSignatures.clear();
		mode.optimisticUserMessageSignature = undefined;
		mode.isInitialized = false;
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	afterAll(async () => {
		mode.stop();
		await session.dispose();
		authStorage.close();
		tempDir.removeSync();
		vi.restoreAllMocks();
		resetSettingsForTest();
	});

	it("keeps the optimistic user message in chat after rebuildChatFromMessages before streaming starts", () => {
		const addMessageSpy = vi.spyOn(mode, "addMessageToChat");

		mode.startPendingSubmission({ text: "hello world" });
		expect(mode.optimisticUserMessageSignature).toBe("hello world\u00000");
		expect(addMessageSpy).toHaveBeenCalledTimes(1);
		expect(mode.chatContainer.children.length).toBeGreaterThan(0);

		// Pre-streaming rebuild: no streamingComponent yet, message is NOT in
		// session entries yet, signature is still set.
		expect(mode.streamingComponent).toBeUndefined();
		mode.rebuildChatFromMessages();
		// Signature stays set until EventController processes user message_start.
		expect(mode.optimisticUserMessageSignature).toBe("hello world\u00000");
		// The replay must have re-rendered the user message: total addMessageToChat
		// calls == initial optimistic add + 1 replay during rebuild.
		expect(addMessageSpy).toHaveBeenCalledTimes(2);
		const replayCall = addMessageSpy.mock.calls[1]?.[0];
		expect(replayCall).toMatchObject({
			role: "user",
			content: [{ type: "text", text: "hello world" }],
			attribution: "user",
		});
		// Chat container is non-empty (the optimistic user message is back).
		expect(mode.chatContainer.children.length).toBeGreaterThan(0);
	});

	it("does not duplicate the user message once message_start has cleared the optimistic signature", () => {
		const addMessageSpy = vi.spyOn(mode, "addMessageToChat");

		mode.startPendingSubmission({ text: "hello again" });
		expect(addMessageSpy).toHaveBeenCalledTimes(1);

		// Simulate EventController#handleMessageStart having confirmed the user
		// message: signature is cleared, real session entry exists in the
		// transcript path. `#pendingSubmittedInput` may still be alive (we are
		// streaming) but the replay must NOT trigger.
		mode.optimisticUserMessageSignature = undefined;

		mode.rebuildChatFromMessages();

		// Only the initial optimistic add — no replay duplication.
		expect(addMessageSpy).toHaveBeenCalledTimes(1);
	});

	it("replaces raw slash optimistic text when message_start carries expanded content", async () => {
		mode.isInitialized = true;
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

		const renderedTexts = addMessageSpy.mock.calls.map(([message]) => {
			if (message.role !== "user") throw new Error(`Expected user message, got ${message.role}`);
			return typeof message.content === "string"
				? message.content
				: message.content
						.filter(content => content.type === "text")
						.map(content => content.text)
						.join("\n");
		});
		expect(renderedTexts).toEqual(["/jira-task", "/jira-task", "Expanded Jira task prompt"]);
		expect(mode.chatContainer.children).toHaveLength(1);
		expect(mode.optimisticUserMessageSignature).toBeUndefined();
		expect(mode.locallySubmittedUserSignatures.has("/jira-task\u00000")).toBe(false);
	});

	it("does not replace a pending optimistic prompt with another local user event", async () => {
		mode.isInitialized = true;
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
		expect(mode.chatContainer.children).toHaveLength(2);
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

		const renderedTexts = addMessageSpy.mock.calls.map(([message]) => {
			if (message.role !== "user") throw new Error(`Expected user message, got ${message.role}`);
			return typeof message.content === "string"
				? message.content
				: message.content
						.filter(content => content.type === "text")
						.map(content => content.text)
						.join("\n");
		});
		expect(renderedTexts).toEqual(["/jira-task", "queued before prompt", "Expanded Jira task prompt"]);
		expect(mode.chatContainer.children).toHaveLength(2);
		expect(mode.optimisticUserMessageSignature).toBeUndefined();
	});

	it("does not replay after the submission is cancelled", () => {
		const addMessageSpy = vi.spyOn(mode, "addMessageToChat");

		mode.startPendingSubmission({ text: "cancel me" });
		expect(mode.optimisticUserMessageSignature).toBe("cancel me\u00000");
		mode.cancelPendingSubmission();

		// `cancelPendingSubmission` already rebuilds; after that, an explicit
		// rebuild must not resurrect the cancelled message.
		const callsAfterCancel = addMessageSpy.mock.calls.length;
		mode.rebuildChatFromMessages();
		expect(addMessageSpy).toHaveBeenCalledTimes(callsAfterCancel);
		expect(mode.optimisticUserMessageSignature).toBeUndefined();
	});
});
