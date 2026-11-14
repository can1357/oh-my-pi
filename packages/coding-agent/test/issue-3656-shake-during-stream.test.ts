import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, ToolResultMessage } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AssistantMessageComponent } from "@oh-my-pi/pi-tui/chat/assistant-message";
import { ToolExecutionComponent } from "@oh-my-pi/pi-tui/chat/tool-execution";
import { ReadToolGroupComponent } from "@oh-my-pi/pi-tui/chat/read-tool-group";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { HistoryStorage } from "@oh-my-pi/pi-coding-agent/session/history-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

/**
 * Regression for issue #3656 — running `/shake` (or any mid-stream rebuild)
 * while the LLM is still streaming used to wipe the in-flight assistant turn
 * from the chat. `rebuildChatFromMessages` clears `chatContainer` and replays
 * only committed `state.messages`; the agent's in-flight `streamMessage` and
 * its still-pending tool calls live OUTSIDE `state.messages` until
 * `message_end`, so the live `streamingComponent` and `pendingTools` entries
 * were detached and every subsequent `message_update`/`message_end` event
 * routed deltas into orphaned components that never re-rendered.
 *
 * The fix snapshots the live components before clear, re-appends them after
 * the historical replay, and restores the `pendingTools` map so streaming
 * continues into the same on-screen components.
 */
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

describe("issue #3656 /shake mid-stream preserves the in-flight assistant turn", () => {
	let authStorage: AuthStorage;
	let mode: InteractiveMode;
	let session: AgentSession;
	let tempDir: TempDir;

	beforeAll(() => {
		initTheme();
	});

	beforeEach(async () => {
		vi.spyOn(process.stdout, "write").mockReturnValue(true);
		vi.spyOn(process.stdin, "resume").mockReturnValue(process.stdin);
		vi.spyOn(process.stdin, "pause").mockReturnValue(process.stdin);
		vi.spyOn(process.stdin, "setEncoding").mockReturnValue(process.stdin);
		if (typeof process.stdin.setRawMode === "function") {
			vi.spyOn(process.stdin, "setRawMode").mockReturnValue(process.stdin);
		}

		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-issue-3656-");
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
		mode = new InteractiveMode(session, "test");
		mode.ui.requestRender = vi.fn();
	});

	afterEach(async () => {
		mode?.stop();
		HistoryStorage.close();
		vi.restoreAllMocks();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		resetSettingsForTest();
	});

	function makeStreamingFixture(streaming = true): {
		streamingComponent: AssistantMessageComponent;
		pendingTool: ToolExecutionComponent;
	} {
		const streamingComponent = new AssistantMessageComponent();
		const pendingTool = new ToolExecutionComponent(
			"bash",
			{ command: "echo hi" },
			{},
			undefined,
			mode.ui,
			tempDir.path(),
			"call-1",
		);
		mode.chatContainer.addChild(streamingComponent);
		mode.chatContainer.addChild(pendingTool);
		mode.streamingComponent = streamingComponent;
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

		const rendered = Bun.stripANSI(mode.chatContainer.render(120).join("\n"));
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

		const rendered = Bun.stripANSI(mode.chatContainer.render(120).join("\n"));
		expect(rendered.match(/pending-read\.ts/g)).toHaveLength(1);
		expect(rendered.match(/next-read\.ts/g)).toHaveLength(1);
		expect(mode.chatContainer.children.filter(child => child instanceof ReadToolGroupComponent)).toHaveLength(1);
		expect(mode.pendingTools.size).toBe(0);
	});

	it("keeps the streaming assistant component attached after a mid-stream rebuild", () => {
		const { streamingComponent } = makeStreamingFixture();

		mode.rebuildChatFromMessages();

		expect(mode.chatContainer.children).toContain(streamingComponent);
		expect(mode.streamingComponent).toBe(streamingComponent);
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

		const children = mode.chatContainer.children;
		const streamingIdx = children.indexOf(streamingComponent);
		const pendingIdx = children.indexOf(pendingTool);
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
		const drawsAfter = (child: unknown) =>
			child instanceof AssistantMessageComponent &&
			Bun.stripANSI(child.render(80).join("\n")).includes("After the call.");
		const segment = mode.chatContainer.children.find(drawsAfter);
		if (!segment) throw new Error("expected a component drawing the post-tool text");

		mode.rebuildChatFromMessages();

		expect(mode.chatContainer.children).toContain(segment);
		expect(mode.chatContainer.children.filter(drawsAfter)).toHaveLength(1);
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

		expect(mode.chatContainer.children).toContain(streamingComponent);
		expect(mode.chatContainer.children).toContain(pendingTool);
		expect(mode.pendingTools.get("call-1")).toBe(pendingTool);
	});

	it("does not preserve in-flight tracking when the session is idle (post-stream rebuilds reset cleanly)", () => {
		const streamingComponent = new AssistantMessageComponent();
		mode.chatContainer.addChild(streamingComponent);
		mode.streamingComponent = streamingComponent;
		Object.defineProperty(session, "isStreaming", { configurable: true, get: () => false });

		mode.rebuildChatFromMessages();

		// Idle rebuilds (resume, /compact post-flush, theme overlay close) treat
		// `streamingComponent` as stale UI to discard — the chat must be redrawn
		// purely from committed messages.
		expect(mode.chatContainer.children).not.toContain(streamingComponent);
	});
});
