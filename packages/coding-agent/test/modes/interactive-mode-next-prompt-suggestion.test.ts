import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { CustomEditor } from "@oh-my-pi/pi-tui/prompt/custom-editor";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { initTheme } from "@oh-my-pi/pi-tui/theme/theme";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { cfgSttEnabled } from "@oh-my-pi/pi-coding-agent/stt/settings";
import { cfgStartupQuiet, cfgNextPromptSuggestionEnabled } from "@oh-my-pi/pi-coding-agent/modes/settings";
import { STTController } from "@oh-my-pi/pi-coding-agent/stt";
import { postmortem } from "@oh-my-pi/pi-utils";

class ReplacementEditor extends CustomEditor {}

type Harness = {
	authStorage: AuthStorage;
	mode: InteractiveMode;
	session: AgentSession;
};

const harnesses: Harness[] = [];

async function createHarness(): Promise<Harness> {
	const authStorage = await AuthStorage.create(":memory:");
	const modelRegistry = new ModelRegistry(authStorage);
	const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected claude-sonnet-4-5 to exist in registry");
	const session = new AgentSession({
		agent: new Agent({
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
		}),
		sessionManager: SessionManager.inMemory(process.cwd()),
		settings: Settings.isolated(),
		modelRegistry,
	});
	const mode = new InteractiveMode(session, "test");
	const harness = { authStorage, mode, session };
	harnesses.push(harness);
	return harness;
}

beforeAll(async () => {
	await initTheme(false);
});

beforeEach(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
});

afterEach(async () => {
	for (const { authStorage, mode, session } of harnesses.splice(0)) {
		mode.stop();
		vi.restoreAllMocks();
		await session.dispose();
		authStorage.close();
	}
	resetSettingsForTest();
});

describe("InteractiveMode next prompt suggestion lifecycle", () => {
	it("clears a visible suggestion when its setting changes outside the settings selector", async () => {
		const { mode } = await createHarness();
		cfgNextPromptSuggestionEnabled.override(mode.settings, true);
		await mode.init({ suppressWelcomeIntro: true });
		mode.editor.setNextPromptSuggestion("Inspect the current result");
		mode.editor.render(120);
		cfgNextPromptSuggestionEnabled.override(mode.settings, false);
		await Promise.resolve();
		expect(mode.editor.acceptNextPromptSuggestion()).toBe(false);
		expect(mode.editor.getText()).toBe("");
	});
	it("invalidates before STT crosses into its async toggle", async () => {
		const { mode } = await createHarness();
		cfgSttEnabled.override(Settings.instance, true);
		const invalidate = vi.spyOn(mode.nextPromptSuggestionController, "invalidate").mockImplementation(() => {});
		const toggle = vi.spyOn(STTController.prototype, "toggle").mockImplementation(async () => {
			expect(invalidate).toHaveBeenCalledTimes(1);
		});

		await mode.handleSTTToggle();

		expect(toggle).toHaveBeenCalledTimes(1);
	});

	it("invalidates before push-to-talk starts recording into the prompt editor", async () => {
		const { mode } = await createHarness();
		cfgSttEnabled.override(Settings.instance, true);
		const invalidate = vi.spyOn(mode.nextPromptSuggestionController, "invalidate").mockImplementation(() => {});
		const start = vi.spyOn(STTController.prototype, "start").mockImplementation(async () => {
			expect(invalidate).toHaveBeenCalledTimes(1);
		});

		mode.dictationSpaceHold(mode.editor).onStart();

		expect(start).toHaveBeenCalledTimes(1);
	});

	it("wires the initial and replacement editor callbacks and invalidates before session or editor swaps", async () => {
		const { mode } = await createHarness();
		cfgStartupQuiet.override(Settings.instance, true);
		await mode.init({ suppressWelcomeIntro: true });
		const invalidate = vi.spyOn(mode.nextPromptSuggestionController, "invalidate").mockImplementation(() => {});
		const initialEditor = mode.editor;

		initialEditor.onChange?.("draft");
		mode.ui.setFocus(null);
		await Promise.resolve();
		expect(invalidate).toHaveBeenCalledTimes(2);
		mode.ui.setFocus(initialEditor);
		invalidate.mockClear();
		vi.spyOn(initialEditor, "isShowingAutocomplete").mockReturnValue(true);
		initialEditor.onAutocompleteUpdate?.();
		expect(invalidate).toHaveBeenCalledTimes(1);

		invalidate.mockClear();
		const clearTransient = vi.spyOn(mode.statusContainer, "disposeChildren");
		mode.clearTransientSessionUi();
		expect(invalidate).toHaveBeenCalledTimes(1);
		expect(invalidate.mock.invocationCallOrder[0]!).toBeLessThan(clearTransient.mock.invocationCallOrder[0]!);

		invalidate.mockClear();
		const clearEditorContainer = vi.spyOn(mode.editorContainer, "clear");
		mode.setEditorComponent((_tui, editorTheme) => new ReplacementEditor(editorTheme));
		await Promise.resolve();
		expect(invalidate).toHaveBeenCalledTimes(2);
		expect(invalidate.mock.invocationCallOrder[0]!).toBeLessThan(clearEditorContainer.mock.invocationCallOrder[0]!);

		const replacementEditor = mode.editor;
		replacementEditor.onChange?.("replacement draft");
		mode.ui.setFocus(null);
		await Promise.resolve();
		expect(invalidate).toHaveBeenCalledTimes(4);
	});

	it("disposes the controller before shutdown awaits and again during stop", async () => {
		const { mode } = await createHarness();
		mode.ui.terminal.drainInput = async () => {};
		vi.spyOn(postmortem, "quit").mockResolvedValue(undefined);
		const dispose = vi.spyOn(mode.nextPromptSuggestionController, "dispose").mockImplementation(() => {});

		const shutdown = mode.shutdown();
		expect(dispose).toHaveBeenCalledTimes(1);
		await shutdown;

		expect(dispose).toHaveBeenCalledTimes(2);
	});
});
