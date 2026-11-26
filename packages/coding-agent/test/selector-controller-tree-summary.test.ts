import { afterEach, beforeAll, beforeEach, describe, expect, it, type Mock, vi } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { SelectorController } from "@oh-my-pi/pi-coding-agent/modes/controllers/selector-controller";
import { createRoot, type JSXNode, type KeyEvent, type UiNode } from "@oh-my-pi/pi-tui";
import { bubbleKey, pathTo } from "@oh-my-pi/pi-tui/dispatch";
import { initTheme } from "../src/ui/theme/service";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import type { SessionTreeNode } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "./helpers/settings-test-state";

import { cfgBranchSummaryEnabled } from "@oh-my-pi/pi-coding-agent/session/context-settings";

const ENTER: KeyEvent = { id: "enter", kind: "press", raw: "\r" };
const SHIFT_ENTER: KeyEvent = { id: "shift+enter", kind: "press", raw: "\x1b[13;2u" };

let settingsState: SettingsTestState | undefined;

beforeAll(() => {
	initTheme();
});

beforeEach(async () => {
	settingsState = beginSettingsTest();
	await Settings.init({ inMemory: true });
});

afterEach(() => {
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
	/** Press `key` on the shown tree picker (from its `picker` node up, as the terminal routes it). */
	press(key: KeyEvent): void;
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
	let view: UiNode | undefined;
	const ctx = {
		sessionManager: {
			getTree: () => [root],
			getLeafId: () => null,
			appendLabelChange: vi.fn(),
			getSessionName: () => undefined,
		},
		shell: { size: () => ({ columns: 120, rows: 40 }), nextFrame: async () => {} },
		showEditorAreaDialog: vi.fn((factory: () => JSXNode) => {
			view = createRoot(() => factory() as UiNode);
			return { node: view, closed: false, close: vi.fn() };
		}),
		composer: { text: () => "", setText: vi.fn(), setNotice: vi.fn(), addKeyHandler: vi.fn(() => () => {}) },
		showStatus: vi.fn(),
		showError: vi.fn(),
		showHookSelector,
		keybindings: { keysFor: () => ["escape"], matches: () => false },
		showHookEditor: vi.fn(),
		showWorking: vi.fn(),
		clearWorking: vi.fn(() => true),
		maintenanceInterruptKey: () => "escape",
		renderInitialMessages: vi.fn(),
		reloadTodos: vi.fn(async () => {}),
		session: {
			navigateTree,
			abortBranchSummary: vi.fn(),
		},
	} as unknown as InteractiveModeContext;
	const controller = new SelectorController(ctx);
	return {
		controller,
		navigateTree,
		navigation: navigation.promise,
		press: key => {
			if (!view) throw new Error("Expected tree selector to be shown");
			const picker = findPicker(view);
			bubbleKey(pathTo([view], picker), key);
		},
		showHookSelector,
	};
}

function findPicker(node: UiNode): UiNode {
	if (node.kind === "picker") return node;
	for (const child of node.children()) {
		const found = findPicker(child);
		if (found.kind === "picker") return found;
	}
	return node;
}

describe("SelectorController tree branch summaries", () => {
	it("switches without a summary or prompt on plain enter by default", async () => {
		const harness = createHarness();

		await harness.controller.showTreeSelector();
		harness.press(ENTER);
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

		await harness.controller.showTreeSelector();
		harness.press(SHIFT_ENTER);
		await harness.navigation;

		expect(harness.showHookSelector).not.toHaveBeenCalled();
		expect(harness.navigateTree).toHaveBeenCalledWith("root", {
			summarize: true,
			customInstructions: undefined,
			allowAskReopen: true,
		});
	});

	it("skips the summary prompt on shift+enter even when branchSummary.enabled is on", async () => {
		cfgBranchSummaryEnabled.set(Settings.instance, true);
		const harness = createHarness();

		await harness.controller.showTreeSelector();
		harness.press(SHIFT_ENTER);
		await harness.navigation;

		expect(harness.showHookSelector).not.toHaveBeenCalled();
		expect(harness.navigateTree).toHaveBeenCalledWith("root", {
			summarize: true,
			customInstructions: undefined,
			allowAskReopen: true,
		});
	});

	it("still offers the summary prompt on plain enter when branchSummary.enabled is on", async () => {
		cfgBranchSummaryEnabled.set(Settings.instance, true);
		const harness = createHarness("Summarize");

		await harness.controller.showTreeSelector();
		harness.press(ENTER);
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
