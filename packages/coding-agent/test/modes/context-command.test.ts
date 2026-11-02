import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { HistoryStorage } from "@oh-my-pi/pi-coding-agent/session/history-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { TempDir, withTimeout } from "@oh-my-pi/pi-utils";

describe("context command viewer", () => {
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
		tempDir = TempDir.createSync("@pi-context-command-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
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

	it("keeps /context focused fullscreen while a real pending turn continues, restoring draft without abort or submission", async () => {
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 test model");
		authStorage.keys.setRuntime("anthropic", "test-key");
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let requests = 0;
		const mock = createMockModel({
			responses: [
				async () => {
					requests++;
					entered.resolve();
					await release.promise;
					return { content: ["background progress completed"] };
				},
			],
		});
		session = new AgentSession({
			agent: new Agent({
				getApiKey: () => "test-key",
				initialState: { model, systemPrompt: ["one system block"], tools: [] },
				streamFn: mock.stream,
			}),
			sessionManager: SessionManager.inMemory(tempDir.path()),
			settings: Settings.isolated({ "compaction.enabled": false, "todo.enabled": false }),
			modelRegistry,
			autoTitle: false,
		});
		mode = new InteractiveMode(session, "test");
		mode.isInitialized = true;
		mode.ui.requestRender = vi.fn();
		new InputController(mode).setupKeyHandlers();
		mode.editor.setText("draft must survive");
		mode.ui.setFocus(mode.editor);
		const abort = vi.spyOn(session, "abort");
		const pending = session.prompt("run background fixture");
		await withTimeout(entered.promise, 2000, "fixture never entered model call");
		try {
			const messages = JSON.stringify(session.messages);
			mode.handleContextCommand();
			const overlay = mode.ui.overlayStack.at(-1)!;
			expect(overlay.options?.fullscreen).toBe(true);
			expect(mode.ui.getFocused()).toBe(overlay.component);
			const snapshot = overlay.component.render(100);
			overlay.component.handleInput?.("\r");
			overlay.component.handleInput?.("\x1b");
			expect(mode.ui.getFocused()).toBe(overlay.component);
			expect(abort).not.toHaveBeenCalled();
			expect(JSON.stringify(session.messages)).toBe(messages);
			expect(requests).toBe(1);
			release.resolve();
			await pending;
			expect(
				session.messages.some(
					message =>
						message.role === "assistant" &&
						message.content.some(
							block => block.type === "text" && block.text === "background progress completed",
						),
				),
			).toBe(true);
			expect(overlay.component.render(100)).toEqual(snapshot);
			overlay.component.handleInput?.("\x1b");
			expect(mode.ui.hasOverlay()).toBe(false);
			expect(mode.ui.getFocused()).toBe(mode.editor);
			expect(mode.editor.getText()).toBe("draft must survive");
			expect(abort).not.toHaveBeenCalled();
			expect(requests).toBe(1);
			mode.handleContextCommand();
			mode.handleToolsCommand();
			expect(mode.ui.overlayStack).toHaveLength(0);
			expect(mode.reportContainer.children).toHaveLength(1);
		} finally {
			release.resolve();
			await pending;
		}
	});
});
