import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { KeybindingsManager } from "@oh-my-pi/pi-coding-agent/config/keybindings";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { SelectorController } from "@oh-my-pi/pi-coding-agent/modes/controllers/selector-controller";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import type { SessionMessageEntry, SessionTreeNode } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { setKeybindings } from "@oh-my-pi/pi-tui";

const ENTER = "\r";

function userEntry(): SessionMessageEntry {
	return {
		type: "message",
		id: "user-1",
		parentId: "parent-1",
		timestamp: "2026-01-01T00:00:00.000Z",
		message: { role: "user", content: "change this prompt", timestamp: 1 } as AgentMessage,
	};
}

function createHarness({ currentLeaf = false, editorText = "" }: { currentLeaf?: boolean; editorText?: string } = {}) {
	const entry = userEntry();
	const branch = vi.fn(async () => ({
		selectedText: "change this prompt",
		selectedImages: [],
		cancelled: false,
	}));
	const navigateTree = vi.fn(async () => ({
		editorText: "change this prompt",
		cancelled: false,
	}));
	const setDraft = vi.fn();
	const navigationFinished = Promise.withResolvers<void>();
	const showStatus = vi.fn((message: string) => {
		if (message === "Branched to new session" || message === "Rewound to selected point") {
			navigationFinished.resolve();
		}
	});
	let selector: { handleInput(data: string): void; dispose(): void } | undefined;
	const tree: SessionTreeNode[] = [{ entry, children: [] }];
	const ctx = {
		sessionManager: {
			getBranch: () => [entry],
			getEntry: (id: string) => (id === entry.id ? entry : undefined),
			getTree: () => tree,
			getCwd: () => "/tmp",
			getLeafId: () => (currentLeaf ? entry.id : "later-entry"),
		},
		session: {
			getToolByName: () => undefined,
			hasBuiltInTool: () => false,
			extensionRunner: undefined,
			branch,
			navigateTree,
		},
		ui: {
			requestRender: vi.fn(),
			setFocus: vi.fn(),
			showOverlay: vi.fn((component: typeof selector) => {
				selector = component;
				return { hide: vi.fn() };
			}),
		},
		editor: { getText: () => editorText, setDraft },
		editorContainer: { children: [] },
		activeDialog: undefined,
		renderInitialMessages: vi.fn(async () => {}),
		reloadTodos: vi.fn(async () => {}),
		truncateTranscriptFromMessage: vi.fn(() => false),
		showStatus,
		showError: vi.fn(),
		effectiveHideThinkingBlock: false,
		proseOnlyThinking: false,
	} as unknown as InteractiveModeContext;
	const controller = new SelectorController(ctx);
	controller.showUserMessageSelector();
	if (!selector) throw new Error("Expected rewind selector overlay");
	return { branch, navigateTree, navigationFinished: navigationFinished.promise, selector, setDraft };
}

describe("SelectorController rewind user-message behavior", () => {
	beforeAll(async () => {
		await initTheme();
	});
	beforeEach(async () => {
		await Settings.init({ inMemory: true, cwd: process.cwd() });
		setKeybindings(KeybindingsManager.inMemory());
	});
	afterEach(() => {
		setKeybindings(KeybindingsManager.inMemory());
		resetSettingsForTest();
		vi.restoreAllMocks();
	});

	it("keeps the existing current-session behavior by default", async () => {
		const harness = createHarness();
		harness.selector.handleInput(ENTER);
		await harness.navigationFinished;

		expect(harness.navigateTree).toHaveBeenCalledWith("user-1", {
			summarize: false,
			allowCurrentLeafUserMessage: true,
		});
		expect(harness.branch).not.toHaveBeenCalled();
	});

	it("creates a child session when configured", async () => {
		Settings.instance.set("rewindUserMessageAction", "new-session");
		const harness = createHarness();
		harness.selector.handleInput(ENTER);
		await harness.navigationFinished;

		expect(harness.branch).toHaveBeenCalledWith("user-1");
		expect(harness.navigateTree).not.toHaveBeenCalled();
	});

	it("replaces an existing editor draft with the selected user prompt", async () => {
		Settings.instance.set("rewindUserMessageAction", "current-session");
		const harness = createHarness({ editorText: "unrelated draft" });
		harness.selector.handleInput(ENTER);
		await harness.navigationFinished;

		expect(harness.navigateTree).toHaveBeenCalledWith("user-1", {
			summarize: false,
			allowCurrentLeafUserMessage: true,
		});
		expect(harness.setDraft).toHaveBeenCalledWith("change this prompt", undefined);
	});

	it("allows a current-session rewind when the user prompt is the current leaf", async () => {
		Settings.instance.set("rewindUserMessageAction", "current-session");
		const harness = createHarness({ currentLeaf: true });
		harness.selector.handleInput(ENTER);
		await harness.navigationFinished;

		expect(harness.navigateTree).toHaveBeenCalledWith("user-1", {
			summarize: false,
			allowCurrentLeafUserMessage: true,
		});
		expect(harness.branch).not.toHaveBeenCalled();
		expect(harness.setDraft).toHaveBeenCalledWith("change this prompt", undefined);
	});
});
