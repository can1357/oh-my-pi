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
import { TempDir, withTimeout } from "@oh-my-pi/pi-utils";
import type { UiNode } from "@oh-my-pi/pi-tui";
import { initTheme } from "../../src/ui/theme/service";
import { createModeTerminal, type ModeTerminal } from "../helpers/mode-terminal";

/** Whether `node` is `root` or inside it. */
function within(root: UiNode, node: UiNode | null): boolean {
	return node !== null && (root === node || root.children().some(child => within(child, node)));
}

describe("context command viewer", () => {
	let authStorage: AuthStorage;
	let mode: InteractiveMode;
	let session: AgentSession;
	let tempDir: TempDir;
	let term: ModeTerminal | undefined;

	beforeAll(() => {
		initTheme();
	});

	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-context-command-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
	});

	afterEach(async () => {
		mode?.stop();
		await mode?.shell.stop();
		term?.dispose();
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
		// The viewer runs on the shell: keys reach it through the terminal.
		term = createModeTerminal({ columns: 100, rows: 30 });
		await term.start();
		const screen = term;
		mode = new InteractiveMode(session, "test", undefined, undefined, undefined, undefined, term.frame);
		mode.isInitialized = true;
		new InputController(mode).setupKeyHandlers();
		mode.composer.setText("draft must survive");
		mode.shell.focus(mode.composer.field);
		const abort = vi.spyOn(session, "abort");
		const pending = session.prompt("run background fixture");
		await withTimeout(entered.promise, 2000, "fixture never entered model call");
		try {
			mode.handleContextCommand();
			const overlay = mode.shell.overlays.top()!;
			expect(overlay).toBeDefined();
			expect(within(overlay.node, mode.shell.focused())).toBe(true);
			// Fullscreen: the viewer takes the alternate screen.
			await screen.waitFor(() => !screen.engine.isMainScreen);
			await screen.settle();
			const snapshot = screen.screen();
			const messages = JSON.stringify(session.messages);
			screen.press("enter");
			screen.press("escape");
			await screen.settle();
			expect(mode.shell.overlays.top()).toBe(overlay);
			expect(within(overlay.node, mode.shell.focused())).toBe(true);
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
			await screen.settle();
			expect(screen.screen()).toEqual(snapshot);
			screen.press("escape");
			await screen.waitFor(() => !mode.shell.overlays.open());
			expect(mode.shell.focused()).toBe(mode.composer.field);
			expect(mode.composer.text()).toBe("draft must survive");
			expect(abort).not.toHaveBeenCalled();
			expect(requests).toBe(1);
			mode.handleContextCommand();
			mode.handleToolsCommand();
			expect(mode.shell.overlays.open()).toBe(false);
			expect(mode.shell.dock.slot("report").occupied()).toBe(true);
		} finally {
			release.resolve();
			await pending;
		}
	});
});
