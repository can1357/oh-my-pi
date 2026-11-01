import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { createSettingsHost } from "@oh-my-pi/pi-coding-agent/config/settings-ui";
import { cfgTuiMode } from "@oh-my-pi/pi-coding-agent/modes/settings";
import * as themeModule from "@oh-my-pi/pi-tui/theme";
import { Input, TUI, isKittyProtocolActive, setKittyProtocolActive } from "@oh-my-pi/pi-tui";
import { TempDir } from "@oh-my-pi/pi-utils";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";

describe("InteractiveMode fullscreen", () => {
	let authStorage: AuthStorage;
	let mode: InteractiveMode;
	let session: AgentSession;
	let tempDir: TempDir;
	let terminal: VirtualTerminal;

	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@omp-fullscreen-stop-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 to exist in registry");
		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.instance,
			modelRegistry,
		});
		mode = new InteractiveMode(session, "test");
		terminal = new VirtualTerminal(80, 24);
		mode.ui = new TUI(terminal);
		vi.spyOn(mode.statusLine, "watchBranch").mockImplementation(() => {});
		await mode.init({ suppressWelcomeIntro: true });
		await terminal.waitForRender();
	});

	afterEach(async () => {
		mode?.stop();
		vi.restoreAllMocks();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		resetSettingsForTest();
	});

	it("does not restore a fullscreen surface after the mode stops", async () => {
		const writes: string[] = [];
		const write = terminal.write.bind(terminal);
		vi.spyOn(terminal, "write").mockImplementation(data => {
			writes.push(data);
			write(data);
		});

		cfgTuiMode.set(Settings.instance, "fullscreen");
		await terminal.waitForRender();
		expect(writes.join("")).toContain("\x1b[?1049h");

		mode.stop();
		writes.length = 0;
		mode.ui.start();
		await terminal.waitForRender();

		expect(writes.join("")).not.toContain("\x1b[?1049h");
		mode.ui.stop();
	});

	it("switches layouts live without losing the draft or the open settings dialog", async () => {
		mode.editor.setText("keep my draft");
		cfgTuiMode.override(Settings.instance, "fullscreen");
		await terminal.waitForRender();
		expect(terminal.getViewport().join("\n")).toContain("Sonnet 4.5");
		vi.spyOn(themeModule, "getAvailableThemes").mockResolvedValue(["dark"]);
		mode.showSettingsSelector();
		await Promise.resolve();
		await terminal.waitForRender();
		const dialog = mode.ui.getFocused();
		expect(dialog).not.toBe(mode.editor);
		expect(mode.ui.hasOverlay()).toBe(true);
		const panel = createSettingsHost();
		panel.set("tui.mode", "regular");
		await terminal.waitForRender();
		expect(mode.ui.getFocused()).toBe(dialog);
		expect(mode.ui.overlayStack.filter(entry => entry.options?.base)).toHaveLength(0);
		panel.set("tui.mode", "fullscreen");
		await terminal.waitForRender();
		expect(mode.ui.getFocused()).toBe(dialog);
		expect(mode.ui.overlayStack.filter(entry => entry.options?.base)).toHaveLength(1);
		expect(mode.editor.getText()).toBe("keep my draft");
	});
	it("keeps fragmented paste and encoded text in search without editing the draft", async () => {
		mode.editor.setText("draft");
		cfgTuiMode.set(Settings.instance, "fullscreen");
		await terminal.waitForRender();
		mode.ui.injectDebugInput("\x06");
		await terminal.waitForRender();
		const kitty = isKittyProtocolActive();
		try {
			setKittyProtocolActive(true);
			for (const chunk of ["\x1b[200~", "paste", "\x1b[201~", "\x1b[97u", "\x1b[97;1:3u", "\x1b[27;2;66~"]) {
				mode.ui.injectDebugInput(chunk);
			}
			await terminal.waitForRender();
			expect(mode.editor.getText()).toBe("draft");
			expect(terminal.getViewport()[0]).toContain("find: pasteaB");
			// IME placement follows the search field rather than the parked chat draft.
			expect(terminal.getCursor().row).toBe(0);
			mode.ui.injectDebugInput("\x1b");
			mode.ui.injectDebugInput("!");
			expect(mode.editor.getText()).toBe("draft!");
		} finally {
			setKittyProtocolActive(kitty);
		}
	});

	it("hands search input back to a replacement prompt and then to the chat editor", async () => {
		mode.editor.setText("draft");
		cfgTuiMode.set(Settings.instance, "fullscreen");
		await terminal.waitForRender();
		mode.ui.injectDebugInput("\x06");
		await terminal.waitForRender();
		const prompt = new Input();
		prompt.prompt = "Approval: ";
		mode.editorContainer.clear();
		mode.editorContainer.addChild(prompt);
		mode.ui.setFocus(prompt);
		// Input may arrive before the replacement prompt's first paint.
		mode.ui.injectDebugInput("answer");
		await terminal.waitForRender();
		expect(prompt.getValue()).toBe("answer");
		expect(terminal.getViewport().join("\n")).not.toContain("find:");
		expect(mode.editor.getText()).toBe("draft");
		mode.editorContainer.clear();
		mode.editorContainer.addChild(mode.editor);
		mode.ui.setFocus(mode.editor);
		mode.ui.injectDebugInput("!");
		expect(mode.editor.getText()).toBe("draft!");
	});
});
