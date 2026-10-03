import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { HistoryStorage } from "@oh-my-pi/pi-coding-agent/session/history-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import { Text } from "@oh-my-pi/pi-tui";
import { isNativeRendering, setNativeRendering } from "@oh-my-pi/pi-tui/native/state";
import { TempDir } from "@oh-my-pi/pi-utils";

describe("issue #4806 command output during streaming", () => {
	let authStorage: AuthStorage;
	let mode: InteractiveMode;
	let session: AgentSession;
	let streaming = true;
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
		tempDir = TempDir.createSync("@pi-issue-4806-");
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
		streaming = true;
		Object.defineProperty(session, "isStreaming", { configurable: true, get: () => streaming });
		mode = new InteractiveMode(session, "test");
		mode.isInitialized = true;
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

	it("docks a short report above the editor without touching the streaming transcript; Esc removes it", () => {
		const streamedReply = new Text("agent is streaming", 0, 0);
		mode.chatContainer.addChild(streamedReply);
		mode.ui.setFocus(mode.editor);
		new InputController(mode).setupKeyHandlers();
		const abort = vi.spyOn(session, "abort");

		mode.handleToolsCommand();

		expect(mode.chatContainer.children).toEqual([streamedReply]);
		expect(mode.reportContainer.render(80).join("\n")).toContain("Available Tools");
		// The editor keeps focus: typing still goes to the prompt.
		expect(mode.ui.getFocused()).toBe(mode.editor);

		// The editor's Esc closes the report before it would interrupt the streaming turn.
		mode.editor.onEscape?.();
		expect(mode.reportContainer.children).toHaveLength(0);
		expect(abort).not.toHaveBeenCalled();
		expect(mode.chatContainer.children).toEqual([streamedReply]);
	});

	it("natively opens reports as focused sheets like /usage whose long bodies scroll; Esc closes them", async () => {
		const wasNative = isNativeRendering();
		setNativeRendering(true);
		try {
			streaming = false;
			type Described = { scroll?: { by: string; n: number }; c?: Described[] };
			const sheet = () => mode.ui.overlayStack.at(-1)?.component;

			mode.handleContextCommand();
			expect(sheet()?.nativeOverlay).toMatchObject({ role: "omp.overlay.report", size: "lg" });
			expect(mode.ui.getFocused()).toBe(sheet() ?? null);
			expect(mode.chatContainer.children).toHaveLength(0);
			expect(mode.reportContainer.children).toHaveLength(0);

			// A second report replaces the first sheet instead of stacking.
			await mode.handleChangelogCommand("full");
			expect(mode.ui.overlayStack).toHaveLength(1);
			// The sheet body is the terminal's scroller; Page Down reaches it as a scroll request.
			const bodyScroll = () =>
				(sheet()?.describe?.({ supports: () => true } as never) as Described | undefined)?.c?.[0]?.scroll;
			expect(bodyScroll()).toBeUndefined();
			sheet()?.handleInput?.("\x1b[6~");
			expect(bodyScroll()).toEqual({ by: "page-down", n: 1 });
			sheet()?.handleInput?.("\x1b[6~");
			expect(bodyScroll()).toEqual({ by: "page-down", n: 2 });

			sheet()?.handleInput?.("\x1b");
			expect(mode.ui.hasOverlay()).toBe(false);
			expect(mode.ui.getFocused()).toBe(mode.editor);
		} finally {
			setNativeRendering(wasNative);
		}
	});

	it("closes an open native report sheet when the transcript is reset for another session", () => {
		const wasNative = isNativeRendering();
		setNativeRendering(true);
		try {
			streaming = false;
			mode.handleContextCommand();
			expect(mode.ui.hasOverlay()).toBe(true);

			mode.resetTranscript();

			expect(mode.ui.hasOverlay()).toBe(false);
			expect(mode.ui.getFocused()).toBe(mode.editor);
		} finally {
			setNativeRendering(wasNative);
		}
	});

	it("mounts deferred command output once after the active turn ends", async () => {
		const streamedReply = new Text("agent is streaming", 0, 0);
		mode.chatContainer.addChild(streamedReply);

		mode.presentCommandOutput(new Text("Deferred Output", 0, 0));

		expect(mode.chatContainer.children).toEqual([streamedReply]);

		streaming = false;
		await mode.eventController.handleEvent({ type: "agent_end", messages: [] } as AgentSessionEvent);

		expect(mode.chatContainer.children).toHaveLength(2);
		const transcript = mode.chatContainer.render(80).join("\n");
		expect(transcript.match(/Deferred Output/g)).toHaveLength(1);
	});

	it("drops deferred command output when the session changes before agent_end", async () => {
		const streamedReply = new Text("old session is streaming", 0, 0);
		mode.chatContainer.addChild(streamedReply);
		const previousSessionId = session.sessionManager.getSessionId();

		mode.presentCommandOutput(new Text("Deferred Output", 0, 0));
		await session.newSession();

		expect(session.sessionManager.getSessionId()).not.toBe(previousSessionId);
		streaming = false;
		await mode.eventController.handleEvent({ type: "agent_end", messages: [] } as AgentSessionEvent);

		expect(mode.chatContainer.children).toEqual([streamedReply]);
	});
});
