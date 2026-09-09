import { afterEach, beforeAll, beforeEach, describe, expect, it, type Mock, vi } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { SelectorController } from "@oh-my-pi/pi-coding-agent/modes/controllers/selector-controller";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import type { SessionTreeNode } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { setKittyProtocolActive } from "@oh-my-pi/pi-tui/keys";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "./helpers/settings-test-state";

const SHIFT_ENTER = "\x1b[13;2u";

let settingsState: SettingsTestState | undefined;

beforeAll(() => {
	initTheme();
});

beforeEach(async () => {
	settingsState = beginSettingsTest();
	await Settings.init({ inMemory: true });
	setKittyProtocolActive(true);
});

afterEach(() => {
	setKittyProtocolActive(false);
	restoreSettingsTestState(settingsState);
	settingsState = undefined;
});

function userNode(id: string, parentId: string | null, text: string): SessionTreeNode {
	const message: AgentMessage = { role: "user", content: text, timestamp: 1 };
	return {
		entry: {
			type: "message",
			id,
			parentId,
			timestamp: "2026-01-01T00:00:00Z",
			message,
		},
		children: [],
	};
}

type NavigateTree = (
	entryId: string,
	options: { summarize: boolean; customInstructions: string | undefined; allowAskReopen: boolean },
) => Promise<{ cancelled: boolean }>;
type ShowHookSelector = (title: string, options: string[]) => Promise<string | undefined>;

interface TreeSummaryHarness {
	controller: SelectorController;
	navigateTree: Mock<NavigateTree>;
	navigation: Promise<void>;
	selector(): { handleInput(key: string): void };
	showHookSelector: Mock<ShowHookSelector>;
}

function createHarness(summaryChoice = "No summary"): TreeSummaryHarness {
	const navigation = Promise.withResolvers<void>();
	const root = userNode("root", null, "Root prompt");
	const showHookSelector = vi.fn<ShowHookSelector>(async () => summaryChoice);
	const navigateTree = vi.fn<NavigateTree>(async () => {
		navigation.resolve();
		return { cancelled: false };
	});
	let selector: { handleInput(key: string): void } | undefined;
	const ctx = {
		sessionManager: {
			getTree: () => [root],
			getLeafId: () => null,
			appendLabelChange: vi.fn(),
		},
		ui: {
			terminal: { rows: 40 },
			setFocus: vi.fn(),
			requestRender: vi.fn(),
			requestComponentRender: vi.fn(),
		},
		editorContainer: {
			clear: vi.fn(),
			addChild: vi.fn(),
		},
		editor: {
			getText: () => "",
			setText: vi.fn(),
			onEscape: undefined,
		},
		showStatus: vi.fn(),
		showError: vi.fn(),
		showHookSelector,
		showHookEditor: vi.fn(),
		chatContainer: { addChild: vi.fn() },
		statusContainer: {
			addChild: vi.fn(),
			disposeChildren: vi.fn(),
		},
		renderInitialMessages: vi.fn(),
		reloadTodos: vi.fn(async () => {}),
		session: {
			navigateTree,
			abortBranchSummary: vi.fn(),
		},
	} as unknown as InteractiveModeContext;
	const controller = new SelectorController(ctx);
	controller.showSelector = create => {
		const result = create(() => {});
		selector = result.component as { handleInput(key: string): void };
	};
	return {
		controller,
		navigateTree,
		navigation: navigation.promise,
		selector: () => {
			if (!selector) throw new Error("Expected tree selector to be shown");
			return selector;
		},
		showHookSelector,
	};
}

describe("SelectorController tree branch summaries", () => {
	it("switches without a summary or prompt on plain enter by default", async () => {
		const harness = createHarness();

		harness.controller.showTreeSelector();
		harness.selector().handleInput("\r");
		await harness.navigation;

		expect(harness.showHookSelector).not.toHaveBeenCalled();
		expect(harness.navigateTree).toHaveBeenCalledWith("root", {
			summarize: false,
			customInstructions: undefined,
			allowAskReopen: true,
		});
	});

	it("summarizes and switches on shift+enter without showing the prompt", async () => {
		const harness = createHarness();

		harness.controller.showTreeSelector();
		harness.selector().handleInput(SHIFT_ENTER);
		await harness.navigation;

		expect(harness.showHookSelector).not.toHaveBeenCalled();
		expect(harness.navigateTree).toHaveBeenCalledWith("root", {
			summarize: true,
			customInstructions: undefined,
			allowAskReopen: true,
		});
	});

	it("skips the summary prompt on shift+enter even when branchSummary.enabled is on", async () => {
		Settings.instance.set("branchSummary.enabled", true);
		const harness = createHarness();

		harness.controller.showTreeSelector();
		harness.selector().handleInput(SHIFT_ENTER);
		await harness.navigation;

		expect(harness.showHookSelector).not.toHaveBeenCalled();
		expect(harness.navigateTree).toHaveBeenCalledWith("root", {
			summarize: true,
			customInstructions: undefined,
			allowAskReopen: true,
		});
	});

	it("still offers the summary prompt on plain enter when branchSummary.enabled is on", async () => {
		Settings.instance.set("branchSummary.enabled", true);
		const harness = createHarness("Summarize");

		harness.controller.showTreeSelector();
		harness.selector().handleInput("\r");
		await harness.navigation;

		expect(harness.showHookSelector).toHaveBeenCalledWith("Summarize branch?", [
			"No summary",
			"Summarize",
			"Summarize with custom prompt",
		]);
		expect(harness.navigateTree).toHaveBeenCalledWith("root", {
			summarize: true,
			customInstructions: undefined,
			allowAskReopen: true,
		});
	});
});
