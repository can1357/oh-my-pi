import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { KeybindingsManager } from "@oh-my-pi/pi-coding-agent/config/keybindings";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { CopySelectorComponent } from "@oh-my-pi/pi-coding-agent/modes/components/copy-selector";
import { SelectorController } from "@oh-my-pi/pi-coding-agent/modes/controllers/selector-controller";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import type { SessionMessageEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import * as clipboard from "@oh-my-pi/pi-coding-agent/utils/clipboard";
import { setKeybindings } from "@oh-my-pi/pi-tui";

const CODE = "const answer = 42;\nconsole.log(answer);";
const LINK = "https://github.com/can1357/oh-my-pi/pull/10503";
const ASSISTANT_TEXT = `Here is the fix:\n\`\`\`ts\n${CODE}\n\`\`\`\nDone. See [the PR](${LINK}).`;

function entry(id: string, parentId: string | null, message: AgentMessage): SessionMessageEntry {
	return { type: "message", id, parentId, timestamp: "2024-01-01T00:00:00Z", message };
}

function makeEntries(): SessionMessageEntry[] {
	return [
		entry("u1", null, { role: "user", content: "fix the logging", timestamp: 1 } as AgentMessage),
		entry("a1", "u1", {
			role: "assistant",
			content: [
				{ type: "text", text: ASSISTANT_TEXT },
				{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "bun test" } },
			],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			stopReason: "stop",
			usage: {
				input: 10,
				output: 5,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 15,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: 2,
		} as unknown as AgentMessage),
		entry("t1", "a1", {
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "bash",
			content: [{ type: "text", text: "12 pass" }],
			isError: false,
			timestamp: 3,
		} as unknown as AgentMessage),
	];
}

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
	it("keeps the overlay mounted across sequential Enter copies until explicit exit", async () => {
		const copyDone = Promise.withResolvers<void>();
		let callCount = 0;
		const copySpy = vi.spyOn(clipboard, "copyToClipboard").mockImplementation(async () => {
			callCount++;
			if (callCount === 2) copyDone.resolve();
		});
		const hide = vi.fn();
		let mountedSelector: CopySelectorComponent | undefined;
		const showStatus = vi.fn();
		const requestRender = vi.fn();

		const editor = { id: "editor" };
		const setFocus = vi.fn();
		const ctx = {
			editor,
			editorContainer: { children: [editor], clear: vi.fn(), addChild: vi.fn() },
			sessionManager: {
				getBranch: () => makeEntries(),
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
		mountedSelector!.render(100);

		// Descend into blocks
		mountedSelector!.handleInput(RIGHT);
		mountedSelector!.render(100);

		// Copy first block (code)
		mountedSelector!.handleInput(ENTER);
		expect(hide).not.toHaveBeenCalled();
		expect(disposeSpy).not.toHaveBeenCalled();

		// Navigate to third block (bash command) and copy
		mountedSelector!.handleInput(DOWN);
		mountedSelector!.handleInput(DOWN);
		mountedSelector!.handleInput(ENTER);
		expect(hide).not.toHaveBeenCalled();
		expect(disposeSpy).not.toHaveBeenCalled();

		// Explicit exit via q
		mountedSelector!.handleInput("q");
		expect(hide).toHaveBeenCalledTimes(1);
		expect(disposeSpy).toHaveBeenCalledTimes(1);
		expect(showStatus).toHaveBeenCalledWith("Copied bash command to clipboard");
		await copyDone.promise;
		expect(copySpy).toHaveBeenCalledTimes(2);
		expect(copySpy).toHaveBeenNthCalledWith(1, CODE);
		expect(copySpy).toHaveBeenNthCalledWith(2, "bun test");
	});

	it("serializes clipboard writes across selector reopenings", async () => {
		const order: string[] = [];
		const firstCallStarted = Promise.withResolvers<void>();
		const releaseFirstCall = Promise.withResolvers<void>();
		const secondDone = Promise.withResolvers<void>();
		let callCount = 0;
		vi.spyOn(clipboard, "copyToClipboard").mockImplementation(async (text: string) => {
			callCount++;
			if (callCount === 1) {
				firstCallStarted.resolve();
				await releaseFirstCall.promise;
			}
			order.push(text);
			if (callCount === 2) secondDone.resolve();
		});
		let mountedSelector: CopySelectorComponent | undefined;
		const editor = { id: "editor" };
		const ctx = {
			editor,
			editorContainer: { children: [editor], clear: vi.fn(), addChild: vi.fn() },
			sessionManager: {
				getBranch: () => makeEntries(),
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
			showStatus: vi.fn(),
			ui: {
				showOverlay: vi.fn(component => {
					mountedSelector = component as CopySelectorComponent;
					return { hide: vi.fn(), setHidden: vi.fn(), isHidden: () => false };
				}),
				setFocus: vi.fn(),
				requestRender: vi.fn(),
			},
		} as unknown as InteractiveModeContext;

		const controller = new SelectorController(ctx);

		// First opening: copy first block and exit
		controller.showCopySelector();
		mountedSelector!.render(100);
		mountedSelector!.handleInput(RIGHT);
		mountedSelector!.render(100);
		mountedSelector!.handleInput(ENTER);
		mountedSelector!.handleInput("q");

		// Wait for first call to start and hold it open
		await firstCallStarted.promise;

		// Second opening: copy third block and exit
		controller.showCopySelector();
		mountedSelector!.render(100);
		mountedSelector!.handleInput(RIGHT);
		mountedSelector!.render(100);
		mountedSelector!.handleInput(DOWN);
		mountedSelector!.handleInput(DOWN);
		mountedSelector!.handleInput(ENTER);
		mountedSelector!.handleInput("q");

		// Verify second call has not completed because first call is still held open
		expect(order).toEqual([]);

		// Release first call
		releaseFirstCall.resolve();

		await secondDone.promise;
		expect(order).toEqual([CODE, "bun test"]);
	});
});
