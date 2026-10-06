import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { CustomEditor } from "@oh-my-pi/pi-tui/prompt/custom-editor";
import { setMotionEffects } from "@oh-my-pi/pi-tui/motion-effects";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
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

	it("releases a swapped-out editor's motion-effects subscription", () => {
		// Each editor subscribes to tui.motion for its magic-keyword shimmer; the swap must unbind the
		// outgoing one, or every swap leaks a detached editor that repaints on every motion flip.
		vi.spyOn(mode, "refreshSlashCommandState").mockResolvedValue();
		mode.setEditorComponent((_tui, editorTheme) => new TestModalEditor(editorTheme));
		const swappedOut = mode.editor;
		mode.setEditorComponent((_tui, editorTheme) => new TestModalEditor(editorTheme));
		expect(mode.editor).not.toBe(swappedOut);

		const renderSpy = vi.spyOn(mode.ui, "requestComponentRender");
		try {
			setMotionEffects(false);
			expect(renderSpy.mock.calls.some(([component]) => component === swappedOut)).toBe(false);
		} finally {
			setMotionEffects(true);
		}
	});

	it("keeps the previous editor live and subscribed when the swap factory throws", () => {
		// The outgoing editor is released only once the new one is committed, so a throwing factory
		// leaves the previous editor intact — still focused and still driving its magic-keyword shimmer.
		vi.spyOn(mode, "refreshSlashCommandState").mockResolvedValue();
		mode.setEditorComponent((_tui, editorTheme) => new TestModalEditor(editorTheme));
		const liveEditor = mode.editor;
		expect(() =>
			mode.setEditorComponent(() => {
				throw new Error("factory boom");
			}),
		).toThrow("factory boom");
		expect(mode.editor).toBe(liveEditor);

		const renderSpy = vi.spyOn(mode.ui, "requestComponentRender");
		try {
			setMotionEffects(false);
			expect(renderSpy.mock.calls.some(([component]) => component === liveEditor)).toBe(true);
		} finally {
			setMotionEffects(true);
		}
	});
});
