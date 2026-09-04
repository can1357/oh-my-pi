import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { KeybindingsManager } from "@oh-my-pi/pi-coding-agent/config/keybindings";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { CopySelectorComponent } from "@oh-my-pi/pi-coding-agent/modes/components/copy-selector";
import { SelectorController } from "@oh-my-pi/pi-coding-agent/modes/controllers/selector-controller";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import type { SessionMessageEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { setKeybindings } from "@oh-my-pi/pi-tui";

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
const RIGHT = "\x1b[C";
const DOWN = "\x1b[B";
const ENTER = "\r";

describe("SelectorController.showCopySelector overlay lifecycle", () => {
	it("keeps the overlay mounted across sequential Enter copies until explicit exit", () => {
		const hide = vi.fn();
		let mountedSelector: CopySelectorComponent | undefined;
		const showStatus = vi.fn();
		const requestRender = vi.fn();

		const entries: SessionMessageEntry[] = [
			{
				type: "message",
				id: "m1",
				parentId: null,
				timestamp: "2024-01-01T00:00:00Z",
				message: {
					role: "assistant",
					content: [
						{
							type: "text",
							text: "Code sample:\n```ts\nconst a = 1;\n```\nand command:\n```bash\nmake build\n```",
						},
					],
					usage: {
						input: 10,
						output: 5,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 15,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
				} as unknown as AgentMessage,
			},
		];

		const editor = { id: "editor" };
		const setFocus = vi.fn();
		const ctx = {
			editor,
			editorContainer: { children: [editor], clear: vi.fn(), addChild: vi.fn() },
			sessionManager: {
				getBranch: () => entries,
				getCwd: () => "/tmp",
			},
			session: {
				getToolByName: vi.fn(),
				hasBuiltInTool: vi.fn(),
				extensionRunner: undefined,
			},
			viewSession: {},
			effectiveHideThinkingBlock: false,
			proseOnlyThinking: false,
			showStatus,
			ui: {
				showOverlay: vi.fn(component => {
					mountedSelector = component as CopySelectorComponent;
					return { hide, setHidden: vi.fn(), isHidden: () => false };
				}),
				setFocus,
				requestRender,
			},
		} as unknown as InteractiveModeContext;

		const controller = new SelectorController(ctx);
		controller.showCopySelector();

		expect(ctx.ui.showOverlay).toHaveBeenCalledTimes(1);
		expect(mountedSelector).toBeDefined();

		const disposeSpy = vi.spyOn(mountedSelector!, "dispose");

		// Descend into blocks
		mountedSelector!.handleInput(RIGHT);

		// Copy first block
		mountedSelector!.handleInput(ENTER);
		expect(hide).not.toHaveBeenCalled();
		expect(disposeSpy).not.toHaveBeenCalled();

		// Navigate to second block and copy
		mountedSelector!.handleInput(DOWN);
		mountedSelector!.handleInput(ENTER);
		expect(hide).not.toHaveBeenCalled();
		expect(disposeSpy).not.toHaveBeenCalled();

		// Explicit exit via q
		mountedSelector!.handleInput("q");
		expect(hide).toHaveBeenCalledTimes(1);
		expect(disposeSpy).toHaveBeenCalledTimes(1);
		expect(showStatus).toHaveBeenCalledWith("Copied bash code to clipboard");
	});
});
