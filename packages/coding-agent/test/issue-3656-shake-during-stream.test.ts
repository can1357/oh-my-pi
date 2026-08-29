import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AssistantMessageComponent } from "@oh-my-pi/pi-coding-agent/modes/components/assistant-message";
import { ToolExecutionComponent } from "@oh-my-pi/pi-coding-agent/modes/components/tool-execution";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
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

	it("keeps the streaming assistant component attached after a mid-stream rebuild", () => {
		const { streamingComponent } = makeStreamingFixture();

		mode.rebuildChatFromMessages();

		expect(mode.chatContainer.children).toContain(streamingComponent);
		expect(mode.streamingComponent).toBe(streamingComponent);
	});

	it("keeps in-flight tool components attached and tracked in pendingTools", () => {
		const { pendingTool } = makeStreamingFixture();

		mode.rebuildChatFromMessages();

		expect(mode.chatContainer.children).toContain(pendingTool);
		expect(mode.pendingTools.get("call-1")).toBe(pendingTool);
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
