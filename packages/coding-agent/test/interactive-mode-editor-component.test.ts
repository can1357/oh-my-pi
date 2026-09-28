import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { CustomEditor } from "@oh-my-pi/pi-tui/prompt/custom-editor";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { initTheme, theme } from "@oh-my-pi/pi-tui/theme";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

class TestModalEditor extends CustomEditor {}

describe("InteractiveMode.setEditorComponent", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let mode: InteractiveMode;

	beforeAll(() => {
		initTheme();
	});

	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-editor-component-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) {
			throw new Error("Expected claude-sonnet-4-5 to exist in registry");
		}

		session = new AgentSession({
			agent: new Agent({
				initialState: {
					model,
					systemPrompt: ["Test"],
					tools: [],
					messages: [],
				},
			}),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated(),
			modelRegistry,
		});
		mode = new InteractiveMode(session, "test");
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		mode?.stop();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		resetSettingsForTest();
	});

	it("replaces the editor and rebinds interactive handlers", () => {
		mode.editor.setText("draft prompt");
		const previousEditor = mode.editor;
		const refreshSpy = vi.spyOn(mode, "refreshSlashCommandState").mockResolvedValue();

		mode.setEditorComponent((_tui, editorTheme) => new TestModalEditor(editorTheme));

		expect(mode.editor).toBeInstanceOf(TestModalEditor);
		expect(mode.editor).not.toBe(previousEditor);
		expect(mode.editor.getText()).toBe("draft prompt");
		expect(mode.editor.onSubmit).toBeDefined();
		expect(mode.editor.onEscape).toBeDefined();
		expect(refreshSpy).toHaveBeenCalled();
	});

	it("shows stash feedback in the composer placeholder and restores the current hint", () => {
		vi.useFakeTimers();
		try {
			const ordinaryHint = Bun.stripANSI(mode.editor.placeholder?.() ?? "");
			expect(ordinaryHint).not.toBe("");
			const requestRender = vi.spyOn(mode.ui, "requestRender").mockImplementation(() => {});

			mode.notifyComposerStash();

			expect(Bun.stripANSI(mode.editor.placeholder?.() ?? "")).toBe("Prompt stashed");
			expect(mode.editor.placeholder?.()).toBe(theme.fg("dim", "Prompt stashed"));
			expect(Bun.stripANSI(mode.editor.render(80).join("\n"))).toContain("Prompt stashed");
			expect(requestRender).toHaveBeenCalledTimes(1);
			vi.advanceTimersByTime(100);
			expect(Bun.stripANSI(mode.editor.placeholder?.() ?? "")).toBe("Prompt stashed");

			vi.advanceTimersByTime(10_000);
			expect(Bun.stripANSI(mode.editor.placeholder?.() ?? "")).toBe(ordinaryHint);
			expect(requestRender).toHaveBeenCalledTimes(2);
		} finally {
			vi.useRealTimers();
		}
	});

	it("cancels stash feedback when a saved draft is restored", () => {
		vi.useFakeTimers();
		try {
			const ordinaryHint = Bun.stripANSI(mode.editor.placeholder?.() ?? "");
			const requestRender = vi.spyOn(mode.ui, "requestRender").mockImplementation(() => {});

			mode.notifyComposerStash();
			expect(Bun.stripANSI(mode.editor.placeholder?.() ?? "")).toBe("Prompt stashed");

			vi.advanceTimersByTime(100);
			mode.cancelComposerStashNotice();

			expect(Bun.stripANSI(mode.editor.placeholder?.() ?? "")).toBe(ordinaryHint);
			expect(requestRender).toHaveBeenCalledTimes(2);

			vi.advanceTimersByTime(10_000);
			expect(Bun.stripANSI(mode.editor.placeholder?.() ?? "")).toBe(ordinaryHint);
			expect(requestRender).toHaveBeenCalledTimes(2);
		} finally {
			vi.useRealTimers();
		}
	});

	it("cancels the stash feedback timer when transient session UI is cleared", () => {
		vi.useFakeTimers();
		try {
			const ordinaryHint = Bun.stripANSI(mode.editor.placeholder?.() ?? "");
			const requestRender = vi.spyOn(mode.ui, "requestRender").mockImplementation(() => {});

			mode.notifyComposerStash();
			expect(Bun.stripANSI(mode.editor.placeholder?.() ?? "")).toBe("Prompt stashed");

			mode.clearTransientSessionUi();
			requestRender.mockClear();
			vi.advanceTimersByTime(10_000);

			expect(Bun.stripANSI(mode.editor.placeholder?.() ?? "")).toBe(ordinaryHint);
			expect(requestRender).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});
});
