import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { CustomEditor } from "@oh-my-pi/pi-tui/prompt/custom-editor";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import { NextPromptSuggestionController } from "@oh-my-pi/pi-coding-agent/modes/controllers/next-prompt-suggestion-controller";
import { SelectorController } from "@oh-my-pi/pi-coding-agent/modes/controllers/selector-controller";
import { SessionObserverRegistry } from "@oh-my-pi/pi-tui/overlays/session-observer-registry";
import * as theme from "@oh-my-pi/pi-tui/theme/theme";
import { getEditorTheme, initTheme } from "@oh-my-pi/pi-tui/theme/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { SessionInfo } from "@oh-my-pi/pi-coding-agent/session/session-listing";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";

const STALE_GHOST = "Inspect the current result";

interface GhostHarness {
	ctx: InteractiveModeContext;
	editor: CustomEditor;
	nextPromptSuggestionController: NextPromptSuggestionController;
}

const ghostHarnesses: GhostHarness[] = [];

function createGhostHarness(options?: { collabGuest?: boolean }): GhostHarness {
	const editor = new CustomEditor(getEditorTheme());
	editor.setNextPromptSuggestion(STALE_GHOST);
	editor.render(120);
	const editorContainer: {
		children: unknown[];
		clear(): void;
		addChild(child: unknown): void;
	} = {
		children: [editor],
		clear() {
			this.children = [];
		},
		addChild(child: unknown) {
			this.children.push(child);
		},
	};
	const registry = new AgentRegistry();
	const ctx = {
		editor,
		editorContainer,
		ui: {
			getFocused: () => editor,
			requestComponentRender: vi.fn(),
			requestRender: vi.fn(),
			setFocus: vi.fn(),
			showOverlay: vi.fn(() => ({ hide: vi.fn(), setHidden: vi.fn(), isHidden: () => false })),
			terminal: { columns: 120, rows: 24 },
		},
		session: {
			getAvailableThinkingLevels: () => [],
			getAvailableModels: () => [],
			getToolByName: () => undefined,
			extensionRunner: undefined,
		},
		sessionManager: {
			getCwd: () => process.cwd(),
			getSessionDir: () => "/tmp",
			getSessionFile: () => null,
		},
		keybindings: { getKeys: () => [] },
		showStatus: vi.fn(),
		focusAgentSession: async () => {},
		effectiveHideThinkingBlock: false,
		proseOnlyThinking: false,
		collabGuest: options?.collabGuest
			? {
					agentRegistry: registry,
					hubRemote: {
						chat: () => {},
						kill: () => {},
						revive: () => {},
						readTranscript: async () => null,
					},
				}
			: undefined,
	} as unknown as InteractiveModeContext;
	const nextPromptSuggestionController = new NextPromptSuggestionController(ctx, async () => null);
	Object.assign(ctx as unknown as { nextPromptSuggestionController: NextPromptSuggestionController }, {
		nextPromptSuggestionController,
	});
	const harness = { ctx, editor, nextPromptSuggestionController };
	ghostHarnesses.push(harness);
	return harness;
}

function expectStaleGhostRejected(editor: CustomEditor): void {
	expect(editor.acceptNextPromptSuggestion()).toBe(false);
	editor.handleInput("\t");
	expect(editor.getText()).toBe("");
}

beforeAll(async () => {
	await initTheme(false);
});

afterEach(() => {
	for (const harness of ghostHarnesses.splice(0)) harness.nextPromptSuggestionController.dispose();
	vi.restoreAllMocks();
});

describe("next prompt suggestion entrypoint invalidation", () => {
	it("clears a painted stale ghost before handleRetry reaches its first await", async () => {
		const retry = Promise.withResolvers<boolean>();
		const { ctx, editor } = createGhostHarness();
		Object.assign(ctx as unknown as { viewSession: { retry: () => Promise<boolean> } }, {
			viewSession: { retry: () => retry.promise },
		});
		const controller = new InputController(ctx);

		const pendingRetry = controller.handleRetry();

		expectStaleGhostRejected(editor);
		retry.resolve(false);
		await pendingRetry;
	});

	it("clears a painted stale ghost before showSessionSelector awaits the session list", async () => {
		const sessions = Promise.withResolvers<SessionInfo[]>();
		vi.spyOn(SessionManager, "list").mockImplementation(() => sessions.promise);
		const { ctx, editor } = createGhostHarness();
		const controller = new SelectorController(ctx);

		const pendingSelector = controller.showSessionSelector();

		expectStaleGhostRejected(editor);
		sessions.resolve([]);
		await pendingSelector;
	});

	it("clears a painted stale ghost before showDebugSelector awaits its module", async () => {
		const { ctx, editor } = createGhostHarness();
		const controller = new SelectorController(ctx);

		const pendingSelector = controller.showDebugSelector();

		expectStaleGhostRejected(editor);
		await pendingSelector;
	});

	it("clears a painted stale ghost before showSettingsSelector waits for themes", () => {
		const availableThemes = Promise.withResolvers<string[]>();
		vi.spyOn(theme, "getAvailableThemes").mockImplementation(() => availableThemes.promise);
		const { ctx, editor } = createGhostHarness();
		const controller = new SelectorController(ctx);

		controller.showSettingsSelector();

		expectStaleGhostRejected(editor);
	});

	it("clears a painted stale ghost before showAgentHub waits for persisted subagents", async () => {
		const { ctx, editor } = createGhostHarness({ collabGuest: true });
		const controller = new SelectorController(ctx);

		controller.showAgentHub(new SessionObserverRegistry(), { requireContent: true });

		expectStaleGhostRejected(editor);
		await Promise.resolve();
		await Promise.resolve();
	});
});
