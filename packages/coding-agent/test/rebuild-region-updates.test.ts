import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, ToolResultMessage } from "@oh-my-pi/pi-ai";
import { createRoot, effect } from "@oh-my-pi/pi-tui";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { AgentSession, type AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { HistoryStorage } from "@oh-my-pi/pi-coding-agent/session/history-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import type { AssistantView, PendingTool } from "../src/modes/types";
import type { TranscriptBlock } from "../src/ui/shell";
import { initTheme } from "../src/ui/theme/service";
import { createModeTerminal, renderRows, transcriptText } from "./helpers/mode-terminal";

const usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistantWithBash(command: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: { command } }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		stopReason: "toolUse",
		usage,
		timestamp: Date.now(),
	};
}

/**
 * An in-place rebuild (compaction, `/shake`, a display setting change) replays the whole session
 * into the transcript. The drawn main region must update once for the replay, not once per
 * replayed block: in Tern every update walks the whole transcript, so a per-block update made a
 * rebuild quadratic in its length.
 *
 * A rebuild in the pre-streaming window after a submission (Ctrl+T or any other rebuild path)
 * must keep the optimistically painted user message: `startPendingSubmission` paints it before
 * `session.prompt(...)` appends it to the session entries, so the replay has no record of it.
 */
describe("in-place transcript rebuild", () => {
	let authStorage: AuthStorage;
	let mode: InteractiveMode;
	let session: AgentSession;
	let tempDir: TempDir;

	beforeAll(() => {
		initTheme();
	});

	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-rebuild-region-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
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
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		mode?.stop();
		HistoryStorage.close();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		resetSettingsForTest();
	});

	it("updates the main region once for the removal and the whole replay", () => {
		for (let i = 0; i < 20; i++) {
			session.sessionManager.appendMessage({ role: "user", content: `prompt ${i}`, timestamp: i + 1 });
		}
		// A drawn transcript to replace, as compaction or `/shake` finds it.
		mode.rebuildChatFromMessages();
		let updates = 0;
		createRoot(dispose => {
			effect(() => {
				mode.shell.surface.main();
				updates++;
			});
			updates = 0;
			mode.rebuildChatFromMessages();
			dispose();
		});
		expect(updates).toBe(1);
		const rendered = transcriptText(mode.shell);
		expect(rendered).toContain("prompt 0");
		expect(rendered).toContain("prompt 19");
	});

	it("keeps the optimistic user message in chat after rebuildChatFromMessages before streaming starts", () => {
		const addMessageSpy = vi.spyOn(mode, "addMessageToChat");

		mode.startPendingSubmission({ text: "hello world" });
		expect(mode.optimisticUserMessageSignature).toBe("hello world\u00000");
		expect(addMessageSpy).toHaveBeenCalledTimes(1);
		expect(mode.shell.transcript.blocks().length).toBeGreaterThan(0);

		// Pre-streaming rebuild: no streamingComponent yet, message is NOT in
		// session entries yet, signature is still set.
		expect(mode.streaming).toBeUndefined();
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
		expect(mode.shell.transcript.blocks().length).toBeGreaterThan(0);
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

	/**
	 * A rebuild while the LLM is still streaming (`/shake`, snap-compaction) clears the transcript and
	 * replays only committed `state.messages`. The in-flight `streamMessage` and its pending tool calls
	 * live outside `state.messages` until `message_end`, so the rebuild snapshots the live components,
	 * re-appends them after the replay, and restores `pendingTools` so streaming continues into the
	 * same on-screen components.
	 */
	describe("mid-stream rebuild preserves the in-flight assistant turn", () => {
		/** The transcript's blocks. */
		const blocks = (): readonly TranscriptBlock[] => mode.shell.transcript.blocks();

		function makeStreamingFixture(streaming = true): {
			streamingComponent: AssistantView;
			pendingTool: PendingTool;
		} {
			const streamingComponent = mode.presentAssistant();
			const pendingTool = mode.presentToolCall({
				name: "bash",
				args: { command: "echo hi" },
				tool: undefined,
				id: "call-1",
				cwd: tempDir.path(),
			});
			mode.streaming = streamingComponent;
			mode.streamingMessage = assistantWithBash("echo hi");
			mode.pendingTools.set("call-1", pendingTool);
			Object.defineProperty(session, "isStreaming", { configurable: true, get: () => streaming });
			return { streamingComponent, pendingTool };
		}

		async function startRead(toolCallId: string, file: string): Promise<string> {
			const message: AssistantMessage = {
				role: "assistant",
				content: [{ type: "toolCall", id: toolCallId, name: "read", arguments: { path: file } }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-sonnet-4-5",
				stopReason: "toolUse",
				usage,
				timestamp: Date.now(),
			};
			const entryId = session.sessionManager.appendMessage(message);
			await mode.eventController.handleEvent({ type: "message_start", message });
			await mode.eventController.syncAssistantMessage(message);
			await mode.eventController.handleEvent({ type: "message_end", message });
			await mode.eventController.handleEvent({
				type: "tool_execution_start",
				toolCallId,
				toolName: "read",
				args: { path: file },
			});
			return entryId;
		}

		async function finishRead(toolCallId: string): Promise<void> {
			const result: ToolResultMessage = {
				role: "toolResult",
				toolCallId,
				toolName: "read",
				content: [{ type: "text", text: "file contents" }],
				isError: false,
				timestamp: Date.now(),
			};
			session.sessionManager.appendMessage(result);
			await mode.eventController.handleEvent({
				type: "tool_execution_end",
				toolCallId,
				toolName: "read",
				result,
				isError: false,
			});
		}

		it("shows subsequent read-only replies after mid-turn snap-compaction", async () => {
			Object.defineProperty(session, "isStreaming", { configurable: true, get: () => true });
			const firstKeptEntryId = await startRead("before", "before-compaction.ts");
			await finishRead("before");
			session.sessionManager.appendCompaction("Earlier history", undefined, firstKeptEntryId, 425_000, {
				method: "snapcompact",
				tokensAfter: 59_000,
			});
			await mode.eventController.handleEvent({
				type: "auto_compaction_end",
				action: "snapcompact",
				result: { summary: "Earlier history", firstKeptEntryId, tokensBefore: 425_000 },
				aborted: false,
				willRetry: false,
			});

			await startRead("after", "after-compaction.ts");
			await finishRead("after");

			const rendered = transcriptText(mode.shell);
			expect(rendered.match(/before-compaction\.ts/g)).toHaveLength(1);
			expect(rendered.match(/after-compaction\.ts/g)).toHaveLength(1);
		});

		it("keeps pending and subsequent reads in the same visible group across a rebuild", async () => {
			Object.defineProperty(session, "isStreaming", { configurable: true, get: () => true });
			await startRead("pending", "pending-read.ts");

			mode.rebuildChatFromMessages();
			await finishRead("pending");
			await startRead("next", "next-read.ts");
			await finishRead("next");

			const rendered = transcriptText(mode.shell);
			expect(rendered.match(/pending-read\.ts/g)).toHaveLength(1);
			expect(rendered.match(/next-read\.ts/g)).toHaveLength(1);
			const groups = blocks().filter(block => {
				const entry = mode.transcriptEntry(block);
				return entry?.kind === "tool" && entry.tool.group !== undefined;
			});
			expect(groups).toHaveLength(1);
			expect(mode.pendingTools.size).toBe(0);
		});

		it("keeps the streaming assistant component attached after a mid-stream rebuild", () => {
			const { streamingComponent } = makeStreamingFixture();

			mode.rebuildChatFromMessages();

			expect(blocks()).toContain(streamingComponent.block);
			expect(mode.streaming).toBe(streamingComponent);
		});

		it("routes later streamed tool-call deltas into the preserved on-screen component", async () => {
			const { pendingTool } = makeStreamingFixture();
			const updateArgs = vi.spyOn(pendingTool, "updateArgs");

			mode.rebuildChatFromMessages();
			await mode.eventController.handleEvent({
				type: "message_update",
				message: assistantWithBash("echo after"),
			} as AgentSessionEvent);

			expect(mode.pendingTools.get("call-1")).toBe(pendingTool);
			expect(updateArgs).toHaveBeenCalledWith({ command: "echo after" }, "call-1");
		});

		it("re-appends in-flight components after the historical replay (live tail order)", () => {
			const { streamingComponent, pendingTool } = makeStreamingFixture();

			mode.rebuildChatFromMessages();

			const children = blocks();
			const streamingIdx = children.indexOf(streamingComponent.block);
			const pendingIdx = children.indexOf(pendingTool.block);
			expect(streamingIdx).toBeGreaterThanOrEqual(0);
			expect(pendingIdx).toBeGreaterThan(streamingIdx);
		});

		it("keeps text streamed after a tool call attached across a mid-stream rebuild", async () => {
			const toolCall = assistantWithBash("echo hi").content[0]!;
			const reply: AssistantMessage = {
				...assistantWithBash("echo hi"),
				content: [{ type: "text", text: "Before the call." }, toolCall, { type: "text", text: "After the call." }],
			};
			Object.defineProperty(session, "isStreaming", { configurable: true, get: () => true });
			Object.defineProperty(session.agent.state, "streamMessage", { configurable: true, value: reply });
			await mode.eventController.handleEvent({ type: "message_start", message: reply } as AgentSessionEvent);
			await mode.eventController.handleEvent({ type: "message_update", message: reply } as AgentSessionEvent);
			const drawsAfter = (block: TranscriptBlock) =>
				mode.transcriptEntry(block)?.kind === "assistant" &&
				renderRows(() => block.node, 80)
					.join("\n")
					.includes("After the call.");
			const segment = blocks().find(drawsAfter);
			if (!segment) throw new Error("expected a block drawing the post-tool text");

			mode.rebuildChatFromMessages();

			expect(blocks()).toContain(segment);
			expect(blocks().filter(drawsAfter)).toHaveLength(1);
		});

		it("uses the rendered view session when preserving a focused subagent stream", () => {
			const { streamingComponent, pendingTool } = makeStreamingFixture(false);
			Object.defineProperty(mode, "viewSession", {
				configurable: true,
				get: () => ({
					isStreaming: true,
					buildTranscriptSessionContext: () => ({ messages: [] }),
					getToolByName: () => undefined,
					sessionManager: { getCwd: () => tempDir.path() },
					retryAttempt: undefined,
					agent: { state: {} },
				}),
			});

			mode.rebuildChatFromMessages();

			expect(blocks()).toContain(streamingComponent.block);
			expect(blocks()).toContain(pendingTool.block);
			expect(mode.pendingTools.get("call-1")).toBe(pendingTool);
		});

		it("does not preserve in-flight tracking when the session is idle (post-stream rebuilds reset cleanly)", () => {
			const streamingComponent = mode.presentAssistant();
			mode.streaming = streamingComponent;
			Object.defineProperty(session, "isStreaming", { configurable: true, get: () => false });

			mode.rebuildChatFromMessages();

			// Idle rebuilds (resume, /compact post-flush, theme overlay close) treat
			// the streaming view as stale UI to discard — the chat must be redrawn
			// purely from committed messages.
			expect(blocks()).not.toContain(streamingComponent.block);
		});
	});
});
